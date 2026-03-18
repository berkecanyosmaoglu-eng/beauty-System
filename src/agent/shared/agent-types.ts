export type AgentChannel = 'chat' | 'voice';

export type AgentReplyRequest = {
  tenantId: string;
  text: string;
  from?: string;
  customerPhone?: string;
  to?: string;
  callId?: string;
  streamSid?: string;
  channel?: AgentChannel | string;
  source?: string;
};
