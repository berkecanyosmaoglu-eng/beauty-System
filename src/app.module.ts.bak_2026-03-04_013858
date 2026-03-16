import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';

import { PrismaModule } from './prisma/prisma.module';
import { TenantModule } from './tenant/tenant.module';
import { ServicesModule } from './services/services.module';
import { StaffModule } from './staff/staff.module';
import { CustomersModule } from './customers/customers.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { BotModule } from './bot/bot.module';
import { AgentModule } from './agent/agent.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RemindersModule } from './reminders/reminders.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),

    PrismaModule,
    TenantModule,
    ServicesModule,
    StaffModule,
    CustomersModule,
    AppointmentsModule,

    BotModule,
    NotificationsModule,
    AgentModule,
    WhatsappModule,

    AdminModule,
    RemindersModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
