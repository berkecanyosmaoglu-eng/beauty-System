import { Injectable } from '@nestjs/common';
import { AgentReplyRequest } from './shared/agent-types';
import { shapeVoiceAgentReply } from './shared/voice-response-policy';
import { VoiceConversationService } from './voice/voice-conversation.service';

@Injectable()
export class VoiceAgentService {
  constructor(
    private readonly voiceConversation: VoiceConversationService,
  ) {}

  async prewarmVoiceContext(tenantId: string): Promise<void> {
    await this.voiceConversation.prewarmVoiceContext(tenantId);
  }

  async replyText(payload: AgentReplyRequest): Promise<string> {
    const reply = await this.voiceConversation.handleTurn(payload);
    return shapeVoiceAgentReply(reply);
  }

  handleIncomingMessage(payload: AgentReplyRequest): Promise<string> {
    return this.replyText(payload);
  }

  processIncomingMessage(payload: AgentReplyRequest): Promise<string> {
    return this.replyText(payload);
  }

  processMessage(payload: AgentReplyRequest): Promise<string> {
    return this.replyText(payload);
  }
}
