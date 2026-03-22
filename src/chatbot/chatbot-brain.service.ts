import { Injectable } from '@nestjs/common';
import { BookingCoreService } from '../booking/booking-core.service';
import { BookingOrchestratorService } from '../booking/booking-orchestrator.service';
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

type ChatState =
  | 'IDLE'
  | 'COLLECTING_NAME'
  | 'COLLECTING_SERVICE'
  | 'COLLECTING_DATETIME'
  | 'WAITING_CONFIRMATION';

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
    private readonly bookingOrchestrator: BookingOrchestratorService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async reply(payload: AgentReplyRequest): Promise<string> {
    const normalized = withAgentChannel(payload, 'chat');
    const session = this.getOrInitSession(normalized);
    const rawText = String(normalized.text || '').trim();
    const lowered = rawText.toLocaleLowerCase('tr-TR');

    if (!rawText) {
      return 'Mesajınızı tekrar yazar mısınız?';
    }

    session.updatedAt = Date.now();

    // Kullanıcı sessizce genel moda dönebilir
    if (this.isExitIntent(lowered)) {
      this.resetSession(session, false);
      return this.knowledge.answer({
        ...normalized,
        text: 'güzellik merkezi hizmetleri hakkında bilgi ver',
      });
    }

    // Her mesajda SADECE mesaj içinden adayları çıkar
    const serviceCandidate = await this.findServiceMatch(
      session.tenantId,
      rawText,
    );
    const hasServiceInMessage = Boolean(serviceCandidate);

    const dateTimeCandidate = extractChatbotDateTimeText(rawText);
    const hasDateTimeInMessage = Boolean(dateTimeCandidate);

    const explicitBookingIntent = looksLikeChatbotBookingIntent(rawText);
    const beautyQuestion = this.isBeautyInfoQuestion(lowered);

    // Booking içindeyken beauty sorusu geldiyse draftı koru, sadece cevap ver
    if (
      session.mode === 'BOOKING' &&
      beautyQuestion &&
      !explicitBookingIntent &&
      !hasDateTimeInMessage
    ) {
      return this.knowledge.answer(normalized);
    }

    // Auto booking:
    // 1) açık booking intent
    // 2) aynı mesajda hizmet + tarih/saat
// booking başlatıldıysa ASLA düşme

if (
  explicitBookingIntent ||
  (hasServiceInMessage && hasDateTimeInMessage) ||
  session.mode === 'BOOKING'
) {
  session.mode = 'BOOKING';
}


const hasDraft =
  session.draft.serviceId ||
  session.draft.dateTimeText ||
  session.draft.customerName;

if (session.mode !== 'BOOKING' && !hasDraft) {
  return this.knowledge.answer(normalized);
}
    // Mesajdan draft alanlarını doldur
    await this.tryFillDraft(session, rawText, serviceCandidate, dateTimeCandidate);

    // Confirmation ekranı
    if (session.state === 'WAITING_CONFIRMATION') {
      if (rawText.length <= 2) {
        return 'Onay için evet, değiştirmek için hayır yazabilirsiniz.';
      }

      if (isChatbotAffirmative(rawText)) {
        return this.completeBooking(session, normalized);
      }

      if (isChatbotNegative(rawText)) {
        session.state = 'COLLECTING_DATETIME';
        session.draft.dateTimeText = undefined;
        return 'Tabii, yeni gün ve saat yazar mısınız?';
      }

      // Confirmation ekranında yeni tarih yazılırsa kabul et
      const maybeDateTime = extractChatbotDateTimeText(rawText);
      if (maybeDateTime) {
        session.draft.dateTimeText = maybeDateTime;
        return this.buildConfirmationPrompt(session);
      }

      // Confirmation ekranında service değişirse override et
      const maybeService = await this.findServiceMatch(session.tenantId, rawText);
      if (maybeService) {
        session.draft.serviceId = String(maybeService.id);
        session.draft.serviceName = String(maybeService.name);
        return this.buildConfirmationPrompt(session);
      }

      return `${this.buildConfirmationPrompt(session)} Onaylıyorsanız “evet” yazın.`;
    }
if (
  session.draft.serviceId &&
  session.draft.dateTimeText &&
  session.draft.customerName
) {
  session.state = 'WAITING_CONFIRMATION';
  return this.buildConfirmationPrompt(session);
}
    const step = await this.bookingOrchestrator.processStep(session.draft, {
      tenantId: normalized.tenantId,
      customerPhone: normalized.from,
      channel: 'WHATSAPP',
    });

    if (step.type === 'ASK_SERVICE') {
      session.state = 'COLLECTING_SERVICE';
      return 'Hangi hizmet için randevu istiyorsunuz?';
    }

    if (step.type === 'ASK_DATETIME') {
      session.state = 'COLLECTING_DATETIME';
      return 'Hangi gün ve saat uygundur?';
    }

    if (step.type === 'ASK_NAME') {
      session.state = 'COLLECTING_NAME';
      return 'Ad soyadınızı paylaşır mısınız?';
    }

    if (step.type === 'ASK_CONFIRMATION') {
      session.state = 'WAITING_CONFIRMATION';
      return `Özet: ${step.summary}. Onaylıyor musunuz?`;
    }

    return 'Bilgileri tekrar yazar mısınız?';
  }

  private getOrInitSession(
    payload: AgentReplyRequest & { from: string },
  ): ChatSession {
    const customerKey = String(
      payload.customerPhone || payload.from || 'unknown-chat',
    ).trim();
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

  private async tryFillDraft(
    session: ChatSession,
    rawText: string,
    preMatchedService?: { id: string; name: string } | null,
    preMatchedDateTime?: string | null,
  ): Promise<void> {
    const service =
      preMatchedService || (await this.findServiceMatch(session.tenantId, rawText));

    if (service) {
      // Her yeni mesajda service override edilebilir
      session.draft.serviceId = String(service.id);
      session.draft.serviceName = String(service.name);
    }

    if (preMatchedDateTime) {
      session.draft.dateTimeText = preMatchedDateTime;
    } else if (!session.draft.dateTimeText) {
      const dateTimeText = extractChatbotDateTimeText(rawText);
      if (dateTimeText) {
        session.draft.dateTimeText = dateTimeText;
      }
    }

    if (!session.draft.customerName) {
      const name = extractChatbotCustomerName(
        rawText,
        session.draft.serviceName,
      );
      if (name) {
        session.draft.customerName = name;
      }
    }
  }

  private async completeBooking(
    session: ChatSession,
    payload: AgentReplyRequest & { from: string },
  ): Promise<string> {
    const result = await this.bookingOrchestrator.confirmBooking(session.draft, {
      tenantId: payload.tenantId,
      customerPhone: payload.from,
      channel: 'WHATSAPP',
    });

    if (result.type === 'SUCCESS') {
      this.resetSession(session, false);
      return result.message;
    }

    if (result.type === 'ERROR') {
      const msg = result.message;

      if (
        msg.includes('Gün ve saati tekrar') ||
        msg.includes('çalışma saatleri dışında') ||
        msg.includes('dolu')
      ) {
        session.state = 'COLLECTING_DATETIME';
      } else if (msg.includes('Ad soyad')) {
        session.state = 'COLLECTING_NAME';
      } else if (msg.includes('Hangi hizmet')) {
        session.state = 'COLLECTING_SERVICE';
      }

      return msg;
    }

    return 'Randevu oluşturulamadı. Bilgileri tekrar yazar mısınız?';
  }

  private async findServiceMatch(tenantId: string, rawText: string) {
    const services = await this.bookingCore.listServicesForConversation(tenantId);
    return findChatbotServiceMatch(services, rawText);
  }

  private buildConfirmationPrompt(session: ChatSession): string {
    const customer = session.draft.customerName || '—';
    const service = session.draft.serviceName || '—';
    const date = session.draft.dateTimeText || '—';
    return `Özet: ${customer}, ${service}, ${date}. Onaylıyor musunuz?`;
  }

  private resetSession(
    session: ChatSession,
    preserveBookingMode: boolean,
  ): void {
    session.mode = preserveBookingMode ? 'BOOKING' : 'GENERAL';
    session.state = 'IDLE';
    session.updatedAt = Date.now();
    session.draft = {};
  }

  private isExitIntent(text: string): boolean {
    return /(vazgec|vazgeç|iptal|bosver|boşver|cik|çık|ana menü|menü)/i.test(
      text,
    );
  }

  private isBeautyInfoQuestion(text: string): boolean {
    return /(fiyat|ucret|ücret|adres|nerede|calisma|çalışma|saat|konum|bilgi|kaç seans|kac seans|can yakar|acıtır|acitir|nasıl yapılır|nasil yapilir|ne kadar sürer|ne kadar surer)/i.test(
      text,
    );
  }
}
