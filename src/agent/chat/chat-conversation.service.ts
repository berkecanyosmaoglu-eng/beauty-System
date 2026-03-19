import { Injectable } from '@nestjs/common';
import { BookingCoreService } from '../shared/booking-core.service';
import { AgentReplyRequest } from '../shared/agent-types';
import { withAgentChannel } from '../shared/agent-helpers';

type ChatConversationMode = 'GENERAL' | 'BOOKING';
type ChatConversationState =
  | 'IDLE'
  | 'COLLECTING_NAME'
  | 'COLLECTING_SERVICE'
  | 'COLLECTING_DATETIME'
  | 'WAITING_CONFIRMATION'
  | 'LEGACY_FALLBACK';

type ChatBookingDraft = {
  customerName?: string;
  serviceId?: string;
  serviceName?: string;
  dateTimeText?: string;
};

type ChatConversationSession = {
  key: string;
  tenantId: string;
  customerKey: string;
  mode: ChatConversationMode;
  state: ChatConversationState;
  updatedAt: number;
  lastUserText?: string;
  draft: ChatBookingDraft;
};

@Injectable()
export class ChatConversationService {
  private readonly sessions = new Map<string, ChatConversationSession>();
  private readonly fillerWords = new Set([
    'evet',
    'hayir',
    'hayır',
    'tamam',
    'olur',
    'uygun',
    'merhaba',
    'selam',
    'teşekkürler',
    'tesekkurler',
  ]);

  constructor(private readonly bookingCore: BookingCoreService) {}

