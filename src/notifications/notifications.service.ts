import { Injectable, Logger } from '@nestjs/common';
import { TwilioSmsProvider } from './twilio-sms.provider';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly sms: TwilioSmsProvider) {}

  async sendBookingConfirmation(args: {
    toPhone: string;
    salonName: string;
    serviceName: string;
    staffName?: string;
    startAt: Date;
    addressShort?: string;
  }) {
    if (!args.toPhone) {
      this.logger.warn('sendBookingConfirmation skipped: missing toPhone');
      return;
    }

    const startText = args.startAt.toLocaleString('tr-TR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const msg =
      `✅ ${args.salonName}\n` +
      `Randevunuz oluşturuldu.\n` +
      `İşlem: ${args.serviceName}\n` +
      (args.staffName ? `Uzman: ${args.staffName}\n` : '') +
      `Tarih/Saat: ${startText}\n` +
      (args.addressShort ? `Adres: ${args.addressShort}\n` : '') +
      `Değişiklik için bu numaraya yazabilirsiniz.`;

    await this.sms.sendSms(args.toPhone, msg);
  }
}
