import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TwilioSmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);

  private readonly sid = process.env.TWILIO_ACCOUNT_SID || '';
  private readonly token = process.env.TWILIO_AUTH_TOKEN || '';
  private readonly from = process.env.TWILIO_SMS_FROM || ''; // Twilio SMS-capable number

  async sendSms(to: string, body: string) {
    if (!this.sid || !this.token || !this.from) {
      this.logger.warn(`Twilio SMS not configured (missing env). to=${to}`);
      return; // prod'da istersen throw da yaparız
    }

    // Dinamik import: twilio paketi yoksa app patlamasın
    // (istersen package.json'a ekleriz)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    const client = twilio(this.sid, this.token);

    await client.messages.create({
      from: this.from,
      to,
      body,
    });

    this.logger.log(`SMS sent to=${to}`);
  }
}
