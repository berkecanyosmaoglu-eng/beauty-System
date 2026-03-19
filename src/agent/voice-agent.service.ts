import { Injectable } from '@nestjs/common';
import { AgentReplyRequest } from './shared/agent-types';
import { shapeVoiceAgentReply } from './shared/voice-response-policy';
import { JarvisBrainService } from '../jarvis/jarvis-brain.service';

@Injectable()
export class VoiceAgentService {
  constructor(
    private readonly jarvisBrain: JarvisBrainService,
  ) {}

  async prewarmVoiceContext(tenantId: string): Promise<void> {
    await this.jarvisBrain.prewarmVoiceContext(tenantId);
  }

  async replyText(payload: AgentReplyRequest): Promise<string> {
    const reply = await this.jarvisBrain.reply(payload);
    return shapeVoiceAgentReply(reply);
  }

}