  async handleTurn(payload: AgentReplyRequest): Promise<string> {
    const normalized = withAgentChannel(payload, 'chat');
    const session = this.getOrInitSession(normalized);
    const rawText = String(normalized.text || '').trim();

    session.lastUserText = rawText;
    session.updatedAt = Date.now();

    if (!rawText) {
      return 'Mesajınızı tekrar yazar mısınız?';
    }

    if (this.shouldUseLegacyFallback(session, rawText)) {
      return this.legacyFallback(session, normalized);
    }

    if (this.looksLikeBookingIntent(rawText)) {
      session.mode = 'BOOKING';
    }

    if (session.mode !== 'BOOKING') {
      return this.legacyFallback(session, normalized);
    }

    if (session.state === 'WAITING_CONFIRMATION') {
      if (this.isAffirmative(rawText)) {
        return this.completeCreate(session, normalized);
      }
      if (this.isNegative(rawText)) {
        this.resetSession(session, { preserveMode: true });
        session.state = 'COLLECTING_SERVICE';
        return 'Tamam, yeniden başlayalım. Hangi hizmet için randevu istiyorsunuz?';
      }
      return `${this.buildConfirmationPrompt(session)} Onaylıyorsanız “evet”, değiştirmek isterseniz “hayır” yazabilirsiniz.`;
    }

    await this.tryFillDraftFromTurn(session, rawText);

    if (!session.draft.customerName) {
      session.state = 'COLLECTING_NAME';
      return 'Ad soyadınızı paylaşır mısınız?';
    }

    if (!session.draft.serviceName) {
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

  private getOrInitSession(
    payload: AgentReplyRequest & { from: string; channel: string; source: string },
  ): ChatConversationSession {
    const customerKey = String(
      payload.customerPhone || payload.from || 'unknown-chat',
    ).trim();
    const key = `${payload.tenantId}:${customerKey}`;
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const created: ChatConversationSession = {
      key,
      tenantId: payload.tenantId,
      customerKey,
      mode: 'GENERAL',
      state: 'IDLE',
      updatedAt: Date.now(),
      draft: {},
    };
    this.sessions.set(key, created);
    return created;
  }

  private async tryFillDraftFromTurn(
    session: ChatConversationSession,
    rawText: string,
  ): Promise<void> {
    if (!session.draft.serviceName) {
      const service = await this.findServiceMatch(session.tenantId, rawText);
      if (service?.name) {
        session.draft.serviceId = service.id ? String(service.id) : undefined;
        session.draft.serviceName = String(service.name);
      }
    }

    if (!session.draft.dateTimeText) {
      const dateTimeText = this.extractDateTimeText(rawText);
      if (dateTimeText) {
        session.draft.dateTimeText = dateTimeText;
      }
    }

    if (!session.draft.customerName) {
      const customerName = this.extractCustomerName(rawText, {
        serviceName: session.draft.serviceName,
      });
      if (customerName) {
        session.draft.customerName = customerName;
      }
    }
  }

  private async findServiceMatch(tenantId: string, rawText: string) {
    const services = await this.bookingCore.listServicesForConversation(tenantId);
    const normalizedText = this.normalize(rawText);
    if (!normalizedText) return null;

    return (
      services.find((service: any) => {
        const name = this.normalize(String(service?.name || ''));
        return name && (normalizedText.includes(name) || name.includes(normalizedText));
      }) || null
    );
  }

  private extractCustomerName(
    rawText: string,
    context?: { serviceName?: string },
  ): string | null {
    const text = String(rawText || '').trim();
    if (!text) return null;

    const explicitSource =
      text.match(
        /\b(?:ben|ad[ıi]m|ismim|ad soyad[ıi]m|adım soyadım)\s+([^,.;:]+)/i,
      )?.[1] || '';
    const explicitCandidate = this.cleanupNameCandidate(
      explicitSource,
      context?.serviceName,
    );
    if (explicitCandidate) {
      return explicitCandidate;
    }

    const compact = this.normalize(text);
    if (
      !this.looksLikeBookingIntent(text) &&
      !this.looksLikeInfoQuery(text) &&
      !this.extractDateTimeText(text) &&
      /^[a-zçğıöşü]+\s+[a-zçğıöşü]+(?:\s+[a-zçğıöşü]+)?$/i.test(compact)
    ) {
      return this.cleanupNameCandidate(text, context?.serviceName);
    }

    return null;
  }

  private extractDateTimeText(rawText: string): string | null {
    const text = String(rawText || '').trim();
    const normalized = this.normalize(text);
    if (!normalized) return null;

    const hasRelativeDay =
      /\b(bugun|bugün|yarin|yarın|pazartesi|sali|salı|carsamba|çarşamba|persembe|cuma|cumartesi|pazar)\b/.test(
        normalized,
      );
    const hasCalendarDate =
      /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/.test(text);
    const hasClockTime =
      /\b(?:saat\s*)?\d{1,2}[:.]\d{2}\b/.test(normalized) ||
      /\b\d{1,2}\b\s*(gibi|bucuk|buçuk)\b/.test(normalized);

    if (hasRelativeDay || hasCalendarDate || hasClockTime) {
      return text;
    }

    return null;
  }

  private looksLikeBookingIntent(rawText: string): boolean {
    const normalized = this.normalize(rawText);
    if (
      /\b(randevu|rezervasyon|olusturmak istiyorum|oluşturmak istiyorum|uygun musait|uygun müsait)\b/.test(
        normalized,
      )
    ) {
      return true;
    }

    const hasDateTime = Boolean(this.extractDateTimeText(rawText));
    if (!hasDateTime) return false;

    return /\b(icin|için|olur mu|musait|müsait)\b/.test(normalized);
  }

  private looksLikeInfoQuery(rawText: string): boolean {
    const normalized = this.normalize(rawText);
    return /\b(fiyat|ucret|ücret|adres|konum|lokasyon|nerede|calisma saati|çalışma saati|ne kadar)\b/.test(
      normalized,
    );
  }

  private isAffirmative(rawText: string): boolean {
    return /^(evet|olur|tamam|uygun|dogru|doğru|onayliyorum|onaylıyorum)$/i.test(
      this.normalize(rawText),
    );
  }

  private isNegative(rawText: string): boolean {
    return /^(hayir|hayır|yok|olmaz|yanlis|yanlış)$/i.test(
      this.normalize(rawText),
    );
  }

  private buildConfirmationPrompt(session: ChatConversationSession): string {
    const name = session.draft.customerName || '—';
    const serviceName = session.draft.serviceName || '—';
    const dateTimeText = session.draft.dateTimeText || '—';
    return `Özet: ${name}, ${serviceName}, ${dateTimeText}. Uygunsa onaylayayım mı?`;
  }

  private async completeCreate(
    session: ChatConversationSession,
    payload: AgentReplyRequest & { from: string; channel: string; source: string },
  ): Promise<string> {
    const startAt = this.bookingCore.parseDateTimeForConversation(
      session.draft.dateTimeText || '',
    );
    if (!startAt || !session.draft.customerName || !session.draft.serviceId) {
      session.state = 'LEGACY_FALLBACK';
      return this.legacyFallback(session, payload);
    }

    const created = await this.bookingCore.createBookingFromConversation({
      tenantId: payload.tenantId,
      customerPhone: payload.from,
      customerName: session.draft.customerName,
      serviceId: session.draft.serviceId,
      startAt,
      channel: 'WHATSAPP',
    });

    if (created.ok) {
      const serviceName = session.draft.serviceName || 'hizmet';
      this.resetSession(session);
      return `Tamamdır, ${serviceName} için randevunuzu oluşturdum.`;
    }

    if (created.code === 'OUT_OF_HOURS') {
      session.state = 'COLLECTING_DATETIME';
      return 'Bu saatlerde çalışmıyoruz. Lütfen başka bir gün veya saat yazın.';
    }

    if (created.code === 'SLOT_TAKEN') {
      session.state = 'COLLECTING_DATETIME';
      return 'O saat dolu görünüyor. Lütfen başka bir gün veya saat yazın.';
    }

    session.state = 'COLLECTING_DATETIME';
    return 'Randevu oluşturulamadı. Tarih ve saati tekrar yazar mısınız?';
  }

  private async legacyFallback(
    session: ChatConversationSession,
    payload: AgentReplyRequest & { from: string; channel: string; source: string },
  ): Promise<string> {
    session.state = 'LEGACY_FALLBACK';
    return this.bookingCore.replyText(payload);
  }

  private shouldUseLegacyFallback(
    session: ChatConversationSession,
    rawText: string,
  ): boolean {
    if (session.mode === 'BOOKING') return false;
    if (this.looksLikeInfoQuery(rawText) && !this.looksLikeBookingIntent(rawText)) {
      return true;
    }
    return !this.looksLikeBookingIntent(rawText);
  }

  private resetSession(
    session: ChatConversationSession,
    opts?: { preserveMode?: boolean },
  ) {
    session.mode = opts?.preserveMode ? session.mode : 'GENERAL';
    session.state = 'IDLE';
    session.lastUserText = undefined;
    session.draft = {};
    session.updatedAt = Date.now();
  }

  private cleanupNameCandidate(
    rawValue: string,
    serviceName?: string,
  ): string | null {
    const text = String(rawValue || '')
      .replace(/\b(randevu|rezervasyon|yarin|yarın|bugun|bugün|icin|için)\b.*$/i, '')
      .replace(/\b(saat\s*\d{1,2}[:.]\d{2}|\d{1,2}\s*(gibi|bucuk|buçuk))\b.*$/i, '')
      .trim();

    const parts = text
      .split(/\s+/)
      .map((part) => this.normalize(part))
      .filter(Boolean);

    if (parts.length < 2 || parts.length > 3) return null;
    if (parts.some((part) => this.fillerWords.has(part))) return null;
    if (parts.some((part) => part.length < 2)) return null;
    if (serviceName) {
      const normalizedService = this.normalize(serviceName);
      if (normalizedService && parts.join(' ').includes(normalizedService)) {
        return null;
      }
    }
    return this.toTitleCase(parts.join(' '));
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s:./-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toTitleCase(value: string): string {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) =>
        part.charAt(0).toLocaleUpperCase('tr-TR') +
        part.slice(1).toLocaleLowerCase('tr-TR'),
      )
      .join(' ');
  }
}
