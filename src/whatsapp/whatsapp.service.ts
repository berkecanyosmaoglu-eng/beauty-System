import { Injectable, Logger } from '@nestjs/common';
import { ChatAgentService } from '../agent/chat-agent.service';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

type Incoming = {
  tenantId: string;
  from: string;
  to: string;
  text: string;
  raw: any;
  contentType: string;
};

type MetaSendResult = {
  ok: boolean;
  status: number;
  data: any;
  messageId?: string;
  rawText?: string;
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  private readonly NOTIF_TYPE: 'WHATSAPP' = 'WHATSAPP';

  constructor(
    private readonly agent: ChatAgentService,
    private readonly prisma: PrismaService,
  ) {}

  // -------------------------
  // helpers
  // -------------------------
  private normalizeWa(v: any): string {
    const s = String(v || '').trim();
    return s.replace(/^whatsapp:/i, '').trim();
  }

  /** "whatsapp:+9053..." -> "+9053..." , "9053.." -> "+9053.." , "0532.." -> "+90532.." */
  private toE164Plus(phoneRaw: string): string {
    const p0 = String(phoneRaw || '')
      .trim()
      .replace(/^whatsapp:/i, '')
      .trim();
    if (!p0) return '';

    // keep only digits and plus
    let p = p0.replace(/\s+/g, '');

    // if starts with '+', keep
    if (p.startsWith('+')) {
      // remove non-digit except leading +
      p = '+' + p.slice(1).replace(/[^\d]/g, '');
      return p;
    }

    // remove non-digit
    p = p.replace(/[^\d]/g, '');

    // TR normalization
    if (p.startsWith('00')) p = p.slice(2); // 00xx...
    if (p.startsWith('90')) return `+${p}`;
    if (p.startsWith('0')) return `+90${p.slice(1)}`;
    if (p.startsWith('5')) return `+90${p}`; // 532...
    return `+${p}`; // fallback
  }

  /** Meta 'to' expects digits without '+' typically. We'll send digits. */
  private toMetaDigits(phoneRaw: string): string {
    const e164 = this.toE164Plus(phoneRaw);
    return e164.replace(/^\+/, '');
  }

  private replyTextOnly(replyText: string) {
    return String(replyText || '').trim() || 'Tamamdır.';
  }

  private shouldIgnoreInbound(raw: any, text: string): boolean {
    const msgType = String(raw?.msg?.type || '')
      .trim()
      .toLowerCase();
    if (msgType === 'reaction') return true;
    if (!text) return true;
    const clean = String(text || '').trim();
    if (!clean) return true;
    if (/^[\?!.\-_,\s]+$/.test(clean)) return true;
    return false;
  }

  // -------------------------
  // META CLOUD API
  // -------------------------
  private getMetaConfig() {
    const phoneNumberId = String(
      process.env.META_WA_PHONE_NUMBER_ID || '',
    ).trim();
    const token = String(process.env.META_WA_TOKEN || '').trim();
    const version = String(process.env.META_WA_VERSION || 'v25.0').trim();

    if (!phoneNumberId || !token) return null;
    return { phoneNumberId, token, version };
  }

  private metaEnabled(): boolean {
    return !!this.getMetaConfig();
  }

  private async metaSendText(params: {
    tenantId: string;
    toPhone: string; // "9053..." veya "+9053..." veya "whatsapp:+9053..."
    body: string;
    metadata?: any;
  }): Promise<MetaSendResult> {
    const cfg = this.getMetaConfig();
    if (!cfg)
      throw new Error('META_WA_PHONE_NUMBER_ID / META_WA_TOKEN missing');

    const tenantId = String(params.tenantId || '').trim();
    const toRaw = String(params.toPhone || '').trim();
    const body = String(params.body || '').trim();
    if (!tenantId) throw new Error('tenantId empty');
    if (!toRaw) throw new Error('toPhone empty');
    if (!body) throw new Error('body empty');

    const toDigits = this.toMetaDigits(toRaw);
    if (!toDigits) throw new Error('toPhone invalid');

    const url = `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to: toDigits,
      type: 'text',
      text: { body },
    };

    // log (DB)
    void this.waLogSafe({
      tenantId,
      direction: 'outbound',
      from: 'META',
      to: `+${toDigits}`,
      text: body,
      tag: 'META_OUT_SEND',
      extra: { url, payload, ...(params.metadata || {}) },
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const rawText = await resp.text();
    let data: any = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = { _raw: rawText };
    }

    const messageId =
      data?.messages?.[0]?.id || data?.message_id || data?.id || undefined;

    // 🔥 KRİTİK DEBUG LOG
    this.logger.log(
      `[META send][resp] status=${resp.status} to=+${toDigits} data=${this.safeOneLine(data)}`,
    );

    if (!resp.ok) {
      void this.waLogSafe({
        tenantId,
        direction: 'outbound',
        from: 'META',
        to: `+${toDigits}`,
        text: body,
        tag: 'META_OUT_FAIL',
        extra: { status: resp.status, data },
      });
      return { ok: false, status: resp.status, data, rawText };
    }

    void this.waLogSafe({
      tenantId,
      direction: 'outbound',
      from: 'META',
      to: `+${toDigits}`,
      text: body,
      tag: 'META_OUT_OK',
      extra: { status: resp.status, data, messageId },
    });

    return { ok: true, status: resp.status, data, messageId, rawText };
  }

  private safeOneLine(data: any) {
    try {
      const s = this.safeJson(data);
      return s.length > 1200 ? s.slice(0, 1200) + '…' : s;
    } catch {
      return '[unserializable]';
    }
  }

  // -------------------------
  // TWILIO WHATSAPP
  // -------------------------
  private normalizeToWhatsapp(toPhoneRaw: string) {
    // returns "whatsapp:+E164"
    const e164 = this.toE164Plus(toPhoneRaw);
    if (!e164) return '';
    return `whatsapp:${e164}`;
  }

  private getWhatsappFrom(): string {
    const from =
      process.env.TWILIO_WHATSAPP_FROM ||
      process.env.WHATSAPP_FROM ||
      process.env.TWILIO_FROM_WHATSAPP ||
      '';
    if (!from)
      throw new Error('TWILIO_WHATSAPP_FROM (or WHATSAPP_FROM) missing');
    return this.normalizeToWhatsapp(from);
  }

  private async getTwilioClient() {
    const sid = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
    const token = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;
    if (!sid || !token)
      throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    return twilio(sid, token);
  }

  // -------------------------
  // safe json + recursion guard
  // -------------------------
  private _isWaLogging = false;

  private safeJson(data: any) {
    const seen = new WeakSet();
    return JSON.stringify(
      data,
      (_k, v) => {
        if (v instanceof Error) {
          return { name: v.name, message: v.message, stack: v.stack };
        }
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      },
      2,
    );
  }

  /**
   * WhatsApp event’lerini DB’ye güvenli şekilde logla.
   * Yeni tablo istemiyoruz: mevcut `notifications` tablosuna "LOG" amaçlı yazıyoruz.
   *
   * NOT: notifications modelinde updatedAt yok -> asla yazma.
   */
  private async waLogSafe(params: {
    tenantId: string;
    direction: 'inbound' | 'outbound';
    from: string;
    to: string;
    text?: string;
    raw?: any;
    tag: string;
    appointmentId?: string | null;
    extra?: any;
  }) {
    if (this._isWaLogging) return;
    this._isWaLogging = true;

    try {
      const tenantId = String(params.tenantId || '').trim();
      if (!tenantId) return;

      const now = new Date();
      const body = String(params.text || '')
        .trim()
        .slice(0, 3900);

      const metadata = {
        tag: params.tag,
        direction: params.direction,
        channel: 'whatsapp',
        from: params.from,
        to: params.to,
        appointmentId: params.appointmentId || null,
        raw: params.raw,
        extra: params.extra,
        ts: now.toISOString(),
      };

      await this.prisma.notifications.create({
        data: {
          id: crypto.randomUUID(),
          tenantId,
          type: this.NOTIF_TYPE,
          status: 'sent',
          subject: `LOG:${params.tag}`,
          body,
          recipient: String(params.to || ''),
          metadata: JSON.parse(this.safeJson(metadata)),
          createdAt: now,
        } as any,
      });
    } catch (e: any) {
      this.logger.warn(`[waLogSafe] failed: ${e?.message || e}`);
    } finally {
      this._isWaLogging = false;
    }
  }

  // -------------------------
  // inbound handler
  // -------------------------
  async handleIncoming(input: Incoming): Promise<string> {
    const tenantId = String(input.tenantId || '').trim();
    const from = this.normalizeWa(input.from);
    const to = this.normalizeWa(input.to);
    const text = String(input.text || '').trim();

    if (!tenantId)
      return this.replyTextOnly(
        'Merhaba! (tenant bulunamadı) webhook’a tenantId ekleyelim.',
      );
    if (!from) return '';
    if (this.shouldIgnoreInbound(input.raw, text)) {
      this.logger.log(
        `WA inbound ignored tenantId=${tenantId} from=${from} type=${String(input.raw?.msg?.type || 'unknown')}`,
      );
      return '';
    }

    this.logger.log(
      `📩 WA inbound tenantId=${tenantId} from=${from} to=${to} text="${text.slice(0, 200)}"`,
    );

    void this.waLogSafe({
      tenantId,
      direction: 'inbound',
      from,
      to,
      text,
      raw: input.raw,
      tag: 'WA_IN',
    });

    try {
      const reply = await this.agent.replyText({ tenantId, from, text });

      void this.waLogSafe({
        tenantId,
        direction: 'outbound',
        from: to,
        to: from,
        text: reply,
        tag: 'WA_OUT_REPLY',
      });

      return this.replyTextOnly(reply);
    } catch (e: any) {
      this.logger.error(`Agent replyText failed: ${e?.message || e}`);

      void this.waLogSafe({
        tenantId,
        direction: 'outbound',
        from: to,
        to: from,
        text: 'Şu an bir hata oluştu 😕 Lütfen tekrar dener misin?',
        tag: 'WA_ERR_AGENT',
        extra: { error: String(e?.message || e) },
      });

      return this.replyTextOnly(
        'Şu an bir hata oluştu 😕 Lütfen tekrar dener misin?',
      );
    }
  }

  // -------------------------
  // proactive send (reminders / system)
  // -------------------------
  async sendProactiveWhatsApp(params: {
    tenantId: string;
    toPhone: string;
    body: string;
    appointmentId?: string;
    subject?: string;
    metadata?: any;
  }) {
    const tenantId = String(params.tenantId || '').trim();
    if (!tenantId) throw new Error('tenantId empty');

    const toE164 = this.toE164Plus(params.toPhone);
    if (!toE164) throw new Error('toPhone empty/invalid');

    const body = String(params.body || '').trim();
    if (!body) throw new Error('body empty');

    const subject = String(params.subject || 'WhatsApp');
    const now = new Date();

    // notification row
    const notif = await this.prisma.notifications.create({
      data: {
        id: crypto.randomUUID(),
        tenantId,
        type: this.NOTIF_TYPE,
        recipient: toE164,
        subject,
        body,
        status: 'pending',
        metadata: {
          direction: 'outbound',
          channel: 'whatsapp',
          appointmentId: params.appointmentId || null,
          to: toE164,
          provider: this.metaEnabled() ? 'meta' : 'twilio',
          ...((params.metadata || {}) as any),
        },
        createdAt: now,
      } as any,
      select: { id: true },
    });

    try {
      // ✅ Prefer META if configured (reminders için doğru olan bu)
      if (this.metaEnabled()) {
        const metaRes = await this.metaSendText({
          tenantId,
          toPhone: toE164,
          body,
          metadata: {
            notificationId: notif.id,
            appointmentId: params.appointmentId || null,
            subject,
            ...((params.metadata || {}) as any),
          },
        });

        // messageId yoksa sent sayma!
        if (!metaRes.ok) {
          throw new Error(
            `META send failed: status=${metaRes.status} data=${this.safeOneLine(metaRes.data)}`,
          );
        }
        if (!metaRes.messageId) {
          throw new Error(
            `META send returned ok but missing messageId: data=${this.safeOneLine(metaRes.data)}`,
          );
        }

        await this.prisma.notifications.update({
          where: { id: notif.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            metadata: {
              direction: 'outbound',
              channel: 'whatsapp',
              appointmentId: params.appointmentId || null,
              to: toE164,
              provider: 'meta',
              providerMessageId: metaRes.messageId,
              meta: metaRes.data,
              ...((params.metadata || {}) as any),
            },
          } as any,
        });

        void this.waLogSafe({
          tenantId,
          direction: 'outbound',
          from: 'META',
          to: toE164,
          text: body,
          tag: 'WA_OUT_PROACTIVE',
          appointmentId: params.appointmentId || null,
          extra: { provider: 'meta', providerMessageId: metaRes.messageId },
        });

        return {
          provider: 'meta',
          messageId: metaRes.messageId,
          data: metaRes.data,
        };
      }

      // fallback: Twilio WhatsApp
      const client = await this.getTwilioClient();
      const fromTw = this.getWhatsappFrom();
      const toTw = this.normalizeToWhatsapp(toE164);

      const twilioRes = await client.messages.create({
        from: fromTw,
        to: toTw,
        body,
      });

      await this.prisma.notifications.update({
        where: { id: notif.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          metadata: {
            direction: 'outbound',
            channel: 'whatsapp',
            appointmentId: params.appointmentId || null,
            to: toE164,
            from: fromTw.replace(/^whatsapp:/i, ''),
            provider: 'twilio',
            providerMessageId: String(twilioRes?.sid || ''),
            ...((params.metadata || {}) as any),
          },
        } as any,
      });

      void this.waLogSafe({
        tenantId,
        direction: 'outbound',
        from: fromTw.replace(/^whatsapp:/i, ''),
        to: toE164,
        text: body,
        tag: 'WA_OUT_PROACTIVE',
        appointmentId: params.appointmentId || null,
        extra: {
          provider: 'twilio',
          providerMessageId: String(twilioRes?.sid || ''),
        },
      });

      return twilioRes;
    } catch (e: any) {
      this.logger.error(`sendProactiveWhatsApp failed: ${e?.message || e}`);

      void this.waLogSafe({
        tenantId,
        direction: 'outbound',
        from: this.metaEnabled() ? 'META' : 'TWILIO',
        to: toE164,
        text: body,
        tag: 'WA_ERR_SEND',
        appointmentId: params.appointmentId || null,
        extra: { error: String(e?.message || e) },
      });

      try {
        await this.prisma.notifications.update({
          where: { id: notif.id },
          data: {
            status: 'failed',
            metadata: {
              direction: 'outbound',
              channel: 'whatsapp',
              appointmentId: params.appointmentId || null,
              to: toE164,
              provider: this.metaEnabled() ? 'meta' : 'twilio',
              error: String(e?.message || e),
              ...((params.metadata || {}) as any),
            },
          } as any,
        });
      } catch (e2: any) {
        this.logger.warn(`notifications update failed: ${e2?.message || e2}`);
      }

      throw e;
    }
  }
}
