import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { RealtimeBridgeService } from './realtime-bridge.service';
import { AppointmentsModule } from '../appointments/appointments.module';
import { NotifyModule } from '../notify/notify.module';

@Module({
  imports: [AppointmentsModule, NotifyModule],
  controllers: [BotController],
  providers: [BotService, RealtimeBridgeService],
})
export class BotModule {}
