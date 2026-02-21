import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type Incoming = {
  tenantId: string;
  from: string;
  to: string;
  text: string;
  raw: any;
  contentType: string;
};

type FlowStep =
  | 'START'
  | 'ASK_NAME'
  | 'ASK_SERVICE'
  | 'ASK_STAFF'
  | 'ASK_DATE'
  | 'ASK_TIME'
  | 'CONFIRM';

type FlowState = {
  step: FlowStep;
  name?: string;
  serviceId?: string;
  staffId?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:mm
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(private readonly prisma: PrismaService) {}

  // --- TWILIO RESPONSE ---
  toTwimlMessage(text: string) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${this.escapeXml(text)}</Message>
</Response>`;
  }

  private escapeXml(s: string) {
    return (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // --- TENANT ROUTING (TEMP) ---
  async resolveTenantIdByToNumber(_to: string): Promise<string | null> {
    return null;
  }

  // =========================
  // ✅ DB LOGGING (BotConversation + BotMessage)
  // =========================
  private normalizeFrom(from: string) {
    return String(from || '').replace('whatsapp:', '').trim();
  }

  private async ensureConversation(tenantId: string, fromPhone: string) {
    const externalUserId = fromPhone;

    const existing = await this.prisma.botConversation.findFirst({
      where: { tenantId, channel: 'WHATSAPP', externalUserId },
      select: { id: true },
    });

    if (existing) return existing.id;

    const created = await this.prisma.botConversation.create({
      data: {
        tenantId,
        channel: 'WHATSAPP',
        externalUserId,
        isOpen: true,
      },
      select: { id: true },
    });

    return created.id;
  }

  private async logMessage(args: {
    tenantId: string;
    conversationId: string;
    role: 'USER' | 'BOT' | 'SYSTEM';
    text: string;
    rawJson?: any;
  }) {
    const text = String(args.text || '').trim();
    if (!text) return;

    await this.prisma.botMessage.create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        role: args.role,
        text,
        rawJson: args.rawJson ?? undefined,
      },
    });
  }

  private async replyAndLog(
    tenantId: string,
    conversationId: string,
    replyText: string,
    rawJson?: any,
  ) {
    await this.logMessage({
      tenantId,
      conversationId,
      role: 'BOT',
      text: replyText,
      rawJson,
    });
    return replyText;
  }

  // --- MAIN FLOW ---
  async handleIncoming(input: Incoming): Promise<string> {
    // Basic validation
    if (!input.tenantId) {
      return 'Merhaba! (tenant bulunamadı) Test için webhook’a tenantId gönderelim.';
    }
    if (!input.from || !input.text) {
      return 'Mesajınızı göremedim. Lütfen tekrar yazar mısınız?';
    }

    const tenantId = String(input.tenantId).trim();
    const text = String(input.text || '').trim();
    const lower = text.toLowerCase();
    const phone = this.normalizeFrom(input.from);

    // ✅ Ensure conversation & log incoming USER message
    const conversationId = await this.ensureConversation(tenantId, phone);
    await this.logMessage({
      tenantId,
      conversationId,
      role: 'USER',
      text,
      rawJson: { from: input.from, to: input.to, contentType: input.contentType, raw: input.raw },
    });

    // session: CallSession
    const session = await this.upsertSession(tenantId, phone);
    const state = ((session.data || { step: 'START' }) as FlowState) ?? { step: 'START' };

    // cancel
    if (/(iptal|vazgeç|cancel|boşver)/i.test(lower)) {
      await this.updateSession(session.id, { step: 'START' });
      return this.replyAndLog(
        tenantId,
        conversationId,
        'Tamamdır. İstersen tekrar yaz, randevu için yardımcı olurum.',
      );
    }

    switch (state.step) {
      case 'START': {
        await this.updateSession(session.id, { step: 'ASK_NAME' });
        return this.replyAndLog(tenantId, conversationId, 'Merhaba! Randevu için adınızı yazar mısınız?');
      }

      case 'ASK_NAME': {
        await this.updateSession(session.id, { step: 'ASK_SERVICE', name: text.slice(0, 60) });
        return this.replyAndLog(
          tenantId,
          conversationId,
          'Hangi hizmeti almak istiyorsunuz? (ör: lazer, cilt, tırnak)',
        );
      }

      case 'ASK_SERVICE': {
        const service = await this.prisma.service.findFirst({
          where: { tenantId, name: { contains: text, mode: 'insensitive' } },
          select: { id: true, name: true, duration: true },
        });

        if (!service) {
          return this.replyAndLog(
            tenantId,
            conversationId,
            'Bu hizmeti bulamadım. Daha kısa yazar mısın? (ör: lazer)',
          );
        }

        await this.updateSession(session.id, { step: 'ASK_STAFF', serviceId: service.id });
        return this.replyAndLog(
          tenantId,
          conversationId,
          'Hangi personel/usta olsun? (bilmiyorsan "fark etmez" yaz)',
        );
      }

      case 'ASK_STAFF': {
        // Şimdilik ilk staff (sonra isme göre aratırız)
        const staff = await this.prisma.staff.findFirst({
          where: { tenantId },
          select: { id: true },
        });

        if (!staff) {
          return this.replyAndLog(tenantId, conversationId, 'Personel bulunamadı. Önce staff ekleyelim.');
        }

        await this.updateSession(session.id, { step: 'ASK_DATE', staffId: staff.id });
        return this.replyAndLog(
          tenantId,
          conversationId,
          'Hangi gün istiyorsunuz? (YYYY-AA-GG ör: 2026-02-07) veya "yarın"',
        );
      }

      case 'ASK_DATE': {
        const date = this.parseDateToISO(text);
        if (!date) {
          return this.replyAndLog(
            tenantId,
            conversationId,
            'Tarihi anlayamadım. Örnek: 2026-02-07 ya da "yarın"',
          );
        }

        await this.updateSession(session.id, { step: 'ASK_TIME', date });
        return this.replyAndLog(tenantId, conversationId, 'Saat kaç olsun? (HH:mm ör: 15:30)');
      }

      case 'ASK_TIME': {
        const time = this.parseTime(text);
        if (!time) {
          return this.replyAndLog(tenantId, conversationId, 'Saati anlayamadım. Örnek: 15:30');
        }

        await this.updateSession(session.id, { step: 'CONFIRM', time });

        // ✅ TS18047 fix: s2 null-safe
        const s2 = await this.getSession(session.id);
        const date = String(((s2?.data as any)?.date ?? '')).trim();
        const requestedLabel = `${date} ${time}`.trim();

        return this.replyAndLog(
          tenantId,
          conversationId,
          `Özet: ${requestedLabel} için randevu oluşturalım mı? (evet/hayır)`,
        );
      }

      case 'CONFIRM': {
        if (!/(evet|ok|tamam|onay)/i.test(lower)) {
          await this.updateSession(session.id, { step: 'ASK_TIME' });
          return this.replyAndLog(tenantId, conversationId, 'Tamam. O zaman farklı bir saat yaz (HH:mm).');
        }

        // ✅ TS18047 fix: s3 null-safe
        const s3 = await this.getSession(session.id);
        const st = ((s3?.data ?? {}) as FlowState) || ({} as FlowState);

        if (!st.date || !st.time || !st.serviceId || !st.name) {
          await this.updateSession(session.id, { step: 'START' });
          return this.replyAndLog(
            tenantId,
            conversationId,
            'Bir şey karıştı 🙈 Baştan alalım: adınızı yazar mısınız?',
          );
        }

        try {
          // 1) service duration for endAt
          const service = await this.prisma.service.findUnique({
            where: { id: st.serviceId },
            select: { duration: true, name: true },
          });
          if (!service) {
            await this.updateSession(session.id, { step: 'START' });
            return this.replyAndLog(tenantId, conversationId, 'Hizmet bulunamadı. Baştan alalım.');
          }

          // 2) find or create customer (schema: fullName, phone, tenantId)
          let customer = await this.prisma.customer.findFirst({
            where: { tenantId, phone },
            select: { id: true },
          });

          if (!customer) {
            customer = await this.prisma.customer.create({
              data: {
                tenantId,
                fullName: st.name,
                phone,
                whatsappPhone: phone,
              },
              select: { id: true },
            });
          }

          // 3) appointment
          const startAt = new Date(`${st.date}T${st.time}:00`);
          if (Number.isNaN(startAt.getTime())) {
            await this.updateSession(session.id, { step: 'ASK_DATE' });
            return this.replyAndLog(tenantId, conversationId, 'Tarih/saat formatı hatalı. Tarihi tekrar yazar mısın?');
          }

          const durationMin = Number(service.duration || 30);
          const endAt = new Date(startAt.getTime() + durationMin * 60_000);

          await this.prisma.appointment.create({
            data: {
              tenantId,
              customerId: customer.id,
              serviceId: st.serviceId,
              staffId: st.staffId || null,
              startAt,
              endAt,
              channel: 'WHATSAPP',
              status: 'scheduled',
            } as any,
          });

          await this.updateSession(session.id, { step: 'START' });

          const okMsg = `✅ Randevu oluşturuldu: ${st.date} ${st.time} (${service.name})`;
          return this.replyAndLog(tenantId, conversationId, okMsg);
        } catch (e: any) {
          this.logger.warn(`appointment.create failed: ${e?.message || e}`);
          await this.updateSession(session.id, { step: 'START' });
          return this.replyAndLog(
            tenantId,
            conversationId,
            'Randevu kaydı şu an oluşturulamadı. (Sistemde küçük bir hata var) 1 dk içinde düzeltiyorum.',
            { error: e?.message || String(e) },
          );
        }
      }
    }
  }

  // -------------------------
  // Session persistence (CallSession)
  // -------------------------
  private async upsertSession(tenantId: string, phone: string) {
    const existing = await this.prisma.callSession.findFirst({
      where: { tenantId, phone },
    });

    if (existing) return existing;

    return this.prisma.callSession.create({
      data: {
        tenantId,
        phone,
        step: 'whatsapp',
        data: { step: 'START' } as any,
      } as any,
    });
  }

  private async getSession(id: string) {
    return this.prisma.callSession.findUnique({ where: { id } });
  }

  private async updateSession(id: string, patch: Partial<FlowState>) {
    const s = await this.prisma.callSession.findUnique({ where: { id } });
    const current = (s?.data || { step: 'START' }) as any;
    const next = { ...current, ...patch };

    await this.prisma.callSession.update({
      where: { id },
      data: { data: next as any },
    });
  }

  // -------------------------
  // Parsing
  // -------------------------
  private parseDateToISO(input: string): string | null {
    const s = input.trim().toLowerCase();
    const now = new Date();

    if (s === 'yarın' || s === 'yarin') {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  private parseTime(input: string): string | null {
    const s = input.trim();
    if (/^\d{1,2}:\d{2}$/.test(s)) {
      const [hh, mm] = s.split(':').map(Number);
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      }
    }
    return null;
  }
}
