import { Injectable } from '@nestjs/common';
import { BookingCoreService } from './shared/booking-core.service';
import { AgentReplyRequest } from './shared/agent-types';
import { withAgentChannel } from './shared/agent-helpers';

@Injectable()
export class VoiceAgentService {
  constructor(private readonly bookingCore: BookingCoreService) {}

  replyText(payload: AgentReplyRequest): Promise<string> {
    return this.bookingCore.replyText(withAgentChannel(payload, 'voice'));
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
