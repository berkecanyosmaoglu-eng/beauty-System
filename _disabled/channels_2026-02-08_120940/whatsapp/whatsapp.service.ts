import { Injectable, Logger } from '@nestjs/common';
import { TwilioWhatsAppProvider } from './providers/twilio.provider';
import { AgentService } from '../../agent/agent.service';

function withTimeout<T>(p: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  // şimdilik sabit tenant (senin tenantId) — sonra From numarasına göre tenant çözeriz
  private readonly tenantId = 'cmkeas8p500056hpg59gmkquc';

  constructor(
    private readonly provider: TwilioWhatsAppProvider,
    private readonly agent: AgentService,
  ) {}

  async handleIncomingMessage(payload: any) {
    const msg = this.provider.parseInbound(payload);

    // 1) inbound log
    this.logger.log(`📩 WhatsApp from ${msg.from}: ${msg.text}`);

    // 2) Agent reply üret
    let reply = '';
    try {
      this.logger.log(`[WA] -> AgentService.replyText tenantId=${this.tenantId} from=${msg.from}`);
      reply = await withTimeout(
        this.agent.replyText({
          tenantId: this.tenantId,
          from: msg.from,
          text: msg.text,
        }),
        20000,
        'AgentService.replyText',
      );
      this.logger.log(`[WA] <- AgentService reply: ${reply}`);
    } catch (e: any) {
      this.logger.error(`[WA] AgentService error: ${e?.message || e}`);
      reply = 'Şu an sistem yoğun 😕 Birazdan tekrar yazar mısınız?';
    }

    // 3) Twilio ile gönder (burada patlıyorsa artık log göreceğiz)
    try {
      this.logger.log(`[WA] -> provider.sendText to=${msg.from}`);
      await this.provider.sendText(msg.from, reply);
      this.logger.log(`[WA] ✅ provider.sendText OK to=${msg.from}`);
    } catch (e: any) {
      this.logger.error(`[WA] ❌ provider.sendText FAILED: ${e?.message || e}`);
      // Twilio response body falan varsa:
      if (e?.response?.data) this.logger.error(`[WA] Twilio response: ${JSON.stringify(e.response.data)}`);
    }
  }
}
