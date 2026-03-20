import { Injectable, Logger } from '@nestjs/common';
import Twilio from 'twilio';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  private readonly accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  private readonly authToken = process.env.TWILIO_AUTH_TOKEN || '';
  private readonly from = process.env.TWILIO_SMS_FROM || ''; // ✅ sende bu var

  private client: ReturnType<typeof Twilio> | null = null;

  private getClient() {
    if (!this.client) {
      if (!this.accountSid || !this.authToken) return null;
      this.client = Twilio(this.accountSid, this.authToken);
    }
    return this.client;
  }

  normalizePhone(input?: string | null): string | null {
    if (!input) return null;
    let p = String(input).trim().replace(/[()\-\s]/g, '');

    if (p.startsWith('+')) return p;

    // TR: 05xxxxxxxxx -> +905xxxxxxxxx
    if (p.startsWith('0') && p.length === 11 && p.startsWith('05')) return `+9${p}`;

    // TR: 5xxxxxxxxx -> +905xxxxxxxxx
    if (/^5\d{9}$/.test(p)) return `+90${p}`;

    // TR: 90xxxxxxxxxx -> +90...
    if (p.startsWith('90')) return `+${p}`;

    return p;
  }

  async sendSms(toRaw: string, body: string) {
    const to = this.normalizePhone(toRaw);

    if (!to) {
      this.logger.warn(`SMS skip: missing 'to'`);
      return;
    }
    if (!this.from) {
      this.logger.error(`TWILIO_SMS_FROM missing -> cannot send`);
      return;
    }

    const client = this.getClient();
    if (!client) {
      this.logger.error(`Twilio credentials missing -> cannot send`);
      return;
    }

    try {
      const res = await client.messages.create({ from: this.from, to, body });
      this.logger.log(`SMS sent to=${to} sid=${res.sid}`);
    } catch (e: any) {
      this.logger.error(`SMS send failed to=${to}: ${e?.message || e}`);
    }
  }
}
