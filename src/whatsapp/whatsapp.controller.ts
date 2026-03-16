import { Controller, Post, Get, Req, Res, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';

function normalizeWa(v: any): string {
  const s = String(v || '').trim();
  return s.replace(/^whatsapp:/i, '').trim();
}

@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
  ) {}

  private async resolveTenantId(req: Request): Promise<string | null> {
    const fromQuery = String((req.query as any)?.tenantId || '').trim();
    if (fromQuery) return fromQuery;

    const fromEnv = String(process.env.DEFAULT_TENANT_ID || '').trim();
    if (fromEnv) return fromEnv;

    try {
      const count = await this.prisma.tenants.count();
      if (count === 1) {
        const t = await this.prisma.tenants.findFirst({ select: { id: true } });
        return t?.id ? String(t.id) : null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  @Get('webhook')
  async verify(@Req() req: Request, @Res() res: Response) {
    const mode = String((req.query as any)?.['hub.mode'] || '');
    const token = String((req.query as any)?.['hub.verify_token'] || '');
    const challenge = String((req.query as any)?.['hub.challenge'] || '');
    const expected = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();

    if (mode === 'subscribe' && expected && token === expected) {
      return res.status(200).send(challenge);
    }

    this.logger.warn(`WA webhook verify failed. mode=${mode} token=${token}`);
    return res.sendStatus(403);
  }

  private isMetaPayload(body: any): boolean {
    return !!body && (body.object === 'whatsapp_business_account' || Array.isArray(body.entry));
  }

  private async sendMetaText(toWaIdOrMsisdn: string, text: string, phoneNumberId?: string) {
    const token = String(process.env.META_WA_TOKEN || '').trim();
    const version = String(process.env.META_WA_VERSION || 'v25.0').trim();
    const pni = String(phoneNumberId || process.env.META_WA_PHONE_NUMBER_ID || '').trim();

    if (!token || !pni) {
      this.logger.error(
        `META send failed: missing META_WA_TOKEN or META_WA_PHONE_NUMBER_ID. pni=${pni} tokenLen=${token?.length || 0}`,
      );
      return;
    }

    const url = `https://graph.facebook.com/${version}/${pni}/messages`;

    // Node 20'de fetch var
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(toWaIdOrMsisdn),
        type: 'text',
        text: { body: String(text || '').slice(0, 4000) },
      }),
    });

    const raw = await resp.text();
    if (!resp.ok) {
      this.logger.error(`META send failed status=${resp.status} body=${raw}`);
    } else {
      this.logger.log(`✅ META sent to=${toWaIdOrMsisdn} status=${resp.status}`);
    }
  }

  @Post('webhook')
  async webhook(@Req() req: Request, @Res() res: Response) {
    const body: any = req.body;

    // META webhook: sadece 200 dön, işi içeride hallet
    if (this.isMetaPayload(body)) {
      try {
        const tenantId = await this.resolveTenantId(req);
        if (!tenantId) {
          this.logger.warn(`META webhook: tenantId bulunamadı`);
          return res.sendStatus(200);
        }

        const entries = Array.isArray(body.entry) ? body.entry : [];
        for (const entry of entries) {
          const changes = entry?.changes || [];
          for (const ch of changes) {
            const value = ch?.value || {};
            const messages = value?.messages || [];
            const contacts = value?.contacts || [];
            const metadata = value?.metadata || {};
            const phoneNumberId = metadata?.phone_number_id;

            for (const msg of messages) {
              const fromWaId = String(msg?.from || '').trim(); // wa_id (digits)
              const msgType = String(msg?.type || '').trim();

              let text = '';
              if (msgType === 'text') text = String(msg?.text?.body || '').trim();
              else if (msgType === 'button') text = String(msg?.button?.text || '').trim();
              else if (msgType === 'interactive') {
                // list / reply
                text =
                  String(msg?.interactive?.button_reply?.title || '').trim() ||
                  String(msg?.interactive?.list_reply?.title || '').trim();
              }

              const contactName =
                String(contacts?.[0]?.profile?.name || '').trim() ||
                String(value?.contacts?.[0]?.profile?.name || '').trim();

              if (!fromWaId) continue;

              this.logger.log(`📩 META inbound tenantId=${tenantId} from=${fromWaId} type=${msgType} text="${text}"`);

              // boş mesaj gelirse bile handle edelim (AI belki "?" döner)
              const replyText = await this.wa.handleIncoming({
                tenantId,
                from: `whatsapp:+${fromWaId}`,
                to: `whatsapp:${process.env.META_WA_PHONE_NUMBER_ID || phoneNumberId || ''}`,
                text: text || '',
                contentType: String(req.headers['content-type'] || ''),
                raw: {
                  provider: 'meta',
                  msg,
                  valueMeta: { phoneNumberId, contactName },
                },
              });

              const safeReply = String(replyText || '').trim() || 'Size nasıl yardımcı olabilirim?';
              await this.sendMetaText(fromWaId, safeReply, phoneNumberId);
            }
          }
        }

        return res.sendStatus(200);
      } catch (e: any) {
        this.logger.error(`META webhook error: ${e?.message || e}`);
        return res.sendStatus(200);
      }
    }

    // --- Twilio webhook (eski) hala dursun ---
    try {
      const from = normalizeWa((req.body as any)?.From);
      const to = normalizeWa((req.body as any)?.To);
      const bodyText = String((req.body as any)?.Body || '').trim();
      const contentType = String(req.headers['content-type'] || '');

      if (!from || !bodyText) {
        return res.status(200).send('OK');
      }

      const tenantId = await this.resolveTenantId(req);
      if (!tenantId) {
        this.logger.warn(`Twilio WA: tenantId bulunamadı. to=${to} from=${from}`);
        return res.status(200).send('OK');
      }

      this.logger.log(`📩 Twilio inbound tenantId=${tenantId} from=${from} to=${to}: ${bodyText}`);

      const replyText = await this.wa.handleIncoming({
        tenantId,
        from: `whatsapp:${from}`,
        to: `whatsapp:${to}`,
        text: bodyText,
        contentType,
        raw: { provider: 'twilio', body: req.body },
      });

      // Twilio burada TwiML beklerdi, ama artık Meta’ya geçiyoruz; Twilio kullanmıyorsan önemli değil
      return res.status(200).send(String(replyText || 'OK'));
    } catch (e: any) {
      this.logger.error(`Twilio webhook error: ${e?.message || e}`);
      return res.status(200).send('OK');
    }
  }
}
