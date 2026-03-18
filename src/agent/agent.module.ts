import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingCoreService } from './shared/booking-core.service';
import { ChatAgentService } from './chat-agent.service';
import { VoiceAgentService } from './voice-agent.service';
import { AgentService } from './agent.service';

@Module({
  imports: [PrismaModule],
  providers: [
    BookingCoreService,
    ChatAgentService,
    VoiceAgentService,
    AgentService,
  ],
  exports: [
    BookingCoreService,
    ChatAgentService,
    VoiceAgentService,
    AgentService,
  ],
})
export class AgentModule {}
