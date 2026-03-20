import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatAgentService } from './chat-agent.service';
import { VoiceAgentService } from './voice-agent.service';
import { BookingModule } from '../booking/booking.module';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ChatbotBrainService } from '../chatbot/chatbot-brain.service';
import { JarvisBrainService } from '../jarvis/jarvis-brain.service';

@Module({
  imports: [PrismaModule, BookingModule],
  providers: [
    KnowledgeService,
    ChatbotBrainService,
    JarvisBrainService,
    ChatAgentService,
    VoiceAgentService,
  ],
  exports: [
    KnowledgeService,
    ChatbotBrainService,
    JarvisBrainService,
    ChatAgentService,
    VoiceAgentService,
  ],
})
export class AgentModule {}
