import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppService } from './whatsapp.service';

@Controller('webhooks/whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Twilio WhatsApp webhook
   * POST /webhooks/whatsapp/twilio  (application/x-www-form-urlencoded)
   */
  @Post('twilio')
  async twilio(@Req() req: any, @Body() body: any, @Headers() headers: any) {
    const contentType = String(headers?.['content-type'] || '').toLowerCase();

    // Twilio fields (WA)
    const fromRaw = body?.From || body?.from || '';
    const toRaw = body?.To || body?.to || '';
    const textRaw = body?.Body || body?.text || body?.message?.text || '';

    const from = String(fromRaw).trim(); // e.g. "whatsapp:+90..."
    const to = String(toRaw).trim();
    const text = String(textRaw).trim();

    // Tenant routing:
    // 1) explicit tenantId param/body/header
    // 2) fallback: resolve by "to" number (if implemented)
    const tenantId =
      String(body?.tenantId || headers?.['x-tenant-id'] || '').trim() ||
      (to ? await this.whatsapp.resolveTenantIdByToNumber(to) : null) ||
      '';

    // 1) Produce reply (your current WhatsAppService already calls AgentService + provider.sendText)
    const reply = await this.whatsapp.handleIncoming({
      tenantId,
      from,
      to,
      text,
      raw: body,
      contentType,
    });

    // 2) Persist to DB for admin metrics (BotConversation + BotMessage)
    // We store BOTH user + bot messages so whatsappCount increases.
    try {
      if (tenantId && from) {
        const externalUserId = from.replace('whatsapp:', '').trim() || from;

        const conv =
          (await this.prisma.botConversation.findFirst({
            where: {
              tenantId,
              channel: 'WHATSAPP',
              externalUserId,
              isOpen: true,
            },
            select: { id: true },
          })) ||
          (await this.prisma.botConversation.create({
            data: {
              tenantId,
              channel: 'WHATSAPP',
              externalUserId,
              isOpen: true,
              state: null,
              contextJson: {},
            },
            select: { id: true },
          }));

        const conversationId = conv.id;

        // USER message
        if (text) {
          await this.prisma.botMessage.create({
            data: {
              tenantId,
              conversationId,
              role: 'USER',
              text,
              rawJson: body,
            },
          });
        }

        // BOT message
        if (reply) {
          await this.prisma.botMessage.create({
            data: {
              tenantId,
              conversationId,
              role: 'BOT',
              text: String(reply),
              rawJson: null,
            },
          });
        }
      }
    } catch (e) {
      // DB write fail must not break WA reply
      // (keep silent or add logger if you want)
    }

    // Twilio expects TwiML
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return this.whatsapp.toTwimlMessage(reply);
    }

    return { ok: true, reply };
  }
}
