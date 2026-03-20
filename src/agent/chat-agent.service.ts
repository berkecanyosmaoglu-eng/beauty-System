import { Injectable } from '@nestjs/common';
import { AgentReplyRequest } from './shared/agent-types';
import { ChatbotBrainService } from '../chatbot/chatbot-brain.service';

@Injectable()
export class ChatAgentService {
  constructor(private readonly chatbotBrain: ChatbotBrainService) {}

  replyText(payload: AgentReplyRequest): Promise<string> {
    return this.chatbotBrain.reply(payload);
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
