import { Injectable } from '@nestjs/common';
import { ChatAgentService } from './chat-agent.service';

/**
 * Backwards-compatible alias for the legacy injection token.
 * New code should inject ChatAgentService or VoiceAgentService explicitly.
 */
@Injectable()
export class AgentService extends ChatAgentService {}
