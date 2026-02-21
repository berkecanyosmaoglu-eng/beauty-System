import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RemindersService } from './reminders.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // Not: ScheduleModule.forRoot() genelde AppModule'da 1 kez olur.
    // Ama şu an hızlı fix için burada kalsa da çalışır.
    ScheduleModule.forRoot(),
    NotificationsModule,
  ],
  providers: [RemindersService, PrismaService],
  exports: [RemindersService],
})
export class RemindersModule {}
