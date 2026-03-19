import { Injectable } from '@nestjs/common';
import { AgentReplyRequest } from './shared/agent-types';
import { ChatConversationService } from './chat/chat-conversation.service';

@Injectable()
export class ChatAgentService {
  constructor(private readonly chatConversation: ChatConversationService) {}

  replyText(payload: AgentReplyRequest): Promise<string> {
    return this.chatConversation.handleTurn(payload);
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
