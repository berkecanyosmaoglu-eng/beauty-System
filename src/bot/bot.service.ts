import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentsService } from '../appointments/appointments.service';

// Note: We no longer import SmsService here because the appointment
// confirmation SMS is now handled inside the AppointmentsService via the
// NotificationsService. The BotService is only responsible for booking
// appointments and logging the booking lifecycle.

// Type definitions remain unchanged
type InputType = 'dtmf' | 'speech' | null;

type AiDecision =
  | { action: 'ASK'; say: string }
  | { action: 'ANSWER'; say: string }
  | {
      action: 'BOOK';
      say: string;
      data: {
        serviceId: string;
        staffId?: string | null;
        dateISO: string; // YYYY-MM-DD
        timeHHmm: string; // HH:MM
        customerName?: string | null;
      };
    };

type SessionData = {
  greeted?: boolean;
  noInputCount?: number;
  serviceId?: string | null;
  staffId?: string | null;
  dateISO?: string | null;
  timeHHmm?: string | null;
  customerName?: string | null;
};

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly appointmentsService: AppointmentsService,
  ) {}

  /**
   * ALWAYS return TwiML (XML).
   */
  async handleVoice(params: {
    tenantId: string;
    callSid: string;
    from: string;
    input: string | null;
    inputType: InputType;
    actionUrl: string;
  }): Promise<string> {
    const { tenantId, callSid, from, actionUrl } = params;

    // 1) Load or create session
    const session = await this.getOrCreateCallSession({ tenantId, callSid, from });
    const sdata: SessionData = (session?.data as any) || {};

    // 2) Initial greeting
    if (!sdata.greeted) {
      sdata.greeted = true;
      sdata.noInputCount = 0;
      await this.updateSessionData(session.id, sdata);
      return this.twimlGather('Merhaba, hoş geldiniz. Hangi işlem için arıyordunuz?', actionUrl);
    }

    const saidRaw = (params.input || '').trim();

    // 3) If no input
    if (!saidRaw) {
      sdata.noInputCount = (sdata.noInputCount ?? 0) + 1;
      await this.updateSessionData(session.id, sdata);

      if (sdata.noInputCount >= 2) {
        return this.twimlGather(
          'Sizi duyamadım. Sadece hangi işlemi istediğinizi söyleyin: örneğin lazer, cilt bakımı, manikür gibi.',
          actionUrl,
        );
      }

      return this.twimlGather('Size nasıl yardımcı olabilirim?', actionUrl);
    }

    // Reset noInputCount on input
    if (sdata.noInputCount) {
      sdata.noInputCount = 0;
      await this.updateSessionData(session.id, sdata);
    }

    // 4) Fetch services and staff from DB
    const servicesRaw = await this.safeFindMany('service', () =>
      (this.prisma as any).service.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      }),
    );

    const staffRaw = await this.safeFindMany('staff', () =>
      (this.prisma as any).staff.findMany({
        where: { tenantId },
        select: { id: true, fullName: true },
      }),
    );

    const services = (servicesRaw as any[]).map((s) => ({ id: s.id, name: s.name }));
    const staff = (staffRaw as any[]).map((p) => ({ id: p.id, name: p.fullName }));

    // 5) Ask AI brain for next action
    const decision = await this.aiBrain({
      said: saidRaw,
      services,
      staff,
      sessionData: sdata,
    });

    // 6) Apply decision
    if (decision.action === 'BOOK') {
      // Write to session (for debugging)
      sdata.serviceId = decision.data.serviceId ?? sdata.serviceId ?? null;
      sdata.staffId = decision.data.staffId ?? sdata.staffId ?? null;
      sdata.dateISO = decision.data.dateISO ?? sdata.dateISO ?? null;
      sdata.timeHHmm = decision.data.timeHHmm ?? sdata.timeHHmm ?? null;
      sdata.customerName = decision.data.customerName ?? sdata.customerName ?? null;
      await this.updateSessionData(session.id, sdata);

      const created = await this.tryCreateAppointment({
        tenantId,
        from,
        serviceId: decision.data.serviceId,
        staffId: decision.data.staffId ?? null,
        dateISO: decision.data.dateISO,
        timeHHmm: decision.data.timeHHmm,
        customerName: decision.data.customerName ?? null,
      });

      if (!created.ok) {
        return this.twimlGather(
          'Kusura bakmayın, randevuyu kaydederken kısa bir sorun yaşadım. Tekrar dener misiniz: hangi gün ve saat uygun?',
          actionUrl,
        );
      }

      const say = (decision.say || '').trim() || 'Tamamdır.';
      return this.twimlGather(`${say} Randevunuzu oluşturdum. Başka bir isteğiniz var mı?`, actionUrl);
    }

    // Default: ASK / ANSWER
    return this.twimlGather(decision.say, actionUrl);
  }

  // --------------------
  // Appointment create (logs and passes fromPhone to AppointmentsService)
  // --------------------
  private async tryCreateAppointment(args: {
    tenantId: string;
    from: string;
    serviceId: string;
    staffId: string | null;
    dateISO: string;
    timeHHmm: string;
    customerName: string | null;
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    try {
      const phone = String(args.from || '').trim();
      if (!phone) return { ok: false, error: 'missing_phone' };

      // Ensure valid datetime in UTC
      const dt = new Date(`${args.dateISO}T${args.timeHHmm}:00.000Z`);
      if (Number.isNaN(dt.getTime())) return { ok: false, error: 'invalid_datetime' };

      const prismaAny = this.prisma as any;

      // Find or create customer by phone
      let customer = await prismaAny.customer.findFirst({
        where: { tenantId: args.tenantId, phone },
        select: { id: true },
      });

      if (!customer?.id) {
        customer = await prismaAny.customer.create({
          data: {
            tenantId: args.tenantId,
            fullName: args.customerName?.trim() || phone,
            phone,
            isActive: true,
          },
          select: { id: true },
        });
      }

      // Log before booking
      this.logger.log(
        `[BOOKING] creating appointment tenantId=${args.tenantId} from=${phone} customerId=${customer.id} serviceId=${args.serviceId} staffId=${args.staffId} startAt=${dt.toISOString()}`,
      );

      const created = await this.appointmentsService.create({
        tenantId: args.tenantId,
        customerId: customer.id,
        serviceId: args.serviceId,
        staffId: args.staffId,
        startAt: dt.toISOString(),
        status: 'scheduled',
        // Pass caller number so AppointmentsService/NotificationsService can choose the correct phone
        fromPhone: args.from,
      } as any);

      // Log after booking
      this.logger.log(
        `[BOOKING] appointment created id=${created.id} from=${phone}`,
      );

      return { ok: true, id: created.id };
    } catch (e: any) {
      this.logger.error(`tryCreateAppointment failed: ${e?.message || e}`);
      return { ok: false, error: 'db_error' };
    }
  }

  // --------------------
  // AI Brain
  // --------------------
  private async aiBrain(args: {
    said: string;
    services: { id: string; name: string }[];
    staff: { id: string; name: string }[];
    sessionData: SessionData;
  }): Promise<AiDecision> {
    const servicesText =
      args.services?.length > 0 ? args.services.map((s) => `${s.id}:${s.name}`).join(' | ') : 'YOK';

    const staffText =
      args.staff?.length > 0 ? args.staff.map((s) => `${s.id}:${s.name}`).join(' | ') : 'YOK';

    const system = `
Sen Türkiye'de çalışan, güler yüzlü bir güzellik merkezi danışmanısın.
Konuşman doğal, akıcı ve kısa olsun.

ÇOK ÖNEMLİ KURALLAR:
- Her cevap 1 veya 2 cümle olsun.
- Asla liste, madde işareti, numara veya markdown kullanma.
- Her seferinde en fazla 1 soru sor.
- Aynı cümleyi iki kez kurma.
- Gereksiz bilgi verme.

AMAÇ:
- Kullanıcının istediği hizmeti anlayıp doğru yönlendirmek.
- Genel soruları cevaplamak.
- Randevu oluşturmak istiyorsa BOOK aksiyonuna gitmek.

SEN BİR KARAR MOTORUSUN.
SADECE JSON döndür.
JSON şeması:
- {"action":"ASK","say":"..."}
- {"action":"ANSWER","say":"..."}
- {"action":"BOOK","say":"...","data":{"serviceId":"...","dateISO":"YYYY-MM-DD","timeHHmm":"HH:MM","staffId":null,"customerName":null}}

BOOK için ZORUNLU alanlar:
- serviceId
- dateISO
- timeHHmm

serviceId ve staffId seçerken sadece aşağıdaki listelerdeki id'leri kullan.

Mevcut hizmetler (id:name): ${servicesText}
Mevcut personel (id:name): ${staffText}

Mevcut session (referans): ${JSON.stringify(args.sessionData || {})}
`.trim();

    try {
      const r = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 220,
        response_format: { type: 'json_object' as any },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: args.said || '' },
        ],
      });

      const raw = r.choices?.[0]?.message?.content?.trim() || '{}';
      const obj = JSON.parse(raw);

      if (!obj?.action || typeof obj.say !== 'string') {
        return {
          action: 'ASK',
          say: 'Kusura bakmayın, tekrar eder misiniz? Hangi işlem için arıyordunuz?',
        };
      }

      obj.say = this.cleanSpeak(obj.say);

      if (obj.action === 'BOOK') {
        const d = obj.data || {};
        if (!d.serviceId || !d.dateISO || !d.timeHHmm) {
          return {
            action: 'ASK',
            say: 'Tabii, randevu oluşturalım. Hangi işlem için randevu almak istiyorsunuz?',
          };
        }
      }

      return obj as AiDecision;
    } catch (e: any) {
      this.logger.warn(`aiBrain failed: ${e?.message || e}`);
      return {
        action: 'ASK',
        say: 'Kusura bakmayın, tekrar eder misiniz? Hangi işlem için arıyordunuz?',
      };
    }
  }

  // --------------------
  // TwiML helpers
  // --------------------
  private twimlGather(prompt: string, actionUrl: string): string {
    const safe = this.cleanSpeak(prompt);
    const safeAction = this.escapeXmlAttr(actionUrl);

    // NOT: Twilio’da “en ufak sesi bile algılıyor” konusu genelde Realtime tarafında.
    // Burada Gather için biraz daha sıkı ayar verdim: speechTimeout=1 ve timeout=5
    return `
<Response>
  <Gather input="speech dtmf"
          action="${safeAction}"
          method="POST"
          language="tr-TR"
          speechTimeout="1"
          timeout="5"
          bargeIn="true">
    <Say voice="alice" language="tr-TR">${safe}</Say>
  </Gather>

  <Redirect method="POST">${safeAction}</Redirect>
</Response>
`.trim();
  }

  private cleanSpeak(text: string): string {
    return this.escapeXml(text || '').replace(/\s+/g, ' ').trim();
  }

  private escapeXml(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private escapeXmlAttr(text: string): string {
    return this.escapeXml(text);
  }

  // --------------------
  // Prisma helpers
  // --------------------
  private async getOrCreateCallSession(args: {
    tenantId: string;
    callSid: string;
    from: string;
  }): Promise<any> {
    const prismaAny = this.prisma as any;

    const existing = await prismaAny.callSession.findFirst({
      where: { tenantId: args.tenantId, callSid: args.callSid },
    });
    if (existing) return existing;

    return prismaAny.callSession.create({
      data: {
        tenantId: args.tenantId,
        callSid: args.callSid,
        from: args.from,
        data: { greeted: false, noInputCount: 0 },
      },
    });
  }

  private async updateSessionData(sessionId: string, data: SessionData): Promise<void> {
    const prismaAny = this.prisma as any;
    await prismaAny.callSession.update({
      where: { id: sessionId },
      data: { data },
    });
  }

  private async safeFindMany<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`safeFindMany(${label}) failed: ${e?.message || e}`);
      return [];
    }
  }
}
