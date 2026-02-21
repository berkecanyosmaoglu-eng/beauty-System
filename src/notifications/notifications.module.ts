import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { TwilioSmsProvider } from './twilio-sms.provider';

@Module({
  providers: [NotificationsService, TwilioSmsProvider],
  exports: [NotificationsService, TwilioSmsProvider],
})
export class NotificationsModule {}
