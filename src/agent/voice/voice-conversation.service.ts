import { Injectable } from '@nestjs/common';
import { BookingCoreService } from '../shared/booking-core.service';
import { AgentReplyRequest } from '../shared/agent-types';
import { withAgentChannel } from '../shared/agent-helpers';

type VoiceConversationState =
  | 'IDLE'
  | 'COLLECTING_NAME'
  | 'COLLECTING_SERVICE'
  | 'COLLECTING_DATETIME'
  | 'WAITING_CONFIRMATION'
  | 'LEGACY_FALLBACK';

type VoiceBookingDraft = {
  customerName?: string;
  serviceId?: string;
  serviceName?: string;
  dateTimeText?: string;
};

type VoiceConversationSession = {
  key: string;
  tenantId: string;
  customerKey: string;
  state: VoiceConversationState;
  updatedAt: number;
  lastUserText?: string;
  draft: VoiceBookingDraft;
  bookingIntentActive: boolean;
};

@Injectable()
export class VoiceConversationService {
  private readonly sessions = new Map<string, VoiceConversationSession>();
  private readonly fillerWords = new Set([
    'evet',
    'hayir',
    'hayır',
    'tamam',
    'olur',
    'uygun',
    'merhaba',
    'selam',
    'alo',
    'tamamdir',
    'tamamdır',
    'tabi',
    'tabii',
    'peki',
    'tamamdir',
    'tesekkurler',
    'teşekkürler',
    'tesekkur ederim',
    'teşekkür ederim',
  ]);

  constructor(private readonly bookingCore: BookingCoreService) {}

  async prewarmVoiceContext(tenantId: string): Promise<void> {
    await this.bookingCore.prewarmVoiceContext(tenantId);
  }

  async handleTurn(payload: AgentReplyRequest): Promise<string> {
    const normalized = withAgentChannel(payload, 'voice');
    const session = this.getOrInitSession(normalized);
    const rawText = String(normalized.text || '').trim();

    session.lastUserText = rawText;
    session.updatedAt = Date.now();

    if (!rawText) {
      return 'Tekrar söyler misiniz?';
    }

    const deterministicReply = this.buildDeterministicShortReply(rawText);
    if (deterministicReply) {
      return deterministicReply;
    }

    if (!session.bookingIntentActive) {
      if (!this.looksLikeVoiceBookingIntent(rawText)) {
        return this.legacyFallback(session, normalized);
      }
      session.bookingIntentActive = true;
    }

    if (this.shouldUseInfoFallback(session, rawText)) {
      return this.legacyFallback(session, normalized);
    }

    if (session.state === 'WAITING_CONFIRMATION') {
      if (this.isAffirmative(rawText)) {
        return this.completeViaLegacyCreate(session, normalized);
      }
      if (this.isNegative(rawText)) {
        this.resetSession(session, { preserveBookingIntent: true });
        session.state = 'COLLECTING_SERVICE';
        return 'Tamam, yeniden başlayalım. Hangi işlem için randevu istiyorsunuz?';
      }
      return `${this.buildConfirmationPrompt(session)} Onaylıyorsanız evet, değiştirmek isterseniz hayır deyin.`;
    }

    await this.tryFillDraftFromTurn(session, rawText);

    if (!session.draft.customerName) {
      session.state = 'COLLECTING_NAME';
      return 'Ad soyadınızı alabilir miyim?';
    }

    if (!session.draft.serviceName) {
      session.state = 'COLLECTING_SERVICE';
      return 'Hangi işlem için randevu istiyorsunuz?';
    }

    if (!session.draft.dateTimeText) {
      session.state = 'COLLECTING_DATETIME';
      return 'Hangi gün ve saat uygun?';
    }

    session.state = 'WAITING_CONFIRMATION';
    return this.buildConfirmationPrompt(session);
  }

  private getOrInitSession(
    payload: AgentReplyRequest & { from: string; channel: string; source: string },
  ): VoiceConversationSession {
    const customerKey = String(
      payload.customerPhone || payload.from || payload.callId || 'unknown-voice',
    ).trim();
    const key = `${payload.tenantId}:${customerKey}`;
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const created: VoiceConversationSession = {
      key,
      tenantId: payload.tenantId,
      customerKey,
      state: 'IDLE',
      updatedAt: Date.now(),
      draft: {},
      bookingIntentActive: false,
    };
    this.sessions.set(key, created);
    return created;
  }

