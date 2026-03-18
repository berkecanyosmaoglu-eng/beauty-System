import { Injectable } from '@nestjs/common';
import { BookingCoreService } from './shared/booking-core.service';
import { AgentReplyRequest } from './shared/agent-types';
import { withAgentChannel } from './shared/agent-helpers';
import { shapeVoiceAgentReply } from './shared/voice-response-policy';

@Injectable()
export class VoiceAgentService {
  constructor(private readonly bookingCore: BookingCoreService) {}

  async prewarmVoiceContext(tenantId: string): Promise<void> {
    await this.bookingCore.prewarmVoiceContext(tenantId);
  }

  async replyText(payload: AgentReplyRequest): Promise<string> {
    const reply = await this.bookingCore.replyText(
      withAgentChannel(payload, 'voice'),
    );
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
