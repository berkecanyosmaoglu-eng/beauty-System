import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingCoreService } from './shared/booking-core.service';
import { ChatAgentService } from './chat-agent.service';
import { VoiceAgentService } from './voice-agent.service';
import { AgentService } from './agent.service';
import { VoiceConversationService } from './voice/voice-conversation.service';
import { ChatConversationService } from './chat/chat-conversation.service';

@Module({
  imports: [PrismaModule],
  providers: [
    BookingCoreService,
    VoiceConversationService,
    ChatConversationService,
    ChatAgentService,
    VoiceAgentService,
    AgentService,
  ],
  exports: [
    BookingCoreService,
    VoiceConversationService,
    ChatConversationService,
    ChatAgentService,
    VoiceAgentService,
    AgentService,
  ],
})
export class AgentModule {}