  private async tryFillDraftFromTurn(
    session: VoiceConversationSession,
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
      !this.looksLikeVoiceBookingIntent(text) &&
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

  private looksLikeVoiceBookingIntent(rawText: string): boolean {
    const normalized = this.normalize(rawText);
    if (
      /\b(randevu|rezervasyon|gelmek istiyorum|ayirtmak istiyorum|uygun musunuz|uygun mu)\b/.test(
        normalized,
      )
    ) {
      return true;
    }

    const hasDateTime = Boolean(this.extractDateTimeText(rawText));
    if (!hasDateTime) return false;

    return /\b(icin|için|olur mu|müsait|musait)\b/.test(normalized);
  }

  private looksLikeInfoQuery(rawText: string): boolean {
    const normalized = this.normalize(rawText);
    return /\b(fiyat|ucret|ücret|adres|konum|lokasyon|nerede|saat kac|kaçta acik|kaçta açık|calisma saati|çalışma saati|ne kadar)\b/.test(
      normalized,
    );
  }

  private isAffirmative(rawText: string): boolean {
    const normalized = this.normalize(rawText);
    return /^(evet|olur|tamam|uygun|dogru|doğru|onayliyorum|onaylıyorum)$/.test(
      normalized,
    );
  }

  private isNegative(rawText: string): boolean {
    const normalized = this.normalize(rawText);
    return /^(hayir|hayır|yok|olmaz|yanlis|yanlış)$/.test(normalized);
  }

  private buildConfirmationPrompt(session: VoiceConversationSession): string {
    const name = session.draft.customerName || '—';
    const serviceName = session.draft.serviceName || '—';
    const dateTimeText = session.draft.dateTimeText || '—';
    return `Özetliyorum: ${name}, ${serviceName}, ${dateTimeText}. Uygunsa onaylayayım mı?`;
  }

  private async completeViaLegacyCreate(
    session: VoiceConversationSession,
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
      callId: payload.callId,
      streamSid: payload.streamSid,
    });

    if (created.ok) {
      const serviceName = session.draft.serviceName || 'işlem';
      this.resetSession(session);
      return `Tamamdır, randevunuzu ${serviceName} için oluşturdum.`;
    }

    if (created.code === 'OUT_OF_HOURS') {
      session.state = 'COLLECTING_DATETIME';
      return 'Bu saatlerde çalışmıyoruz. Başka bir gün veya saat söyler misiniz?';
    }

    if (created.code === 'SLOT_TAKEN') {
      session.state = 'COLLECTING_DATETIME';
      return 'O saat dolu görünüyor. Başka bir gün veya saat söyler misiniz?';
    }

    session.state = 'COLLECTING_DATETIME';
    return 'Randevuyu oluşturamadım. Tarih ve saati tekrar söyler misiniz?';
  }

  private async legacyFallback(
    session: VoiceConversationSession,
    payload: AgentReplyRequest & { from: string; channel: string; source: string },
  ): Promise<string> {
    session.state = 'LEGACY_FALLBACK';
    return this.bookingCore.replyText(payload);
  }

  private resetDraft(session: VoiceConversationSession): void {
    session.draft = {};
  }

  private resetSession(
    session: VoiceConversationSession,
    opts?: { preserveBookingIntent?: boolean },
  ): void {
    session.state = 'IDLE';
    session.lastUserText = undefined;
    session.draft = {};
    session.bookingIntentActive = Boolean(opts?.preserveBookingIntent);
    session.updatedAt = Date.now();
  }

  private shouldUseInfoFallback(
    session: VoiceConversationSession,
    rawText: string,
  ): boolean {
    if (!this.looksLikeInfoQuery(rawText)) return false;
    const hasBookingSignal =
      this.looksLikeVoiceBookingIntent(rawText) ||
      Boolean(this.extractDateTimeText(rawText)) ||
      Boolean(session.draft.serviceName) ||
      Boolean(session.draft.dateTimeText);
    return !hasBookingSignal;
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

  private buildDeterministicShortReply(rawText: string): string | null {
    const text = this.normalize(rawText);
    if (!text) return null;

    const patterns = [
      /^sesim geliyor mu$/,
      /^beni duyuyor musunuz$/,
      /^sesim duyuluyor mu$/,
      /^ses geliyor mu$/,
      /^beni duyabiliyor musunuz$/,
    ];

    if (patterns.some((pattern) => pattern.test(text))) {
      return 'Evet, sizi duyuyorum.';
    }

    return null;
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
