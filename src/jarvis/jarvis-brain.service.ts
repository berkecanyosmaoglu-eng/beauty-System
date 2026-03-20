import { Injectable } from '@nestjs/common';
import { BookingCoreService } from '../booking/booking-core.service';
import { AgentReplyRequest } from '../agent/shared/agent-types';
import { withAgentChannel } from '../agent/shared/agent-helpers';
import { KnowledgeService } from '../knowledge/knowledge.service';
import {
  buildJarvisDeterministicShortReply,
  extractJarvisCustomerName,
  extractJarvisDateTimeText,
  findJarvisServiceMatch,
  isJarvisAffirmative,
  isJarvisNegative,
  looksLikeJarvisBookingIntent,
} from './jarvis-parser';

type JarvisState = 'IDLE' | 'COLLECTING_NAME' | 'COLLECTING_SERVICE' | 'COLLECTING_DATETIME' | 'WAITING_CONFIRMATION';

type JarvisSession = {
  key: string;
  tenantId: string;
  bookingIntentActive: boolean;
  state: JarvisState;
  updatedAt: number;
  draft: {
    customerName?: string;
    serviceId?: string;
    serviceName?: string;
    dateTimeText?: string;
  };
};

@Injectable()
export class JarvisBrainService {
  private readonly sessions = new Map<string, JarvisSession>();
  constructor(
    private readonly bookingCore: BookingCoreService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async prewarmVoiceContext(_: string): Promise<void> {
    return Promise.resolve();
  }

  async reply(payload: AgentReplyRequest): Promise<string> {
    const normalized = withAgentChannel(payload, 'voice');
    const session = this.getOrInitSession(normalized);
    const rawText = String(normalized.text || '').trim();

    if (!rawText) {
      return 'Tekrar söyler misiniz?';
    }

    const deterministic = buildJarvisDeterministicShortReply(rawText);
    if (deterministic) {
      return deterministic;
    }

    session.updatedAt = Date.now();
await this.tryFillDraft(session, rawText);

    if (!session.bookingIntentActive && looksLikeJarvisBookingIntent(rawText)) {
      session.bookingIntentActive = true;
    }


    if (!session.bookingIntentActive) {
      return this.knowledge.answer(payload);
    }

    if (session.state === 'WAITING_CONFIRMATION') {
      if (isJarvisAffirmative(rawText)) {
        return this.completeBooking(session, normalized);
      }
      if (isJarvisNegative(rawText)) {
        this.resetSession(session, true);
        session.state = 'COLLECTING_SERVICE';
        return 'Tamam. Hangi işlem?';
      }
      return `${this.buildConfirmationPrompt(session)} Onay için evet deyin.`;
    }

    await this.tryFillDraft(session, rawText);

if (!session.draft.serviceId || !session.draft.serviceName) {
  session.state = 'COLLECTING_SERVICE';
  return 'Hangi işlem?';
}

if (!session.draft.dateTimeText) {
  session.state = 'COLLECTING_DATETIME';
  return 'Hangi gün ve saat?';
}

if (!session.draft.customerName) {
  session.state = 'COLLECTING_NAME';
  return 'Ad soyad?';
}


    session.state = 'WAITING_CONFIRMATION';
    return this.buildConfirmationPrompt(session);
  }

  private getOrInitSession(payload: AgentReplyRequest & { from: string }): JarvisSession {
    const customerKey = String(payload.customerPhone || payload.from || payload.callId || 'unknown-voice').trim();
    const key = `${payload.tenantId}:${customerKey}`;
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const created: JarvisSession = {
      key,
      tenantId: payload.tenantId,
      bookingIntentActive: false,
      state: 'IDLE',
      updatedAt: Date.now(),
      draft: {},
    };
    this.sessions.set(key, created);
    return created;
  }

  private async tryFillDraft(session: JarvisSession, rawText: string): Promise<void> {
    if (!session.draft.serviceId) {
      const service = await this.findServiceMatch(session.tenantId, rawText);
      if (service) {
        session.draft.serviceId = String(service.id);
        session.draft.serviceName = String(service.name);
      }
    }

    if (!session.draft.dateTimeText) {
      const dateTimeText = extractJarvisDateTimeText(rawText);
      if (dateTimeText) {
        session.draft.dateTimeText = dateTimeText;
      }
    }

    if (!session.draft.customerName) {
      const name = extractJarvisCustomerName(rawText, session.draft.serviceName);
      if (name) {
        session.draft.customerName = name;
      }
    }
  }

  private async completeBooking(
    session: JarvisSession,
    payload: AgentReplyRequest & { from: string },
  ): Promise<string> {
    const startAt = this.bookingCore.parseDateTimeForConversation(session.draft.dateTimeText || '');
    if (!startAt || !session.draft.customerName || !session.draft.serviceId) {
      session.state = 'COLLECTING_DATETIME';
      return 'Tarih ve saati tekrar söyler misiniz?';
    }

    const result = await this.bookingCore.createBookingFromConversation({
      tenantId: payload.tenantId,
customerPhone: String(payload.from || payload.customerPhone || '').trim(),
      customerName: session.draft.customerName,
      serviceId: session.draft.serviceId,
      startAt,
      channel: 'VOICE',
      callId: payload.callId,
      streamSid: payload.streamSid,
    });

    if (result.ok) {
      const serviceName = session.draft.serviceName || 'işlem';
      this.resetSession(session, false);
      return `Tamam. ${serviceName} randevunuzu oluşturdum.`;
    }

    if (result.code === 'OUT_OF_HOURS') {
      session.state = 'COLLECTING_DATETIME';
      return 'Bu saat uygun değil. Başka gün veya saat?';
    }

    if (result.code === 'SLOT_TAKEN') {
      session.state = 'COLLECTING_DATETIME';
      return 'O saat dolu. Başka gün veya saat?';
    }

    if (result.code === 'STAFF_CONFIGURATION_REQUIRED') {
      return 'Sistem personel ayarı eksik. İşletme yöneticisi kontrol etmeli.';
    }

    return 'Randevuyu oluşturamadım. Tekrar deneyelim.';
  }

  private async findServiceMatch(tenantId: string, rawText: string) {
    const services = await this.bookingCore.listServicesForConversation(tenantId);
    return findJarvisServiceMatch(services, rawText);
  }

  private buildConfirmationPrompt(session: JarvisSession): string {
    return `Özet: ${session.draft.customerName || '—'}, ${session.draft.serviceName || '—'}, ${session.draft.dateTimeText || '—'}.`;
  }

  private resetSession(session: JarvisSession, preserveBookingIntent: boolean): void {
    session.bookingIntentActive = preserveBookingIntent;
    session.state = 'IDLE';
    session.updatedAt = Date.now();
    session.draft = {};
  }

}
