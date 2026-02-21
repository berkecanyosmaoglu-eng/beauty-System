import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';

function escapeXml(s: string) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toTwimlMessage(text: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(text)}</Message>
</Response>`;
}

function normalizeWa(v: any): string {
  const s = String(v || '').trim();
  return s.replace(/^whatsapp:/i, '').trim();
}

@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {}

  /**
   * tenantId resolve:
   * 1) query.tenantId
   * 2) To numarasından tenantId_phone benzeri map tablosu
   */
  private async resolveTenantId(req: Request, to: string): Promise<string | null> {
    const fromQuery = String((req.query as any)?.tenantId || '').trim();
    if (fromQuery) return fromQuery;

    if (!to) return null;

    // senin loglarda "tenantId_phone" mapping vardı.
    // Prisma model ismi tam ne bilmiyoruz -> candidates ile deniyoruz.
    const p: any = this.prisma as any;

    const candidates = [
      'tenantId_phone',
      'tenantIdPhone',
      'tenantPhone',
      'tenant_phone',
      'tenantPhoneMap',
      'tenantId_phoneMap',
    ];

    for (const name of candidates) {
      const model = p?.[name];
      if (!model?.findFirst) continue;

      try {
        const row = await model.findFirst({
          where: { phone: to },
          select: { tenantId: true },
        });

        if (row?.tenantId) return String(row.tenantId);
      } catch {
        // ignore
      }
    }

    return null;
  }

  /**
   * WhatsApp message log (opsiyonel):
   * Prisma'da WhatsAppMessage modeli yoksa PATLAMASIN diye try/catch.
   */
  private async logWhatsAppMessage(params: {
    tenantId: string;
    direction: 'INBOUND' | 'OUTBOUND';
    from?: string | null;
    to?: string | null;
    body?: string | null;
    providerSid?: string | null;
  }) {
    try {
      const p: any = this.prisma as any;
      const model = p?.whatsAppMessage || p?.whatsappMessage || p?.whatSAppMessage;
      if (!model?.create) return;

      await model.create({
        data: {
          tenantId: params.tenantId,
          direction: params.direction,
          from: params.from ?? null,
          to: params.to ?? null,
          body: params.body ?? null,
          provider: 'twilio',
          providerSid: params.providerSid ?? null,
        },
      });
    } catch {
      // ignore
    }
  }

  // Twilio WhatsApp webhook: POST /whatsapp/webhook
  @Post('webhook')
  async webhook(@Req() req: Request, @Res() res: Response) {
    try {
      // Twilio form fields
      const from = normalizeWa((req.body as any)?.From);
      const to = normalizeWa((req.body as any)?.To);
      const bodyText = String((req.body as any)?.Body || '').trim();
      const messageSid = String((req.body as any)?.MessageSid || '').trim() || null;

      // Twilio'ya asla 400 dönmeyelim -> hep 200 + TwiML
      if (!from || !bodyText) {
        return res.status(200).type('text/xml').send(toTwimlMessage('Mesajı göremedim. Tekrar yazar mısınız?'));
      }

      const tenantId = await this.resolveTenantId(req, to);

      if (!tenantId) {
        this.logger.warn(`tenantId bulunamadı. to=${to} from=${from}`);
        return res
          .status(200)
          .type('text/xml')
          .send(toTwimlMessage('Bu numara için işletme tanımı bulunamadı. Lütfen işletme sahibine ulaşın.'));
      }

      this.logger.log(`📩 WhatsApp tenantId=${tenantId} from=${from} to=${to}: ${bodyText}`);

      // ✅ INBOUND log (model varsa)
      await this.logWhatsAppMessage({
        tenantId,
        direction: 'INBOUND',
        from,
        to,
        body: bodyText,
        providerSid: messageSid,
      });

      // 1) Conversation bul/oluştur
      const conversation =
        (await this.prisma.botConversation.findFirst({
          where: {
            tenantId,
            channel: 'WHATSAPP',
            externalUserId: from,
            isOpen: true,
          },
          select: { id: true },
        })) ||
        (await this.prisma.botConversation.create({
          data: {
            tenantId,
            channel: 'WHATSAPP',
            externalUserId: from,
            isOpen: true,
            state: null,
            contextJson: {},
          },
          select: { id: true },
        }));

      const conversationId = conversation.id;

      // 2) USER mesajını DB’ye yaz
      await this.prisma.botMessage.create({
        data: {
          tenantId,
          conversationId,
          role: 'USER',
          text: bodyText,
          rawJson: {
            provider: 'twilio',
            from,
            to,
            body: req.body,
          } as any,
        },
      });

      // 3) Agent cevabı
      const reply = await this.agent.replyText({
        tenantId,
        from,
        text: bodyText,
      });

      const replyText = String(reply || '').trim() || 'Size nasıl yardımcı olabilirim?';

      // 4) BOT mesajını DB’ye yaz
      await this.prisma.botMessage.create({
        data: {
          tenantId,
          conversationId,
          role: 'BOT',
          text: replyText,
          rawJson: { provider: 'agent' } as any,
        },
      });

      // ✅ OUTBOUND log (model varsa)
      await this.logWhatsAppMessage({
        tenantId,
        direction: 'OUTBOUND',
        from: to, // işletme numarası gibi düşünebilirsin
        to: from, // müşteri
        body: replyText,
        providerSid: null,
      });

      // 5) TwiML dön
      return res.status(200).type('text/xml').send(toTwimlMessage(replyText));
    } catch (e: any) {
      this.logger.error(`webhook error: ${e?.message || e}`);
      return res.status(200).type('text/xml').send(toTwimlMessage('Bir hata oldu. Tekrar dener misiniz?'));
    }
  }
}
