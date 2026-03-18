import { AgentReplyRequest } from './agent-types';

export function normalizeAgentCustomerPhone(
  payload: AgentReplyRequest,
): string {
  const raw = String(payload.customerPhone || payload.from || '').trim();
  return raw || 'unknown-customer';
}

export function withAgentChannel<T extends AgentReplyRequest>(
  payload: T,
  channel: 'chat' | 'voice',
): T & { from: string; channel: 'chat' | 'voice'; source: 'chat' | 'voice' } {
  const from = normalizeAgentCustomerPhone(payload);
  return {
    ...payload,
    from,
    channel,
    source: channel,
  };
}
