import { Injectable } from '@nestjs/common';
import { BookingCoreService } from '../booking/booking-core.service';
import { AgentReplyRequest } from '../agent/shared/agent-types';
import { withAgentChannel } from '../agent/shared/agent-helpers';
import { KnowledgeService } from '../knowledge/knowledge.service';
import {
  extractChatbotCustomerName,
  extractChatbotDateTimeText,
  findChatbotServiceMatch,
  isChatbotAffirmative,
  isChatbotNegative,
  looksLikeChatbotBookingIntent,
} from './chatbot-parser';

type ChatState = 'IDLE' | 'COLLECTING_NAME' | 'COLLECTING_SERVICE' | 'COLLECTING_DATETIME' | 'WAITING_CONFIRMATION';

type ChatSession = {
  key: string;
  tenantId: string;
  mode: 'GENERAL' | 'BOOKING';
  state: ChatState;
  updatedAt: number;
  draft: {
    customerName?: string;
    serviceId?: string;
    serviceName?: string;
    dateTimeText?: string;
  };
};

@Injectable()
export class ChatbotBrainService {
  private readonly sessions = new Map<string, ChatSession>();
  constructor(
    private readonly bookingCore: BookingCoreService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async reply(payload: AgentReplyRequest): Promise<string> {
    const normalized = withAgentChannel(payload, 'chat');
    const session = this.getOrInitSession(normalized);
    const rawText = String(normalized.text || '').trim();

    if (!rawText) {
      return 'Mesajınızı tekrar yazar mısınız?';
    }

    session.updatedAt = Date.now();

    if (looksLikeChatbotBookingIntent(rawText)) {
      session.mode = 'BOOKING';
    }

    if (session.mode !== 'BOOKING') {
      return this.knowledge.answer(payload);
    }

    if (session.state === 'WAITING_CONFIRMATION') {
      if (isChatbotAffirmative(rawText)) {
        return this.completeBooking(session, normalized);
      }
      if (isChatbotNegative(rawText)) {
        this.resetSession(session, true);
        session.state = 'COLLECTING_SERVICE';
        return 'Tamam. Hangi hizmet için randevu istiyorsunuz?';
      }
      return `${this.buildConfirmationPrompt(session)} Onaylıyorsanız “evet” yazın.`;
    }

    await this.tryFillDraft(session, rawText);

    if (!session.draft.customerName) {
      session.state = 'COLLECTING_NAME';
      return 'Ad soyadınızı paylaşır mısınız?';
    }

    if (!session.draft.serviceId || !session.draft.serviceName) {
      session.state = 'COLLECTING_SERVICE';
      return 'Hangi hizmet için randevu istiyorsunuz?';
    }

    if (!session.draft.dateTimeText) {
      session.state = 'COLLECTING_DATETIME';
      return 'Hangi gün ve saat uygundur?';
    }

    session.state = 'WAITING_CONFIRMATION';
    return this.buildConfirmationPrompt(session);
  }

  private getOrInitSession(payload: AgentReplyRequest & { from: string }): ChatSession {
    const customerKey = String(payload.customerPhone || payload.from || 'unknown-chat').trim();
    const key = `${payload.tenantId}:${customerKey}`;
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const created: ChatSession = {
      key,
      tenantId: payload.tenantId,
      mode: 'GENERAL',
      state: 'IDLE',
      updatedAt: Date.now(),
      draft: {},
    };
    this.sessions.set(key, created);
    return created;
  }

  private async tryFillDraft(session: ChatSession, rawText: string): Promise<void> {
    if (!session.draft.serviceId) {
      const service = await this.findServiceMatch(session.tenantId, rawText);
      if (service) {
        session.draft.serviceId = String(service.id);
        session.draft.serviceName = String(service.name);
      }
    }

    if (!session.draft.dateTimeText) {
      const dateTimeText = extractChatbotDateTimeText(rawText);
      if (dateTimeText) {
        session.draft.dateTimeText = dateTimeText;
      }
    }

    if (!session.draft.customerName) {
      const name = extractChatbotCustomerName(rawText, session.draft.serviceName);
      if (name) {
        session.draft.customerName = name;
      }
    }
  }

  private async completeBooking(
    session: ChatSession,
    payload: AgentReplyRequest & { from: string },
  ): Promise<string> {
    const startAt = this.bookingCore.parseDateTimeForConversation(session.draft.dateTimeText || '');
    if (!startAt || !session.draft.customerName || !session.draft.serviceId) {
      session.state = 'COLLECTING_DATETIME';
      return 'Tarih ve saati tekrar yazar mısınız?';
    }

    const result = await this.bookingCore.createBookingFromConversation({
      tenantId: payload.tenantId,
      customerPhone: payload.from,
      customerName: session.draft.customerName,
      serviceId: session.draft.serviceId,
      startAt,
      channel: 'WHATSAPP',
    });

    if (result.ok) {
      const serviceName = session.draft.serviceName || 'hizmet';
      this.resetSession(session, false);
      return `Tamamdır, ${serviceName} için randevunuzu oluşturdum.`;
    }

    if (result.code === 'OUT_OF_HOURS') {
      session.state = 'COLLECTING_DATETIME';
      return 'Bu saat çalışma saatleri dışında. Başka bir gün veya saat yazın.';
    }

    if (result.code === 'SLOT_TAKEN') {
      session.state = 'COLLECTING_DATETIME';
      return 'O saat dolu görünüyor. Başka bir gün veya saat yazın.';
    }

    if (result.code === 'STAFF_CONFIGURATION_REQUIRED') {
      session.state = 'COLLECTING_DATETIME';
      return 'Randevu ayarı tamamlanamadı. Lütfen işletme yöneticisi varsayılan personel tanımlasın.';
    }

    return 'Randevu oluşturulamadı. Bilgileri tekrar yazabilir misiniz?';
  }

  private async findServiceMatch(tenantId: string, rawText: string) {
    const services = await this.bookingCore.listServicesForConversation(tenantId);
    return findChatbotServiceMatch(services, rawText);
  }

  private buildConfirmationPrompt(session: ChatSession): string {
    return `Özet: ${session.draft.customerName || '—'}, ${session.draft.serviceName || '—'}, ${session.draft.dateTimeText || '—'}. Onaylıyor musunuz?`;
  }

  private resetSession(session: ChatSession, preserveBookingMode: boolean): void {
    session.mode = preserveBookingMode ? 'BOOKING' : 'GENERAL';
    session.state = 'IDLE';
    session.updatedAt = Date.now();
    session.draft = {};
  }

}
