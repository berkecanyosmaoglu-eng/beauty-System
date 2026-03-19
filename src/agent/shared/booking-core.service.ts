// Agent service for a multi‑tenant, sector agnostic booking platform
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';
import { detectLegacyGlobalIntent } from './legacy-conversation-routing';
import {
  buildCustomerNameCommitPatch,
  buildSuggestedServiceCleanupPatch,
  extractNameCandidate as extractName,
  detectServiceFromMessage,
  detectStaffFromMessage as detectStaffFromMessageHelper,
} from './agent-helpers';
import {
  buildDateTimeCommitPatch,
  buildPendingDateOnlyPatch,
  mergeDateOnlyWithExistingTime,
  mergePendingDateOnlyWithTime as mergePendingDateOnlyWithTimeHelper,
} from './booking-datetime-helpers';
import {
  formatBookingSuccess as formatBookingSuccessText,
  formatEditSuccess as formatEditSuccessText,
  humanizeAskTimeOnly as humanizeAskTimeOnlyText,
  humanizeConfirmNeedEH as humanizeConfirmNeedEHText,
} from './booking-presentation-policy';

// -----------------------------------------------------------------------------
// Global configuration constants
// These values centralize the configuration for session timeouts, suggestion
// validity windows, idempotency windows and LLM safety. Changing these in one
// place propagates the behaviour throughout the service.
// -----------------------------------------------------------------------------
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours session expiry
const SUGGESTION_TTL_MS = 20 * 60 * 1000; // suggestions live for 20 minutes
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000; // 10 minute idempotency window
const MAX_LLM_OUTPUT_LENGTH = 600; // maximum characters allowed from LLM
const VOICE_REFERENCE_CACHE_TTL_MS = 60 * 1000;

type BookingDraft = {
  tenantId: string;
  customerPhone: string;
  customerName?: string | null;
  channel?: 'VOICE' | 'WHATSAPP';
  messageSessionId?: string;
  callSessionId?: string;

  serviceId?: string;
  staffId?: string;

  /**
   * When the caller specifies a person by name that does not exist in our
   * current staff list we capture the raw spoken value here. This allows
   * downstream systems (e.g. front‑desk) to see who the caller asked for
   * without blocking the booking flow. If set, staffId will fall back to
   * the first available staff member.
   */
  requestedStaffName?: string;

  // ISO string (+03:00)
  startAt?: string;
};

enum WaState {
  IDLE = 'IDLE',

  // booking
  WAIT_SERVICE = 'BOOKING_INTENT_DETECTED',
  WAIT_NAME = 'BOOKING_INTENT_DETECTED',
  WAIT_DATETIME = 'AWAITING_DATETIME',
  WAIT_CONFIRM = 'AWAITING_CONFIRMATION',
  CONFIRMED = 'CONFIRMED',

  // edit (change/cancel)
  WAIT_APPT_PICK = 'WAIT_APPT_PICK',
  WAIT_EDIT_ACTION = 'WAIT_EDIT_ACTION',

  // info (list/show upcoming) follow-up
  WAIT_INFO_APPT_PICK = 'WAIT_INFO_APPT_PICK',
}

type HistoryTurn = {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
};

type SuggestionItem = {
  id?: string;
  label: string;
  value: string;
};

type Suggestions = {
  type: 'staff' | 'slot' | 'appt' | 'editAction';
  items: SuggestionItem[];
  ts: number;
};

type LearningProfile = {
  preferredServiceId?: string | null;
  preferredStaffId?: string | null;
  preferredTimeHint?: string | null;
  lastServiceId?: string | null;
  lastStaffId?: string | null;
  lastStartAt?: string | null;
  updatedAt?: number;
};

type SessionState = {
  state: WaState;
  draft: BookingDraft;

  pendingStartAt?: string;
  pendingDateOnly?: string; // YYYY-MM-DD (TR)
  pendingSummary?: string;

  updatedAt: number;
  history: HistoryTurn[];

  lastAssistantReply?: string;
  lastTopic?: string;
  lastServiceId?: string;
  lastServiceName?: string;
  recentStaffId?: string;
  recentIntentContext?: 'booking' | 'info';
  bookingDraftSnapshot?: {
    serviceId?: string;
    staffId?: string;
    startAt?: string;
    updatedAt: number;
  };
  repeatCount?: number;

  lastUserTextNorm?: string;
  lastUserAt?: number;

  lastCreatedBookingKey?: string;
  lastCreatedAppointmentId?: string;
  lastCreatedAt?: number;

  lastSuggestions?: Suggestions;

  /**
   * Base ISO datetime for the appointment being edited. When only a new time (HH:MM)
   * is provided during rescheduling, we preserve the original date from this value
   * rather than relying on the draft which may have changed. This prevents the
   * “wrong date” bug when editing an appointment after another edit has occurred.
   */
  editBaseStartAtIso?: string;

  /**
   * When cancelling multiple appointments (e.g. “hepsi”/“tümü”), this holds the
   * list of appointment IDs to cancel. If set, editMode will still be CANCEL
   * but safeCancelMultipleAppointments() will be used.
   */
  cancelAllIds?: string[];

  learningProfile?: LearningProfile;
  learningLoadedAt?: number;

  suggestedServiceId?: string;
  suggestedServiceName?: string;

  lastAssistantText?: string;

  // ✅ Edit flow (change/cancel)
  editMode?: 'RESCHEDULE' | 'CANCEL';
  targetAppointmentId?: string;
  targetApptSnapshot?: {
    serviceId: string;
    staffId: string;
    startAtIso: string;
    serviceName?: string;
    staffName?: string;
  };

  lastBookingContext?: {
    startAtIso?: string;
    serviceName?: string;
    staffName?: string;
    customerName?: string;
  };
};

type LearnedCustomerContext = {
  customerId?: string;
  name?: string | null;
  summary?: string;
  topServiceId?: string;
  topServiceName?: string;
};

type ContinuityResolution = {
  preservedIntent?: SessionState['recentIntentContext'];
  inferredBookingContinuation: boolean;
  usedRecentService: boolean;
  usedRecentStaff: boolean;
  usedAssistantSuggestion: boolean;
  usedDraftSnapshot: boolean;
  shortFollowUp: boolean;
};

type UpcomingAppt = {
  id: string;
  serviceId: string;
  staffId: string;
  date: Date;
  time: string;
  startAtIso: string;
  serviceName?: string;
  staffName?: string;
};

type GlobalIntent =
  | 'NEW_BOOKING'
  | 'LIST_APPOINTMENTS'
  | 'MY_APPOINTMENT_TIME'
  | 'RESCHEDULE_BOOKING'
  | 'CANCEL_BOOKING'
  | 'FAQ_GENERAL'
  | 'UNKNOWN';

@Injectable()
export class BookingCoreService {
  private readonly logger = new Logger(BookingCoreService.name);
  private readonly openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  constructor(private readonly prisma: PrismaService) {}

  async prewarmVoiceContext(tenantId: string): Promise<void> {
    try {
      const businessPromise = this.safeGetBusinessProfile(tenantId);
      const servicesPromise = this.safeListServices(tenantId);
      const staffPromise = this.safeListStaff(tenantId);

      await Promise.all([businessPromise, servicesPromise, staffPromise]);
    } catch (err) {
      this.logger?.warn?.(
        `[voice] prewarmVoiceContext failed tenantId=${tenantId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async listServicesForConversation(tenantId: string): Promise<any[]> {
    return this.safeListServices(tenantId);
  }

  parseDateTimeForConversation(rawText: string): string | null {
    const parsed = parseDateTimeTR(String(rawText || '').trim());
    if (!parsed?.hasDate || !parsed?.hasTime) {
      return null;
    }
    return toIstanbulIso(clampToFuture(parsed.dateUtc));
  }

  async createBookingFromConversation(input: {
    tenantId: string;
    customerPhone: string;
    customerName: string;
    serviceId: string;
    startAt: string;
    channel?: 'VOICE' | 'WHATSAPP';
    callId?: string;
    streamSid?: string;
  }): Promise<
    | { ok: true; appointmentId: string; startAt: string }
    | {
        ok: false;
        code?: string;
        suggestions?: Array<{ startAt: string; endAt: string }>;
      }
  > {
    const draft: BookingDraft = {
      tenantId: input.tenantId,
      customerPhone: String(input.customerPhone || '').trim(),
      customerName: String(input.customerName || '').trim() || null,
      channel: input.channel || 'VOICE',
      callSessionId:
        input.channel === 'WHATSAPP'
          ? undefined
          : String(input.callId || input.streamSid || '').trim() || undefined,
      serviceId: String(input.serviceId || '').trim(),
      startAt: String(input.startAt || '').trim(),
    };

    const staffFallbackList = await this.safeListStaff(input.tenantId);
    const created = await this.createAppointment({
      tenantId: input.tenantId,
      draft,
      staffFallbackList,
    });

    if (!created.ok) {
      return created;
    }

    return {
      ok: true,
      appointmentId: created.data.appointmentId,
      startAt: created.data.startAt,
    };
  }

  /**
   * Structured logging helper. Emits JSON logs for key actions with context.
   * Logs include the action name and any additional contextual fields passed
   * in the data object. If JSON serialization fails it falls back to
   * concatenated key/value logging.
   */
  private logAction(action: string, data: Record<string, any> = {}): void {
    try {
      this.logger.log(JSON.stringify({ action, ...data }));
    } catch (err) {
      this.logger.log(`[${action}] ${JSON.stringify(data)}`);
    }
  }

  /**
   * Sanitizes LLM outputs by removing URLs and truncating long strings. This
   * prevents prompt injection attacks and ensures that responses stay within
   * safe length limits defined by MAX_LLM_OUTPUT_LENGTH.
   */
  private sanitizeLlmOutput(text: string): string {
    let out = (text || '').replace(/https?:\/\/\S+/gi, '').trim();
    if (out.length > MAX_LLM_OUTPUT_LENGTH) {
      out = out.slice(0, MAX_LLM_OUTPUT_LENGTH) + '…';
    }
    return out;
  }

  private sessions = new Map<string, SessionState>();
  private readonly voiceReferenceCache = new Map<
    string,
    { expiresAt: number; value: any }
  >();

  // =========================
  // ✅ mini metin motoru
  // =========================
  private pickOne(list: string[], seedText?: string) {
    if (!list?.length) return '';
    const seed = normalizeTr(seedText || '') || String(Date.now());
    let h = 0;
    for (let i = 0; i < seed.length; i++)
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return list[h % list.length];
  }

  private softYesNoHint(seed?: string) {
    return this.pickOne(
      [
        'Onaylıyor musun?',
        'Tamam mı, onaylayayım mı?',
        'Bunu böyle kaydediyorum, doğru mu?',
      ],
      seed,
    );
  }

  private humanizeAsk(kind: 'service' | 'name' | 'datetime', seed?: string) {
    // Voice‑friendly prompts. Remove emojis and keep questions short and clear.
    if (kind === 'service') {
      return this.pickOne(
        [
          'Hangi hizmet için randevu oluşturalım?',
          'Hangi hizmeti istersiniz?',
          'Hangi işlem için yardımcı olayım?',
        ],
        seed,
      );
    }
    if (kind === 'name') {
      return this.pickOne(
        [
          'Randevuyu kimin adına yazalım? Ad soyad lütfen.',
          'İsminizi alabilir miyim? Ad soyad yeterli.',
        ],
        seed,
      );
    }
    // datetime
    return this.pickOne(
      [
        "Hangi gün ve saatte randevu istersiniz? Örneğin: 'yarın 16:00'.",
        "Ne zamana ayarlayalım? Örneğin: 'Salı 15:30' ya da 'yarın 16:00'.",
        "Gün ve saat alayım. Örneğin: 'yarın 16:00'.",
      ],
      seed,
    );
  }

  private humanizeAskTimeOnly(seed?: string) {
    return humanizeAskTimeOnlyText(seed);
  }
  private humanizeConfirmNeedEH(seed?: string) {
    return humanizeConfirmNeedEHText(seed);
  }

  private formatBookingSuccess(
    startAtIso: string,
    apptId: string,
    seed?: string,
  ) {
    return formatBookingSuccessText();
  }

  private formatEditSuccess(startAtIso: string, apptId: string, seed?: string) {
    return formatEditSuccessText(prettyIstanbul(startAtIso), apptId, seed);
  }

  private runReplyPrelude(opts: {
    session: SessionState;
    tenantId: string;
    from: string;
    raw: string;
    msg: string;
    isVoice: boolean;
    messageSessionId?: string;
    callId?: string;
    streamSid?: string;
  }): {
    shouldReturnEarly: boolean;
    reply: string;
    useSafeReply: boolean;
    contextualBookingFollowUp: boolean;
  } {
    const {
      session,
      tenantId,
      from,
      raw,
      msg,
      isVoice,
      messageSessionId,
      callId,
      streamSid,
    } = opts;

    session.draft.customerPhone = from;
    session.draft.channel = isVoice ? 'VOICE' : 'WHATSAPP';
    if (isVoice) {
      session.draft.callSessionId = String(
        callId || streamSid || session.draft.callSessionId || '',
      ).trim();
      session.draft.messageSessionId = undefined;
    } else {
      session.draft.messageSessionId = String(
        messageSessionId || session.draft.messageSessionId || `${tenantId}:${from}`,
      ).trim();
      session.draft.callSessionId = undefined;
    }

    this.logAction('incoming', {
      tenantId,
      phone: from,
      state: session.state,
      text: raw,
    });

    if (this.isLikelyDuplicateInbound(session, raw)) {
      return {
        shouldReturnEarly: true,
        reply: session.lastAssistantReply || session.lastAssistantText || 'Tamam 👍',
        useSafeReply: true,
        contextualBookingFollowUp: false,
      };
    }

    if (isVoice && this.isLikelyAssistantEcho(session, raw)) {
      this.logAction('assistant_echo_ignored', {
        tenantId,
        phone: from,
        text: raw,
      });
      return {
        shouldReturnEarly: true,
        reply: '',
        useSafeReply: false,
        contextualBookingFollowUp: false,
      };
    }

    this.recordHistory(session, 'user', raw);
    const contextualBookingFollowUp = this.isContextualBookingFollowUp(
      session,
      raw,
      isVoice,
    );

    if (looksLikeBookingIntent(raw) || contextualBookingFollowUp)
      session.recentIntentContext = 'booking';
    else if (
      looksLikePriceQuestion(msg) ||
      looksLikeServiceListRequest(msg) ||
      looksLikeAddressOrHours(msg)
    )
      session.recentIntentContext = 'info';
    else if (!this.shouldPreserveRecentIntentContext(session, raw))
      session.recentIntentContext = undefined;

    return {
      shouldReturnEarly: false,
      reply: '',
      useSafeReply: true,
      contextualBookingFollowUp,
    };
  }

  private async handleLegacyBookingEntry(opts: {
    key: string;
    session: SessionState;
    tenantId: string;
    from: string;
    raw: string;
    services: any[];
    staff: any[];
    business: any;
    globalIntent: GlobalIntent;
    contextualBookingFollowUp: boolean;
  }): Promise<{ handled: boolean; reply: string }> {
    const {
      key,
      session,
      tenantId,
      from,
      raw,
      services,
      staff,
      business,
      globalIntent,
      contextualBookingFollowUp,
    } = opts;

    if (
      globalIntent !== 'NEW_BOOKING' &&
      !looksLikeBookingIntent(raw) &&
      !contextualBookingFollowUp
    ) {
      return { handled: false, reply: '' };
    }

    const svc = this.detectServiceFromMessage(raw, services);
    if (svc?.id) session.draft.serviceId = String(svc.id);
    if (svc?.name) session.lastServiceName = String(svc.name);
    session.recentIntentContext = 'booking';

    if (
      !svc?.id &&
      !this.isGenericBookingIntentWithoutService(raw, services) &&
      this.hasExplicitUnknownServiceRequest(raw, services)
    ) {
      this.logAction('unknown_service_detected', {
        tenantId,
        phone: from,
        raw,
      });
      return {
        handled: true,
        reply:
          'Bu isimde bir hizmetimizi bulamadım. İsterseniz mevcut işlemlerimizden birini söyleyebilirsiniz.',
      };
    }

    const parsed = parseDateTimeTR(raw);
    if (parsed?.hasTime) {
      session.pendingStartAt = toIstanbulIso(clampToFuture(parsed.dateUtc));
      if (!session.draft.startAt && session.pendingStartAt)
        session.draft.startAt = session.pendingStartAt;
      session.pendingDateOnly = undefined;
    } else if (parsed?.dateOnly) {
      session.pendingDateOnly = parsed.dateOnly;
    }

    if (!isNoPreferenceStaff(raw))

    if (
      !session.draft.serviceId &&
      (this.hasStrongCarryoverServiceCue(raw) || contextualBookingFollowUp)
    ) {
      this.tryCarryRecentServiceContext(session, services);
    }

    if (!session.draft.serviceId) {
      session.state = WaState.WAIT_SERVICE;
      this.saveSession(key, session);
      return {
        handled: true,
        reply: await this.naturalAsk(session, 'service', {
          services,
          staff,
          business,
        }),
      };
    }

    session.state = WaState.WAIT_DATETIME;
    this.saveSession(key, session);
    return {
      handled: true,
      reply: await this.naturalAsk(session, 'datetime', {
        services,
        staff,
        business,
      }),
    };
  }

  private handleLegacyDeterministicInfoEntry(opts: {
    session: SessionState;
    raw: string;
    msg: string;
    services: any[];
    business: any;
    isVoice: boolean;
  }): { handled: boolean; reply: string } {
    const { session, raw, msg, services, business, isVoice } = opts;

    if (looksLikePriceQuestion(msg)) {
      const svc = this.resolveServiceForVoiceFollowUp(
        session,
        raw,
        services,
        isVoice,
      );
      if (svc) {
        const name = String(svc.name || 'Hizmet');
        const price = svc.price ?? null;
        const dur = svc.duration ?? null;

        const parts: string[] = [];
        if (price != null) parts.push(`${name} fiyatı: ${price}₺`);
        else
          parts.push(`${name} için fiyat bilgisi henüz eklenmemiş görünüyor.`);
        if (dur != null) parts.push(`Süre: ${dur} dk`);

        const nudge = this.shouldNudgeBooking(session)
          ? '\nİstersen “randevu oluştur” diyebilirsin, hemen ayarlayalım.'
          : '';
        return { handled: true, reply: parts.join(' • ') + nudge };
      }
      return {
        handled: true,
        reply: 'Hangi hizmetin fiyatını soruyorsun? (Örn: “Hizmet adı fiyatı”)',
      };
    }

    if (looksLikeServiceListRequest(msg)) {
      const list = servicesToTextShort(services, {
        limit: isVoice ? 4 : 6,
        compact: isVoice,
      });
      if (!list) {
        return {
          handled: true,
          reply: 'Şu an hizmet listem görünmüyor 😕 Birazdan tekrar dener misin?',
        };
      }
      return {
        handled: true,
        reply: isVoice
          ? `Sunabildiğimiz işlemlerden bazıları: ${list}. Hangisi için randevu istersiniz?`
          : `Hizmetlerimiz:\n${list}`,
      };
    }

    if (looksLikeAddressOrHours(msg)) {
      const addr =
        business?.address || business?.fullAddress || business?.location || null;
      const parts: string[] = [];
      if (addr) parts.push(`📍 Adres: ${String(addr)}`);
      parts.push(`⏰ Çalışma saatleri: Her gün 08:00 - 22:00`);
      return { handled: true, reply: parts.join('\n') };
    }

    return { handled: false, reply: '' };
  }

  private async handleLegacyProcedureLlmEntry(opts: {
    session: SessionState;
    raw: string;
    msg: string;
    services: any[];
    staff: any[];
    business: any;
    isVoice: boolean;
    learnedCustomerSummary: string;
  }): Promise<{ handled: boolean; reply: string }> {
    const {
      session,
      raw,
      msg,
      services,
      staff,
      business,
      isVoice,
      learnedCustomerSummary,
    } = opts;

    if (!looksLikeProcedureQuestion(msg)) {
      return { handled: false, reply: '' };
    }

    const svc = this.resolveServiceForVoiceFollowUp(
      session,
      raw,
      services,
      isVoice,
    );
    session.lastTopic = 'procedure';
    session.lastServiceId = svc && svc.id ? String(svc.id) : undefined;

    let out = await this.answerWithLLM({
      raw,
      business,
      services,
      staff,
      history: this.getRecentHistory(session, 8),
      mode: 'procedure',
      focusService: svc
        ? {
            name: String(svc.name || ''),
            duration: svc.duration,
            price: svc.price,
          }
        : null,
      learnedCustomerSummary,
    });

    if (!out) {
      return {
        handled: true,
        reply: svc
          ? this.procedureTemplateForService(
              String(svc.name || ''),
              svc.duration,
              svc.price,
            )
          : 'Genel olarak süreç hizmetin türüne göre değişir. Hangi işlem veya hizmet için soruyorsun?',
      };
    }

    if (
      session.lastAssistantReply &&
      normalizeTr(session.lastAssistantReply) === normalizeTr(out)
    ) {
      const alt = await this.answerWithLLM({
        raw,
        business,
        services,
        staff,
        history: this.getRecentHistory(session, 8),
        mode: 'procedure',
        focusService: svc
          ? {
              name: String(svc.name || ''),
              duration: svc.duration,
              price: svc.price,
            }
          : null,
        avoidRepeat: true,
        learnedCustomerSummary,
      });
      if (
        alt &&
        normalizeTr(alt) !== normalizeTr(session.lastAssistantReply || '')
      )
        out = alt;
      else
        out = 'Tam olarak hangi hizmet veya konu hakkında bilgi almak istiyorsunuz?';
    }

    return { handled: true, reply: out };
  }

  private async handleLegacyGeneralLlmFallback(opts: {
    session: SessionState;
    raw: string;
    services: any[];
    staff: any[];
    business: any;
    learnedCustomerSummary: string;
  }): Promise<string> {
    const { session, raw, services, staff, business, learnedCustomerSummary } =
      opts;

    session.lastTopic = 'general';

    let llmAnswer = await this.answerWithLLM({
      raw,
      business,
      services,
      staff,
      history: this.getRecentHistory(session, 8),
      mode: 'general',
      focusService: null,
      learnedCustomerSummary,
    });

    if (!llmAnswer) llmAnswer = '';

    if (
      llmAnswer &&
      session.lastAssistantReply &&
      normalizeTr(session.lastAssistantReply) === normalizeTr(llmAnswer)
    ) {
      const alt = await this.answerWithLLM({
        raw,
        business,
        services,
        staff,
        history: this.getRecentHistory(session, 8),
        mode: 'general',
        focusService: null,
        avoidRepeat: true,
        learnedCustomerSummary,
      });
      llmAnswer =
        alt && normalizeTr(alt) !== normalizeTr(session.lastAssistantReply || '')
          ? alt
          : 'Tam olarak ne öğrenmek istiyorsunuz?';
    }

    return llmAnswer || 'Anlayamadım 😕 İstersen ne yapmak istediğini kısaca söyle.';
  }

  private async handleLegacyAppointmentInfoFollowUp(opts: {
    key: string;
    session: SessionState;
    tenantId: string;
    from: string;
    raw: string;
  }): Promise<{ handled: boolean; reply: string }> {
    const { key, session, tenantId, from, raw } = opts;
    if (session.state !== WaState.WAIT_INFO_APPT_PICK) {
      return { handled: false, reply: '' };
    }

    const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 9);
    if (!list?.length) {
      this.softResetSession(session, tenantId, from, {
        keepIdempotency: true,
      });
      this.saveSession(key, session);
      return { handled: true, reply: 'Şu an görünen bir randevun yok 🙂' };
    }

    const tHepsi2 = normalizeTr(raw);
    if (
      (tHepsi2.includes('hepsi') ||
        tHepsi2.includes('hepsini') ||
        tHepsi2.includes('tum') ||
        tHepsi2.includes('tumu') ||
        tHepsi2.includes('tümünü')) &&
      list.length
    ) {
      session.editMode = 'CANCEL';
      session.cancelAllIds = list.map((a) => String(a.id));
      session.pendingSummary = `Toplam ${list.length} randevunuz var. Hepsini iptal etmek istediğinize emin misiniz?`;
      session.state = WaState.WAIT_CONFIRM;
      this.saveSession(key, session);
      return {
        handled: true,
        reply: `${session.pendingSummary}\n${this.softYesNoHint(from + 'all')}`,
      };
    }

    const parsedInfo = parseDateTimeTR(raw);
    if (parsedInfo?.hasDate && !parsedInfo.hasTime) {
      const dateOnly = parsedInfo.dateOnly;
      if (dateOnly) {
        const hits = list.filter((a) => this.isSameTrDate(a.startAtIso, dateOnly));
        if (hits.length === 1) {
          const a = hits[0];
          this.softResetSession(session, tenantId, from, {
            keepIdempotency: true,
          });
          this.saveSession(key, session);
          return {
            handled: true,
            reply:
              `Randevun şurada görünüyor:\n` +
              `• ${prettyIstanbul(a.startAtIso)}` +
              (a.serviceName ? ` • ${a.serviceName}` : '') +
              (a.staffName ? ` • ${a.staffName}` : ''),
          };
        }
      }
    }

    const picked = this.pickFromSuggestions(session, raw);
    let apptId = picked?.type === 'appt' ? picked.apptId : '';
    if (!apptId) {
      const ord = extractOrdinal1to9(raw);
      if (ord != null) {
        const idx = Math.max(0, Math.min(8, ord - 1));
        apptId = list[idx]?.id ? String(list[idx].id) : '';
      }
    }

    const chosen = list.find((a) => String(a.id) === String(apptId)) || null;
    if (!chosen) {
      session.lastSuggestions = {
        type: 'appt',
        items: list.slice(0, 9).map((a) => ({
          label: `${prettyIstanbul(a.startAtIso)}${a.serviceName ? ` • ${a.serviceName}` : ''}${a.staffName ? ` • ${a.staffName}` : ''}`,
          value: String(a.id),
        })),
        ts: Date.now(),
      };
      const lines = session.lastSuggestions.items
        .map((it, i) => `${i + 1}) ${it.label}`)
        .join('\n');
      this.saveSession(key, session);
      return {
        handled: true,
        reply: `Şu randevularını görüyorum:\n${lines}\n\nHangisi? 1-9 söylemen yeterli 🙂`,
      };
    }

    this.softResetSession(session, tenantId, from, {
      keepIdempotency: true,
    });
    this.saveSession(key, session);
    return {
      handled: true,
      reply:
        `Randevun şurada görünüyor:\n` +
        `• ${prettyIstanbul(chosen.startAtIso)}` +
        (chosen.serviceName ? ` • ${chosen.serviceName}` : '') +
        (chosen.staffName ? ` • ${chosen.staffName}` : ''),
    };
  }

  private async handleLegacyUpcomingAppointmentEntry(opts: {
    key: string;
    session: SessionState;
    tenantId: string;
    from: string;
    raw: string;
    globalIntent: GlobalIntent;
    voiceBookingIntentOverride: boolean;
  }): Promise<{ handled: boolean; reply: string }> {
    const {
      key,
      session,
      tenantId,
      from,
      raw,
      globalIntent,
      voiceBookingIntentOverride,
    } = opts;

    if (
      !(
        (!voiceBookingIntentOverride && looksLikeUpcomingQuery(raw)) ||
        globalIntent === 'LIST_APPOINTMENTS' ||
        globalIntent === 'MY_APPOINTMENT_TIME'
      )
    ) {
      return { handled: false, reply: '' };
    }

    const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 6);
    if (!list?.length) {
      return { handled: true, reply: 'Şu an görünen bir randevun yok 🙂' };
    }

    if (list.length === 1) {
      const a = list[0];
      return {
        handled: true,
        reply:
          `Randevun şurada görünüyor:\n` +
          `• ${prettyIstanbul(a.startAtIso)}` +
          (a.serviceName ? ` • ${a.serviceName}` : '') +
          (a.staffName ? ` • ${a.staffName}` : ''),
      };
    }

    session.state = WaState.WAIT_INFO_APPT_PICK;
    session.lastSuggestions = {
      type: 'appt',
      items: list.slice(0, 9).map((a) => ({
        label: `${prettyIstanbul(a.startAtIso)}${a.serviceName ? ` • ${a.serviceName}` : ''}${a.staffName ? ` • ${a.staffName}` : ''}`,
        value: String(a.id),
      })),
      ts: Date.now(),
    };
    this.saveSession(key, session);

    const lines = session.lastSuggestions.items
      .map((it, i) => `${i + 1}) ${it.label}`)
      .join('\n');
    return {
      handled: true,
      reply: `Randevuların:\n${lines}\n\nHangisiyle ilgiliydi? 1-9 söyleyebilir ya da “yarın/bugün” diyebilirsin 🙂`,
    };
  }

  private async handleLegacyEditOrCancelEntry(opts: {
    key: string;
    session: SessionState;
    tenantId: string;
    from: string;
    raw: string;
    globalIntent: GlobalIntent;
    voiceBookingIntentOverride: boolean;
  }): Promise<{ handled: boolean; reply: string }> {
    const {
      key,
      session,
      tenantId,
      from,
      raw,
      globalIntent,
      voiceBookingIntentOverride,
    } = opts;

    const explicitEditIntent =
      !voiceBookingIntentOverride &&
      (globalIntent === 'CANCEL_BOOKING' ||
        globalIntent === 'RESCHEDULE_BOOKING' ||
        looksLikeCancelIntent(raw) ||
        looksLikeRescheduleIntent(raw) ||
        looksLikeGenericEditIntent(raw));
    const explicitNewBookingIntent = looksLikeBookingIntent(raw) && !explicitEditIntent;
    if (!explicitEditIntent || explicitNewBookingIntent) {
      return { handled: false, reply: '' };
    }

    const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 6);
    if (!list?.length) {
      return { handled: true, reply: 'Görünen bir randevunuz yok 🙂' };
    }

    if (list.length === 1) {
      const a = list[0];

      session.targetAppointmentId = String(a.id);
      session.targetApptSnapshot = {
        serviceId: String(a.serviceId),
        staffId: String(a.staffId),
        startAtIso: String(a.startAtIso),
        serviceName: a.serviceName,
        staffName: a.staffName,
      };
      session.editBaseStartAtIso = String(a.startAtIso);
      session.draft.serviceId = String(a.serviceId);
      session.draft.staffId = String(a.staffId);
      session.draft.startAt = String(a.startAtIso);

      if (looksLikeCancelIntent(raw)) {
        session.editMode = 'CANCEL';
        session.pendingSummary = this.buildEditCancelSummary(
          session.targetApptSnapshot,
        );
        session.state = WaState.WAIT_CONFIRM;
        this.saveSession(key, session);
        return {
          handled: true,
          reply: `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`,
        };
      }

      const tNorm = normalizeTr(raw);
      const onlyTime = parseTimeBest(tNorm);
      const parsed = parseDateTimeTR(raw);

      if (onlyTime && !hasExplicitDateMarker(tNorm)) {
        const baseIso = session.editBaseStartAtIso || String(a.startAtIso);
        const iso = buildIsoWithSameDate(baseIso, onlyTime.hh, onlyTime.mm);
        if (iso) {
          session.editMode = 'RESCHEDULE';
          session.draft.startAt = iso;

          const pre = await this.precheckAndPrepareConfirm({
            tenantId,
            draft: session.draft,
            ignoreAppointmentId: session.targetAppointmentId,
          });

          if (!pre.ok) {
            session.draft.startAt = String(a.startAtIso);
            session.state = WaState.WAIT_DATETIME;
            this.saveSession(key, session);
            return {
              handled: true,
              reply: 'O saati ayarlayamadım 😕 Başka bir saat söyler misin?',
            };
          }

          session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
          session.state = WaState.WAIT_CONFIRM;
          this.saveSession(key, session);
          return {
            handled: true,
            reply: `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`,
          };
        }
      }

      if (parsed?.hasTime) {
        const iso = toIstanbulIso(clampToFuture(parsed.dateUtc));
        session.editMode = 'RESCHEDULE';
        session.draft.startAt = iso;

        const pre = await this.precheckAndPrepareConfirm({
          tenantId,
          draft: session.draft,
          ignoreAppointmentId: session.targetAppointmentId,
        });

        if (!pre.ok) {
          session.draft.startAt = String(a.startAtIso);
          session.state = WaState.WAIT_DATETIME;
          this.saveSession(key, session);
          return {
            handled: true,
            reply: 'O zamanı ayarlayamadım 😕 Başka bir tarih/saat söyler misin?',
          };
        }

        session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
        session.state = WaState.WAIT_CONFIRM;
        this.saveSession(key, session);
        return {
          handled: true,
          reply: `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`,
        };
      }

      if (parsed?.dateOnly) {
        session.editMode = 'RESCHEDULE';
        session.pendingDateOnly = parsed.dateOnly;
        session.state = WaState.WAIT_DATETIME;
        this.saveSession(key, session);
        return {
          handled: true,
          reply: this.humanizeAskTimeOnly(raw),
        };
      }

      session.state = WaState.WAIT_EDIT_ACTION;
      this.saveSession(key, session);
      return {
        handled: true,
        reply: this.askEditActionMenu(session, a),
      };
    }

    const tInline = normalizeTr(raw);
    const mPick = tInline.match(/^\s*([1-9])\s*[\.\)\-:]?/);
    const parsedInline = parseDateTimeTR(raw);
    const onlyTimeInline = parseTimeBest(tInline);

    if (mPick && (parsedInline?.hasTime || onlyTimeInline)) {
      const idx = Math.max(0, Math.min(8, Number(mPick[1]) - 1));
      const chosen = list[idx];

      if (chosen) {
        session.targetAppointmentId = String(chosen.id);
        session.targetApptSnapshot = {
          serviceId: String(chosen.serviceId),
          staffId: String(chosen.staffId),
          startAtIso: String(chosen.startAtIso),
          serviceName: chosen.serviceName,
          staffName: chosen.staffName,
        };
        session.editBaseStartAtIso = String(chosen.startAtIso);
        session.draft.serviceId = String(chosen.serviceId);
        session.draft.staffId = String(chosen.staffId);

        if (looksLikeCancelIntent(raw)) {
          session.editMode = 'CANCEL';
          session.pendingSummary = this.buildEditCancelSummary(
            session.targetApptSnapshot,
          );
          session.state = WaState.WAIT_CONFIRM;
          return {
            handled: true,
            reply: `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`,
          };
        }

        let iso: string | null = null;
        if (onlyTimeInline && !hasExplicitDateMarker(tInline)) {
          const baseIso = session.editBaseStartAtIso || String(chosen.startAtIso);
          iso = buildIsoWithSameDate(baseIso, onlyTimeInline.hh, onlyTimeInline.mm);
        } else if (parsedInline?.hasTime) {
          iso = toIstanbulIso(clampToFuture(parsedInline.dateUtc));
        }

        if (iso) {
          session.editMode = 'RESCHEDULE';
          session.draft.startAt = iso;

          const pre = await this.precheckAndPrepareConfirm({
            tenantId,
            draft: session.draft,
            ignoreAppointmentId: session.targetAppointmentId,
          });

          if (!pre.ok) {
            session.draft.startAt = String(chosen.startAtIso);
            session.state = WaState.WAIT_DATETIME;
            this.saveSession(key, session);
            return {
              handled: true,
              reply: 'O saat dolu gibi 😕 Başka bir saat söyler misin?',
            };
          }

          session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
          session.state = WaState.WAIT_CONFIRM;
          this.saveSession(key, session);
          return {
            handled: true,
            reply: `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`,
          };
        }
      }
    }

    session.state = WaState.WAIT_APPT_PICK;
    this.saveSession(key, session);
    return {
      handled: true,
      reply: this.askAppointmentPickMenu(session, list),
    };
  }

  // =========================
  // MAIN
  // =========================
  async replyText(opts: {
    tenantId: string;
    from: string;
    text: string;
    channel?: string;
    source?: string;
    messageSessionId?: string;
    callId?: string;
    streamSid?: string;
  }): Promise<string> {
    const { tenantId, from } = opts;
    const raw = (opts.text ?? '').trim();
    const msg = normalizeTr(raw);

    const isVoice =
      String(opts.channel || opts.source || '').toLowerCase() === 'voice';
    const key = `${tenantId}:${from}`;
    const session = this.getOrInitSession(key, tenantId, from);
    const prelude = this.runReplyPrelude({
      session,
      tenantId,
      from,
      raw,
      msg,
      isVoice,
      messageSessionId: opts.messageSessionId,
      callId: opts.callId,
      streamSid: opts.streamSid,
    });
    if (prelude.shouldReturnEarly) {
      return prelude.useSafeReply
        ? this.safeReply(session, prelude.reply)
        : prelude.reply;
    }
    const { contextualBookingFollowUp } = prelude;

    // ====================================================
    // Follow-up memory: if the caller asks about the recent reservation, answer without starting a new booking flow
    // Recognize queries such as "Randevuyu oluşturdun mu?", "Hangi saate aldık?", "Ben neye randevu aldım?", "Kimleydi?".
    try {
      const q = normalizeTr(raw);
      if ((session as any).lastBookingSummary) {
        const followKeywords = ['randevu', 'rezervasyon'];
        const questionKeywords = [
          'olustur',
          'oluştur',
          'saat',
          'hangi',
          'kim',
          'ne',
          'kimin',
        ];
        const hasFollow = followKeywords.some((k) => q.includes(k));
        const hasQuestion = questionKeywords.some((k) => q.includes(k));
        if (hasFollow && hasQuestion) {
          const ctx = session.lastBookingContext;
          if (
            ctx?.startAtIso &&
            (q.includes('saat') ||
              q.includes('hangi saate') ||
              q.includes('kacta') ||
              q.includes('kaçta'))
          ) {
            return this.safeReply(
              session,
              `Randevunuz ${prettyIstanbul(ctx.startAtIso)} olarak görünüyor.`,
            );
          }
          if (
            ctx?.staffName &&
            (q.includes('kimle') ||
              q.includes('kimleydi') ||
              q.includes('kiminle'))
          ) {
            return this.safeReply(
              session,
              `Randevunuz ${ctx.staffName} ile görünüyor.`,
            );
          }
          if (
            ctx?.serviceName &&
            (q.includes('hangi hizmet') ||
              q.includes('neye') ||
              q.includes('hangi islem') ||
              q.includes('hangi işlem'))
          ) {
            return this.safeReply(
              session,
              `Hizmetiniz ${ctx.serviceName} olarak görünüyor.`,
            );
          }
          return this.safeReply(
            session,
            (session as any).lastBookingSummary as string,
          );
        }
      }
    } catch (err) {
      // Ignore follow-up detection errors
    }

    try {
      const legacyAppointmentInfoFollowUp =
        await this.handleLegacyAppointmentInfoFollowUp({
          key,
          session,
          tenantId,
          from,
          raw,
        });
      if (legacyAppointmentInfoFollowUp.handled) {
        return this.safeReply(session, legacyAppointmentInfoFollowUp.reply);
      }

      if (isCancel(msg)) {
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        this.saveSession(key, session);
        return this.safeReply(
          session,
          'Tamam, iptal ettim. Yeni randevu için “randevu” diyebilirsin.',
        );
      }

      if (isRestart(msg)) {
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        session.state = WaState.WAIT_SERVICE;
        this.saveSession(key, session);

        const services = await this.safeListServices(tenantId);
        const reply = this.askService(services, { gentle: true });
        return this.safeReply(session, reply);
      }

      const contextLoadStartedAt = Date.now();
      const [business, services, staff] = await Promise.all([
        this.safeGetBusinessProfile(tenantId),
        this.safeListServices(tenantId),
        this.safeListStaff(tenantId),
      ]);
      this.logAction('voice_context_loaded', {
        tenantId,
        phone: from,
        isVoice,
        durationMs: Date.now() - contextLoadStartedAt,
        services: Array.isArray(services) ? services.length : 0,
        staff: Array.isArray(staff) ? staff.length : 0,
      });
      const recentServiceMention = this.detectServiceFromMessage(raw, services);
      if (recentServiceMention?.id) {
        session.lastServiceId = String(recentServiceMention.id);
        session.lastServiceName = recentServiceMention?.name
          ? String(recentServiceMention.name)
          : session.lastServiceName;
      }
      this.updateContinuityMemory(session, services, staff);
      const preIntentContinuity = this.resolveContinuityContext({
        session,
        raw,
        services,
        staff,
        isVoice,
        phase: 'pre_intent',
      });

      if (isSimpleGreetingOnly(raw)) {
        return this.safeReply(
          session,
          session.history.length <= 1
            ? 'Merhaba, buyurun.'
            : 'Buyurun, sizi dinliyorum.',
        );
      }

      const voiceBookingIntentOverride =
        isVoice && this.hasStrongVoiceBookingIntent(raw, services);
      const globalIntent = voiceBookingIntentOverride
        ? 'NEW_BOOKING'
        : contextualBookingFollowUp ||
            preIntentContinuity.inferredBookingContinuation
          ? 'NEW_BOOKING'
          : detectLegacyGlobalIntent(raw);
      const shouldExtractSlots =
        session.state !== WaState.IDLE ||
        globalIntent === 'NEW_BOOKING' ||
        globalIntent === 'RESCHEDULE_BOOKING' ||
        globalIntent === 'CANCEL_BOOKING';

      if (shouldExtractSlots) {
        this.extractSlotsFromMessage({
          session,
          raw,
          services,
          staff,
          isVoice,
        });
      }

      const learned = isVoice
        ? { name: null, summary: '' }
        : await this.safeGetLearnedCustomerContext(tenantId, from, services);

      if (isVoice) {
        this.logAction('voice_previous_service_suggestion_bypassed', {
          tenantId,
          phone: from,
        });
      }

      if (learned?.name && !session.draft.customerName) {
        session.draft.customerName = String(learned.name);
      }

      // Global override router: user can jump domains at any moment.
      if (session.state !== WaState.IDLE) {
        if (
          globalIntent === 'LIST_APPOINTMENTS' ||
          globalIntent === 'MY_APPOINTMENT_TIME'
        ) {
          this.softResetSession(session, tenantId, from, {
            keepIdempotency: true,
          });
          this.saveSession(key, session);
        }

        if (
          (globalIntent === 'RESCHEDULE_BOOKING' ||
            globalIntent === 'CANCEL_BOOKING') &&
          [
            WaState.WAIT_SERVICE,
            WaState.WAIT_NAME,
            WaState.WAIT_DATETIME,
          ].includes(session.state)
        ) {
          this.softResetSession(session, tenantId, from, {
            keepIdempotency: true,
          });
          this.saveSession(key, session);
        }

        if (
          globalIntent === 'NEW_BOOKING' &&
          [
            WaState.WAIT_APPT_PICK,
            WaState.WAIT_EDIT_ACTION,
            WaState.WAIT_CONFIRM,
          ].includes(session.state) &&
          session.editMode
        ) {
          this.softResetSession(session, tenantId, from, {
            keepIdempotency: true,
          });
          this.saveSession(key, session);
        }
      }

      // ✅ Eğer bir flow içindeysek (booking/edit) state machine’e gir
      if (session.state !== WaState.IDLE) {
        const reply = await this.handleBookingFlow({
          key,
          session,
          tenantId,
          from,
          msg,
          raw,
          services,
          staff,
          isVoice,
        });
        this.saveSession(key, session);
        return this.safeReply(session, reply);
      }


      const legacyUpcomingAppointmentEntry =
        await this.handleLegacyUpcomingAppointmentEntry({
          key,
          session,
          tenantId,
          from,
          raw,
          globalIntent,
          voiceBookingIntentOverride,
        });
      if (legacyUpcomingAppointmentEntry.handled) {
        return this.safeReply(session, legacyUpcomingAppointmentEntry.reply);
      }

      // =========================
      // ✅ Edit intent (IDLE iken): randevu iptal/değiştir
      // Kullanıcı açıkça iptal/değiştir niyeti belirtmediği sürece edit akışına girmeyiz.
      // Yeni randevu isteği (booking intent) her zaman önceliklidir.
      // =========================
      const legacyEditOrCancelEntry = await this.handleLegacyEditOrCancelEntry({
        key,
        session,
        tenantId,
        from,
        raw,
        globalIntent,
        voiceBookingIntentOverride,
      });
      if (legacyEditOrCancelEntry.handled) {
        return this.safeReply(session, legacyEditOrCancelEntry.reply);
      }

      // =========================
      // Booking intent
      // =========================
      const legacyBookingEntry = await this.handleLegacyBookingEntry({
        key,
        session,
        tenantId,
        from,
        raw,
        services,
        staff,
        business,
        globalIntent,
        contextualBookingFollowUp,
      });
      if (legacyBookingEntry.handled) {
        return this.safeReply(session, legacyBookingEntry.reply);
      }

      // =========================
      // info flows
      // =========================
      const legacyDeterministicInfo = this.handleLegacyDeterministicInfoEntry({
        session,
        raw,
        msg,
        services,
        business,
        isVoice,
      });
      if (legacyDeterministicInfo.handled) {
        return this.safeReply(session, legacyDeterministicInfo.reply);
      }

      const legacyProcedureInfo = await this.handleLegacyProcedureLlmEntry({
        session,
        raw,
        msg,
        services,
        staff,
        business,
        isVoice,
        learnedCustomerSummary: learned?.summary || '',
      });
      if (legacyProcedureInfo.handled) {
        return this.safeReply(session, legacyProcedureInfo.reply);
      }

      return this.safeReply(
        session,
        await this.handleLegacyGeneralLlmFallback({
          session,
          raw,
          services,
          staff,
          business,
          learnedCustomerSummary: learned?.summary || '',
        }),
      );
    } catch (e: any) {
      this.logger.error(`[AgentService.replyText] ${e?.message || e}`);
      return this.safeReply(
        session,
        'Şu an bir hata oluştu 😕 Lütfen tekrar dener misin?',
      );
    }
  }

  // =========================
  // Booking + Edit State Machine
  // =========================
  private async handleBookingFlow(opts: {
    key: string;
    session: SessionState;
    tenantId: string;
    from: string;
    msg: string;
    raw: string;
    services: any[];
    staff: any[];
    isVoice: boolean;
  }): Promise<string> {
    const { key, session, tenantId, from, msg, raw, services, staff, isVoice } =
      opts;

    // ✅ Booking/edit akışındayken kullanıcı bilgi sorarsa akıştan çık (ama draft kalsın)
    if (!session.editMode && session.state !== WaState.IDLE) {
      const infoBreak =
        looksLikeProcedureQuestion(raw) ||
        looksLikePriceQuestion(msg) ||
        looksLikeServiceListRequest(msg) ||
        looksLikeAddressOrHours(msg) ||
        looksLikeUpcomingQuery(raw);

      if (
        infoBreak &&
        !isYes(msg) &&
        !isNo(msg) &&
        !looksLikeBookingIntent(raw)
      ) {
        session.state = WaState.IDLE;
        session.pendingSummary = undefined;
        session.lastSuggestions = undefined;
        // draft'ı SAKLIYORUZ (kullanıcı sonra “randevu” derse hızlanır)
      }
    }

    // ✅ Edit/Booking flow içinde “konu değişti” diye çıkma:
    if (
      session.state !== WaState.WAIT_APPT_PICK &&
      session.state !== WaState.WAIT_EDIT_ACTION
    ) {
      if (!session.editMode && shouldExitBookingFlow(msg, raw)) {
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        this.saveSession(key, session);
        return 'Tamam 👍 Anladım. Nasıl yardımcı olayım?';
      }
    }

    // ✅ Edit başlangıcı: randevu seçimi
    if (session.state === WaState.WAIT_APPT_PICK) {
      const list = await this.safeListUpcomingAppointmentsByPhone(
        tenantId,
        from,
        6,
      );
      if (!list?.length) {
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        return 'Görünen bir randevunuz yok 🙂';
      }

      // Kullanıcı “hepsi” veya “tümünü” derse tüm randevuları iptal etmek istediğini varsay
      const tHepsi = normalizeTr(raw);
      if (
        tHepsi.includes('hepsi') ||
        tHepsi.includes('hepsini') ||
        tHepsi.includes('tum') ||
        tHepsi.includes('tumu') ||
        tHepsi.includes('tümünü')
      ) {
        session.editMode = 'CANCEL';
        session.cancelAllIds = list.map((a) => String(a.id));
        session.pendingSummary = `Toplam ${list.length} randevunuz var. Hepsini iptal etmek istediğinize emin misiniz?`;
        session.state = WaState.WAIT_CONFIRM;
        // no targetAppointmentId for bulk
        return `${session.pendingSummary}\n${this.softYesNoHint(from + 'all')}`;
      }

      // ✅ If user says "2. randevuyu 13:00 yap" in one message, catch it early
      const ordInline = extractOrdinal1to9(raw);
      const parsedInline = parseDateTimeTR(raw);
      const onlyTimeInline = parseTimeBest(normalizeTr(raw));

      if (ordInline != null && (parsedInline?.hasTime || onlyTimeInline)) {
        const idx = Math.max(0, Math.min(8, ordInline - 1));
        const chosen = list[idx];

        if (chosen) {
          // cancel inline
          if (looksLikeCancelIntent(raw)) {
            session.editMode = 'CANCEL';
            session.targetAppointmentId = String(chosen.id);
            session.targetApptSnapshot = {
              serviceId: String(chosen.serviceId),
              staffId: String(chosen.staffId),
              startAtIso: String(chosen.startAtIso),
              serviceName: chosen.serviceName,
              staffName: chosen.staffName,
            };
            session.pendingSummary = this.buildEditCancelSummary(
              session.targetApptSnapshot,
            );
            session.state = WaState.WAIT_CONFIRM;
            return `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`;
          }

          // reschedule inline
          let iso: string | null = null;
          if (onlyTimeInline && !hasExplicitDateMarker(normalizeTr(raw))) {
            const baseIso =
              session.editBaseStartAtIso || String(chosen.startAtIso);
            iso = buildIsoWithSameDate(
              baseIso,
              onlyTimeInline.hh,
              onlyTimeInline.mm,
            );
          } else if (parsedInline?.hasTime) {
            iso = toIstanbulIso(clampToFuture(parsedInline.dateUtc));
          }

          if (iso) {
            session.editMode = 'RESCHEDULE';
            session.targetAppointmentId = String(chosen.id);
            session.targetApptSnapshot = {
              serviceId: String(chosen.serviceId),
              staffId: String(chosen.staffId),
              startAtIso: String(chosen.startAtIso),
              serviceName: chosen.serviceName,
              staffName: chosen.staffName,
            };
            // set base date for time-only edits
            session.editBaseStartAtIso = String(chosen.startAtIso);

            session.draft.serviceId = String(chosen.serviceId);
            session.draft.staffId = String(chosen.staffId);
            session.draft.startAt = iso;

            const pre = await this.precheckAndPrepareConfirm({
              tenantId,
              draft: session.draft,
              ignoreAppointmentId: session.targetAppointmentId,
            });

            if (!pre.ok) {
              session.draft.startAt = String(chosen.startAtIso);
              session.state = WaState.WAIT_DATETIME;
              return 'O saat dolu gibi 😕 Başka bir saat söyler misin?';
            }

            session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
            session.state = WaState.WAIT_CONFIRM;
            return `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`;
          }
        }
      }

      const picked = this.pickFromSuggestions(session, raw);
      let apptId = '';
      // ✅ inline: "2. randevuyu 13:00'a al" gibi -> seçimi yakalayıp direkt TIME akışına sok
      const tNorm2 = normalizeTr(raw);
      const parsed2 = parseDateTimeTR(raw);
      const onlyTime2 = parseTimeBest(tNorm2);

      const wantsTimeInline =
        /\b\d{1,2}:\d{2}\b/.test(tNorm2) &&
        (tNorm2.includes('saat') ||
          tNorm2.includes('degis') ||
          tNorm2.includes('değiş') ||
          tNorm2.includes('guncelle') ||
          tNorm2.includes('güncelle') ||
          tNorm2.includes('al') ||
          tNorm2.includes('cek') ||
          tNorm2.includes('çek'));

      if (picked?.type === 'appt' && picked.apptId) apptId = picked.apptId;

      if (!apptId) {
        const t = normalizeTr(raw);
        const hit = list.find((a) =>
          normalizeTr(
            `${a.serviceName || ''} ${a.staffName || ''} ${prettyIstanbul(a.startAtIso)}`,
          ).includes(t),
        );
        if (hit) apptId = hit.id;
      }

      const chosen = list.find((a) => String(a.id) === String(apptId)) || null;
      if (!chosen) {
        return this.askAppointmentPickMenu(session, list);
      }

      // ✅ Eğer kullanıcı aynı mesajda saat/tarih söylediyse menüyü atla -> direkt onaya git
      if (looksLikeCancelIntent(raw)) {
        session.editMode = 'CANCEL';
        session.pendingSummary = this.buildEditCancelSummary({
          serviceId: String(chosen.serviceId),
          staffId: String(chosen.staffId),
          startAtIso: String(chosen.startAtIso),
          serviceName: chosen.serviceName,
          staffName: chosen.staffName,
        });
        session.state = WaState.WAIT_CONFIRM;
        return `${session.pendingSummary}\n${this.softYesNoHint(from + String(chosen.id))}`;
      }

      if (wantsTimeInline || parsed2?.hasTime) {
        let iso: string | null = null;

        if (onlyTime2 && !hasExplicitDateMarker(tNorm2)) {
          const baseIso =
            session.editBaseStartAtIso || String(chosen.startAtIso);
          iso = buildIsoWithSameDate(baseIso, onlyTime2.hh, onlyTime2.mm);
        } else if (parsed2?.hasTime) {
          iso = toIstanbulIso(clampToFuture(parsed2.dateUtc));
        }

        if (iso) {
          session.targetAppointmentId = String(chosen.id);
          session.targetApptSnapshot = {
            serviceId: String(chosen.serviceId),
            staffId: String(chosen.staffId),
            startAtIso: String(chosen.startAtIso),
            serviceName: chosen.serviceName,
            staffName: chosen.staffName,
          };
          // set base date for time-only edits
          session.editBaseStartAtIso = String(chosen.startAtIso);

          session.draft.serviceId = String(chosen.serviceId);
          session.draft.staffId = String(chosen.staffId);
          session.draft.startAt = iso;

          session.editMode = 'RESCHEDULE';

          const pre = await this.precheckAndPrepareConfirm({
            tenantId,
            draft: session.draft,
            ignoreAppointmentId: session.targetAppointmentId,
          });

          if (!pre.ok) {
            session.draft.startAt = String(chosen.startAtIso);
            session.state = WaState.WAIT_DATETIME;
            return 'O saat dolu gibi görünüyor 😕 Başka bir saat söyler misin?';
          }

          session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
          session.state = WaState.WAIT_CONFIRM;
          return `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`;
        }
      }

      session.targetAppointmentId = String(chosen.id);
      session.targetApptSnapshot = {
        serviceId: String(chosen.serviceId),
        staffId: String(chosen.staffId),
        startAtIso: String(chosen.startAtIso),
        serviceName: chosen.serviceName,
        staffName: chosen.staffName,
      };
      // set base date for time-only edits
      session.editBaseStartAtIso = String(chosen.startAtIso);

      // draft'ı seçilen randevudan doldur
      session.draft.serviceId = String(chosen.serviceId);
      session.draft.staffId = String(chosen.staffId);
      session.draft.startAt = String(chosen.startAtIso);

      session.state = WaState.WAIT_EDIT_ACTION;
      return this.askEditActionMenu(session, chosen);
    }

    // ✅ Edit aksiyonu: neyi değiştirelim / iptal
    if (session.state === WaState.WAIT_EDIT_ACTION) {
      if (!session.targetAppointmentId || !session.targetApptSnapshot) {
        session.state = WaState.IDLE;
        return 'Bir şey kaçtı 😕 Tekrar “randevu değiştir” söyler misin?';
      }

      if (looksLikeCancelIntent(raw)) {
        session.editMode = 'CANCEL';
        session.pendingSummary = this.buildEditCancelSummary(
          session.targetApptSnapshot,
        );
        session.state = WaState.WAIT_CONFIRM;
        return `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`;
      }

      // kullanıcı direkt yeni tarih/saat söylersa -> saat değişikliği
      const parsed = parseDateTimeTR(raw);
      if (parsed?.hasTime) {
        const iso = toIstanbulIso(clampToFuture(parsed.dateUtc));
        session.editMode = 'RESCHEDULE';
        session.draft.startAt = iso;
        session.pendingDateOnly = undefined;

        const pre = await this.precheckAndPrepareConfirm({
          tenantId,
          draft: session.draft,
          ignoreAppointmentId: session.targetAppointmentId,
        });

        if (!pre.ok) {
          if (pre.code === 'OUT_OF_HOURS' && pre.suggestions?.length) {
            session.draft.startAt = undefined;
            const isoList = pre.suggestions.map((s) => s.startAt);
            return this.askSlotMenu(
              session,
              isoList,
              `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`,
            );
          }
          if (pre.code === 'SLOT_TAKEN' && pre.suggestions?.length) {
            session.draft.startAt = undefined;
            const isoList = pre.suggestions.map((s) => s.startAt);
            return this.askSlotMenu(
              session,
              isoList,
              `O saat dolu 😕 Şunlar uygun:`,
            );
          }
          session.draft.startAt = undefined;
          return 'O zamanı ayarlayamadım 😕 Başka bir tarih/saat söyler misin?';
        }

        session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
        session.state = WaState.WAIT_CONFIRM;
        return `${session.pendingSummary}\n${this.softYesNoHint(from + (session.draft.startAt || ''))}`;
      } else if (parsed?.dateOnly) {
        session.editMode = 'RESCHEDULE';
        session.pendingDateOnly = parsed.dateOnly;
        session.state = WaState.WAIT_DATETIME;
        return this.humanizeAskTimeOnly(raw);
      }

      // menü seçimi
      const picked = this.pickFromSuggestions(session, raw);
      const act = picked?.type === 'editAction' ? picked.action : '';

      const t = normalizeTr(raw);
      const wantsTime =
        act === 'TIME' ||
        t.includes('saat') ||
        t.includes('tarih') ||
        t.includes('gun') ||
        t.includes('gün') ||
        t.includes('ertele') ||
        t.includes('degis') ||
        t.includes('değiş');
      const wantsService =
        act === 'SERVICE' ||
        t.includes('hizmet') ||
        t.includes('islem') ||
        t.includes('işlem');
      const wantsStaff =
        t.includes('usta') ||
        t.includes('personel') ||
        t.includes('calisan') ||
        t.includes('çalışan');
      const wantsCancel =
        act === 'CANCEL' || t === 'iptal' || t.includes('iptal');
      const wantsAbort =
        act === 'ABORT' ||
        t.includes('vazgec') ||
        t.includes('vazgeç') ||
        t.includes('bosver') ||
        t.includes('boşver');

      if (wantsAbort) {
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        this.saveSession(key, session);
        return 'Tamam 👍 Vazgeçtik. Nasıl yardımcı olayım?';
      }

      if (wantsCancel) {
        session.editMode = 'CANCEL';
        session.pendingSummary = this.buildEditCancelSummary(
          session.targetApptSnapshot,
        );
        session.state = WaState.WAIT_CONFIRM;
        return `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`;
      }

      if (wantsService) {
        session.editMode = 'RESCHEDULE';
        session.state = WaState.WAIT_SERVICE;
        session.suggestedServiceId = undefined;
        session.suggestedServiceName = undefined;
        return this.askService(services, { gentle: true });
      }

      if (wantsStaff) {
        session.editMode = 'RESCHEDULE';
        session.state = WaState.WAIT_DATETIME;
        session.draft.startAt = undefined;
        session.pendingDateOnly = undefined;
        session.pendingStartAt = undefined;
        return 'Personel tercihi almıyoruz. Uygun bir randevu için gün ve saat söyleyebilirsiniz.';
      }

      if (wantsTime) {
        session.editMode = 'RESCHEDULE';
        session.state = WaState.WAIT_DATETIME;
        session.draft.startAt = undefined;
        session.pendingDateOnly = undefined;
        session.pendingStartAt = undefined;
        return this.humanizeAsk('datetime', raw);
      }

      return this.askEditActionMenu(session, {
        id: session.targetAppointmentId || '',
        startAtIso: session.targetApptSnapshot.startAtIso,
        serviceName: session.targetApptSnapshot.serviceName,
        staffName: session.targetApptSnapshot.staffName,
      });
    }

    // =========================
    // normal booking states
    // =========================
    const parsedEarly = parseDateTimeTR(raw);
    if (parsedEarly?.hasTime) {
      const mergedPendingIso = this.mergePendingDateOnlyWithTime(
        session.pendingDateOnly,
        normalizeTr(raw),
      );
      session.pendingStartAt =
        mergedPendingIso || toIstanbulIso(clampToFuture(parsedEarly.dateUtc));
      if (!session.draft.startAt && session.pendingStartAt)
        session.draft.startAt = session.pendingStartAt;
      session.pendingDateOnly = undefined;
    } else if (parsedEarly?.dateOnly) {
      session.pendingDateOnly = parsedEarly.dateOnly;
    }

    this.extractSlotsFromMessage({ session, raw, services, staff, isVoice });
    this.resolveContinuityContext({
      session,
      raw,
      services,
      staff,
      isVoice,
      phase: 'pre_missing_slot',
    });
    this.logAction('extracted_slots', {
      tenantId,
      phone: from,
      serviceId: session.draft.serviceId || null,
      staffId: session.draft.staffId || null,
      startAt: session.draft.startAt || null,
      customerName: session.draft.customerName || null,
      pendingDateOnly: session.pendingDateOnly || null,
    });
    this.logAction('merged_booking_draft', {
      tenantId,
      phone: from,
      state: session.state,
      draft: {
        serviceId: session.draft.serviceId || null,
        staffId: session.draft.staffId || null,
        customerName: session.draft.customerName || null,
        startAt: session.draft.startAt || null,
        pendingDateOnly: session.pendingDateOnly || null,
      },
    });
    this.logAction('next_missing_slot_selection', {
      tenantId,
      phone: from,
      nextSlot: this.getNextMissingSlot(session),
      state: session.state,
    });

    const picked = this.pickFromSuggestions(session, raw);
    if (picked?.type === 'slot' && picked.startAt) {
      session.draft.startAt = picked.startAt;
      session.pendingStartAt = picked.startAt;
      session.pendingDateOnly = undefined;
    }

    if (!session.draft.serviceId && services.length === 1 && services[0]?.id)
      session.draft.serviceId = String(services[0].id);

    if (session.state === WaState.WAIT_SERVICE) {
      if (!session.draft.serviceId && this.isShortContextualBookingReply(raw)) {
        this.tryCarryRecentServiceContext(session, services);
      }

      // Voice flow must not ask/confirm previously suggested services.
      session.suggestedServiceId = undefined;
      session.suggestedServiceName = undefined;

      if (session.editMode) {
        if (!session.draft.serviceId)
          return await this.naturalAsk(session, 'service', {
            services,
            staff,
            business: null,
          });

        const pre = await this.precheckAndPrepareConfirm({
          tenantId,
          draft: session.draft,
          ignoreAppointmentId: session.targetAppointmentId || undefined,
        });

        if (!pre.ok) {
          session.draft.serviceId = undefined;
          return 'Bu hizmetle şu anki randevu çakışıyor gibi 😕 Başka bir hizmet seçebilir misin?';
        }

        session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
        session.state = WaState.WAIT_CONFIRM;
        return `${session.pendingSummary}\n${this.softYesNoHint(from + (session.draft.startAt || ''))}`;
      }

      if (
        !session.draft.serviceId &&
        !this.isGenericBookingIntentWithoutService(raw, services) &&
        this.hasExplicitUnknownServiceRequest(raw, services)
      ) {
        this.logAction('unknown_service_detected', {
          tenantId,
          phone: from,
          raw,
          state: session.state,
        });
        return 'Bu isimde bir hizmetimizi bulamadım. İsterseniz mevcut işlemlerimizden birini söyleyebilirsiniz.';
      }

      if (!session.draft.serviceId)
        return await this.naturalAsk(session, 'service', {
          services,
          staff,
          business: null,
        });
      session.state = WaState.WAIT_DATETIME;
    }

    if (session.state === WaState.WAIT_DATETIME) {
      let startIso = session.draft.startAt;

      if (parsedEarly?.hasTime) {
        session.pendingDateOnly = undefined;
      }

      if (!startIso) {
        const parsed = parseDateTimeTR(raw);

        if (!parsed && session.pendingDateOnly)
          return this.humanizeAskTimeOnly(raw);
        if (parsed && !parsed.hasTime && session.pendingDateOnly)
          return this.humanizeAskTimeOnly(raw);

        const onlyTime = parseTimeBest(normalizeTr(raw));
        if (onlyTime && session.pendingDateOnly) {
          const [yy, mm, dd] = session.pendingDateOnly.split('-').map(Number);
          const dUtc = new Date(
            Date.UTC(yy, mm - 1, dd, onlyTime.hh - 3, onlyTime.mm, 0, 0),
          );
          const fixed = clampToFuture(dUtc);
          startIso = toIstanbulIso(fixed);
          session.draft.startAt = startIso;
          session.pendingDateOnly = undefined;
        } else if (parsed?.hasTime) {
          const fixed = clampToFuture(parsed.dateUtc);
          startIso = toIstanbulIso(fixed);
          session.draft.startAt = startIso;
          session.pendingDateOnly = undefined;
        } else {
          const picked2 = this.pickFromSuggestions(session, raw);
          if (picked2?.type === 'slot' && picked2.startAt) {
            startIso = picked2.startAt;
            session.draft.startAt = startIso;
          } else {
            return this.humanizeAsk('datetime', raw);
          }
        }
      }

      if (startIso && !isWithinWorkingHoursIso(startIso)) {
        session.draft.startAt = undefined;
        session.pendingStartAt = undefined;

        const suggestions = suggestWorkingHourAlternatives(startIso, 5);
        return this.askSlotMenu(
          session,
          suggestions,
          `Bu saatlerde çalışmıyoruz 😕\n⏰ 08:00 - 22:00\nŞunlar uygun olabilir:`,
        );
      }

      const pre = await this.precheckAndPrepareConfirm({
        tenantId,
        draft: session.draft,
        ignoreAppointmentId: session.targetAppointmentId || undefined,
      });

      if (!pre.ok) {
        if (pre.code === 'OUT_OF_HOURS' && pre.suggestions?.length) {
          session.draft.startAt = undefined;
          const isoList = pre.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(
            session,
            isoList,
            `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`,
          );
        }

        if (pre.code === 'SLOT_TAKEN' && pre.suggestions?.length) {
          session.draft.startAt = undefined;
          const isoList = pre.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(
            session,
            isoList,
            `O saat dolu 😕 Şunlar uygun:`,
          );
        }

        session.draft.startAt = undefined;
        this.logAction('time_rejected_or_unavailable', {
          tenantId,
          phone: from,
          reason: pre.code || 'PRECHECK_FAILED',
          requestedStartAt: session.draft.startAt || null,
        });
        return 'Bu saat uygun görünmüyor. Lütfen başka bir saat söyleyin. Örneğin 14:30.';
      }

      session.pendingSummary = session.editMode
        ? `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`
        : pre.summary!;
      session.state = WaState.WAIT_CONFIRM;
      return isVoice
        ? this.buildNaturalConfirmationPrompt(session, services, staff, {
            editMode: Boolean(session.editMode),
            seed: from + (session.draft.startAt || ''),
          })
        : `${session.pendingSummary}\n${this.softYesNoHint(from + (session.draft.startAt || ''))}`;
    }

    if (session.state === WaState.WAIT_CONFIRM) {
      const parsed = parseDateTimeTR(raw);
      if (parsed?.hasTime) {
        const iso = toIstanbulIso(clampToFuture(parsed.dateUtc));
        if (!isWithinWorkingHoursIso(iso)) {
          const suggestions = suggestWorkingHourAlternatives(iso, 5);
          return this.askSlotMenu(
            session,
            suggestions,
            `Bu saatlerde çalışmıyoruz 😕\n⏰ 08:00 - 22:00\nŞunlar uygun olabilir:`,
          );
        }
        session.draft.startAt = iso;
        session.state = WaState.WAIT_DATETIME;
        return this.handleBookingFlow({ ...opts, session });
      } else if (parsed?.dateOnly) {
        session.pendingDateOnly = parsed.dateOnly;
        return this.humanizeAskTimeOnly(raw);
      }

      const yes = isYes(msg);
      const no = isNo(msg);

      if (!yes && !no) return this.humanizeConfirmNeedEH(raw);

      if (no) {
        if (session.editMode && session.targetApptSnapshot) {
          session.pendingSummary = undefined;
          session.state = WaState.WAIT_EDIT_ACTION;
          session.draft.serviceId = session.targetApptSnapshot.serviceId;
          session.draft.staffId = session.targetApptSnapshot.staffId;
          session.draft.startAt = session.targetApptSnapshot.startAtIso;
          session.lastSuggestions = undefined;
          return this.askEditActionMenu(session, {
            id: session.targetAppointmentId || '',
            startAtIso: session.targetApptSnapshot.startAtIso,
            serviceName: session.targetApptSnapshot.serviceName,
            staffName: session.targetApptSnapshot.staffName,
          });
        }

        session.state = WaState.WAIT_DATETIME;
        session.pendingSummary = undefined;
        session.draft.startAt = undefined;
        session.pendingStartAt = undefined;
        session.lastSuggestions = undefined;
        return this.humanizeAsk('datetime', raw);
      }

      // ✅ EDIT MODE: CANCEL / UPDATE
      if (session.editMode) {
        if (session.editMode === 'CANCEL') {
          let ok = false;
          const isBulk = !!(
            session.cancelAllIds && session.cancelAllIds.length
          );
          // If multiple IDs to cancel (hepsi) use bulk cancellation
          if (isBulk && session.cancelAllIds) {
            ok = await this.safeCancelMultipleAppointments(
              tenantId,
              session.cancelAllIds,
            );
          } else if (session.targetAppointmentId) {
            ok = await this.safeCancelAppointment(
              tenantId,
              session.targetAppointmentId,
            );
          }
          this.softResetSession(session, tenantId, from, {
            keepIdempotency: true,
          });
          // clear cancelAllIds so future actions are clean
          session.cancelAllIds = undefined;
          this.saveSession(key, session);
          return isBulk
            ? ok
              ? 'Tamam ✅ Tüm randevularınızı iptal ettim.'
              : 'Bir şey takıldı 😕 Hepsini iptal edemedim, tekrar deneyelim mi?'
            : ok
              ? 'Tamam ✅ Randevunuzu iptal ettim.'
              : 'Bir şey takıldı 😕 İptal edemedim, tekrar dener misiniz?';
        }

        const upd = await this.updateAppointment({
          tenantId,
          appointmentId: String(session.targetAppointmentId),
          draft: session.draft,
        });

        if (!upd.ok && upd.code === 'OUT_OF_HOURS' && upd.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = upd.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(
            session,
            isoList,
            `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`,
          );
        }

        if (!upd.ok && upd.code === 'SLOT_TAKEN' && upd.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = upd.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(
            session,
            isoList,
            `O saat dolu 😕 Şunlar uygun:`,
          );
        }

        if (!upd.ok) {
          session.state = WaState.WAIT_EDIT_ACTION;
          session.pendingSummary = undefined;
          return 'Bir şey takıldı 😕 Ne yapalım: saat mi değişsin, hizmet mi, iptal mi?';
        }

        const newIso = upd.data.startAt;
        const apptId = upd.data.appointmentId;

        session.state = WaState.CONFIRMED;

      session.lastBookingContext = {
          startAtIso: newIso,
          serviceName: session.targetApptSnapshot?.serviceName,
          staffName: session.targetApptSnapshot?.staffName,
          customerName: session.draft.customerName || undefined,
        };
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        this.saveSession(key, session);
        const reply = this.formatEditSuccess(newIso, apptId, from + newIso);
        // Persist last booking summary for follow‑up questions
        (session as any).lastBookingSummary = reply;
        (session as any).lastBookingStartAt = newIso;
        this.saveSession(key, session);
        return reply;
      }

      // ✅ NORMAL BOOKING CONFIRM (create)
      const bookingKey = this.makeBookingKey(tenantId, from, session.draft);
      if (
        bookingKey &&
        session.lastCreatedBookingKey === bookingKey &&
        session.lastCreatedAppointmentId &&
        session.lastCreatedAt &&
        Date.now() - session.lastCreatedAt < 10 * 60 * 1000
      ) {
        const startAt = session.draft.startAt || new Date().toISOString();
        const apptId = session.lastCreatedAppointmentId;
        this.softResetSession(session, tenantId, from, {
          keepIdempotency: true,
        });
        this.saveSession(key, session);
        const reply = this.formatBookingSuccess(
          startAt,
          apptId,
          from + startAt,
        );
        (session as any).lastBookingSummary = reply;
        (session as any).lastBookingStartAt = startAt;
        this.saveSession(key, session);
        return reply;
      }

      const created = await this.createAppointment({
        tenantId,
        draft: session.draft,
        staffFallbackList: staff,
      });

      if (!created.ok && created.code === 'NEED_NAME') {
        session.state = WaState.WAIT_DATETIME;
        return await this.naturalAsk(session, 'name', {
          services,
          staff,
          business: null,
        });
      }

      if (!created.ok) {
        if (created.code === 'OUT_OF_HOURS' && created.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = created.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(
            session,
            isoList,
            `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`,
          );
        }

        if (created.code === 'SLOT_TAKEN' && created.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = created.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(
            session,
            isoList,
            `O saat dolu 😕 Şunlar uygun:`,
          );
        }

        session.state = WaState.WAIT_DATETIME;
        session.draft.startAt = undefined;
        return this.pickOne(
          [
            'Randevu oluştururken bir şey ters gitti 😕 Başka bir saat dener misin?',
            'Bir hata oldu 😕 Hangi saat uygun, tekrar deneyelim.',
          ],
          raw,
        );
      }

      session.lastCreatedBookingKey = bookingKey || undefined;
      session.lastCreatedAppointmentId = created.data.appointmentId;
      session.lastCreatedAt = Date.now();

      await this.learnFromSuccessfulBooking(tenantId, from, session.draft);

      session.state = WaState.CONFIRMED;

      session.lastBookingContext = {
        startAtIso: created.data.startAt,
        serviceName: services.find(
          (s: any) => String(s?.id) === String(session.draft.serviceId),
        )?.name,
        staffName:
          staff.find(
            (p: any) => String(p?.id) === String(session.draft.staffId),
          )?.name || session.draft.requestedStaffName,
        customerName: session.draft.customerName || undefined,
      };
      this.softResetSession(session, tenantId, from, { keepIdempotency: true });
      this.saveSession(key, session);
      const successMsg = this.formatBookingSuccess(
        created.data.startAt,
        created.data.appointmentId,
        from + created.data.startAt,
      );
      // Persist last booking summary and start time for follow‑up queries
      (session as any).lastBookingSummary = successMsg;
      (session as any).lastBookingStartAt = created.data.startAt;
      this.saveSession(key, session);
      return successMsg;
    }

    session.state = WaState.WAIT_SERVICE;
    return await this.naturalAsk(session, 'service', {
      services,
      staff,
      business: null,
    });
  }

  // =========================
  // Menus
  // =========================
  private askSlotMenu(
    session: SessionState,
    isoList: string[],
    header: string,
  ) {
    const items = (isoList || [])
      .filter(Boolean)
      .slice(0, 9)
      .map((iso) => ({
        label: prettyIstanbul(iso),
        value: iso,
      }));

    session.lastSuggestions = { type: 'slot', items, ts: Date.now() };

    const lines = items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
    const tail = this.pickOne(
      [
        'Birini seç (1-9) ya da saati söyle 🙂',
        '1-9 seçebilirsin, istersen saati söyle (örn: 17:15)',
      ],
      lines,
    );
    return `${header}\n${lines}\n\n${tail}`;
  }

  private askAppointmentPickMenu(session: SessionState, appts: UpcomingAppt[]) {
    const items = (appts || []).slice(0, 9).map((a) => {
      const labelParts: string[] = [];
      labelParts.push(prettyIstanbul(a.startAtIso));
      if (a.serviceName) labelParts.push(String(a.serviceName));
      if (a.staffName) labelParts.push(`(${String(a.staffName)})`);
      return { label: labelParts.join(' • '), value: String(a.id) };
    });

    session.lastSuggestions = { type: 'appt', items, ts: Date.now() };

    const lines = items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
    const header = this.pickOne(
      [
        'Birden fazla randevun var 🙂 Hangisini değiştirelim/iptal edelim?',
        'Şu randevularını görüyorum. Hangisiyle işlem yapalım?',
      ],
      lines,
    );

    return `${header}\n${lines}\n\n1-9 söylemen yeterli.`;
  }

  private askEditActionMenu(
    session: SessionState,
    appt: {
      startAtIso: string;
      serviceName?: string;
      staffName?: string;
      id: string;
    },
  ) {
    const headerParts: string[] = [];
    headerParts.push('Tamam 🙂 Şu randevu için işlem yapacağız:');
    headerParts.push(
      `• ${prettyIstanbul(appt.startAtIso)}${appt.serviceName ? ` • ${appt.serviceName}` : ''}${appt.staffName ? ` • ${appt.staffName}` : ''}`,
    );

    const items: SuggestionItem[] = [
      { label: 'Tarih/Saat değiştir', value: 'TIME' },
      { label: 'Hizmet değiştir', value: 'SERVICE' },
      { label: 'Randevuyu iptal et', value: 'CANCEL' },
      { label: 'Vazgeç', value: 'ABORT' },
    ];

    session.lastSuggestions = { type: 'editAction', items, ts: Date.now() };

    const lines = items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
    const tail =
      'İstersen 1-4 söyle, istersen direkt “saat değiştir / hizmet değiştir / iptal” diyebilirsin 🙂';
    return `${headerParts.join('\n')}\n\nNe yapmak istersin?\n${lines}\n\n${tail}`;
  }

  private pickFromSuggestions(
    session: SessionState,
    raw: string,
  ):
    | { type: 'slot'; startAt: string }
    | { type: 'appt'; apptId: string }
    | {
        type: 'editAction';
        action: 'TIME' | 'SERVICE' | 'CANCEL' | 'ABORT';
      }
    | null {
    const s = session.lastSuggestions;
    if (!s?.items?.length) return null;
    if (Date.now() - (s.ts || 0) > 20 * 60 * 1000) return null;

    const t = normalizeTr(raw);
    if (!t) return null;

    const mNum = t.match(/^\s*([1-9])\s*[\.\)\-:]?/);

    if (mNum) {
      const idx = Number(mNum[1]) - 1;
      const it = s.items[idx];
      if (!it) return null;
      if (s.type === 'slot') return { type: 'slot', startAt: String(it.value) };
      if (s.type === 'appt') return { type: 'appt', apptId: String(it.value) };
      if (s.type === 'editAction')
        return { type: 'editAction', action: String(it.value) as any };
      return null;
    }

    if (s.type === 'slot') {
      const tm = parseTimeBest(t);
      if (tm) {
        const hhmm = `${String(tm.hh).padStart(2, '0')}:${String(tm.mm).padStart(2, '0')}`;
        const hit = s.items.find((it) => normalizeTr(it.label).endsWith(hhmm));
        if (hit) return { type: 'slot', startAt: String(hit.value) };
      }
      const hit2 = s.items.find(
        (it) => normalizeTr(it.label) === normalizeTr(raw),
      );
      if (hit2) return { type: 'slot', startAt: String(hit2.value) };
    }

    if (s.type === 'appt') {
      const hit = s.items.find((it) =>
        normalizeTr(it.label).includes(normalizeTr(raw)),
      );
      if (hit) return { type: 'appt', apptId: String(hit.value) };
    }

    // ✅ editAction text mapping
    if (s.type === 'editAction') {
      const tt = normalizeTr(raw);
      const map: Array<[string, any]> = [
        ['time', 'TIME'],
        ['tarih', 'TIME'],
        ['saat', 'TIME'],
        ['service', 'SERVICE'],
        ['hizmet', 'SERVICE'],
        ['islem', 'SERVICE'],
        ['işlem', 'SERVICE'],
        ['cancel', 'CANCEL'],
        ['iptal', 'CANCEL'],
        ['abort', 'ABORT'],
        ['vazgec', 'ABORT'],
        ['vazgeç', 'ABORT'],
        ['bosver', 'ABORT'],
        ['boşver', 'ABORT'],
      ];
      for (const [k, v] of map) {
        if (tt.includes(normalizeTr(k)))
          return { type: 'editAction', action: v };
      }
    }

    return null;
  }

  // =========================
  // Natural booking prompts
  // =========================
  private async naturalAsk(
    session: SessionState,
    slot: 'service' | 'name' | 'datetime',
    ctx: { services: any[]; staff: any[]; business: any },
  ): Promise<string> {
    const fallback = () => {
      if (slot === 'service') return this.humanizeAsk('service');
      if (slot === 'name') return this.humanizeAsk('name');
      return this.humanizeAsk('datetime');
    };

    if (!this.openai) return fallback();

    const missingHint =
      slot === 'service'
        ? 'Müşteriden sadece hangi hizmet istediğini sor.'
        : slot === 'name'
          ? 'Müşteriden ad soyadını sor. Kısa ve doğal sor.'
          : 'Müşteriden gün ve saat bilgisini sor. Örnek format ver ama çok uzun yazma. Saat aralığı 08:00-22:00.';

    const staffNamesShort = staffToTextShort(ctx.staff) || '';

    // Build a dynamic system prompt. If we have a business profile name use it,
    // otherwise fall back to a generic “işletme” descriptor. This avoids
    // hard‑coding any specific sector such as beauty and keeps the wording
    // neutral for multi‑tenant deployments.
    const businessLabel = ctx.business?.name
      ? String(ctx.business.name)
      : 'işletme';
    const sys = `
Sen bir ${businessLabel} için telefonda rezervasyon asistanısın. Türkçe konuş.
Stil:
- Samimi, kısa, doğal telefon konuşması.
- Resmi dil yok, gereksiz uzunluk yok.
- Parantez içinde talimat verme — sadece doğal bir soru sor.
Kurallar:
- Sadece TEK soru sor. Tek cümle ideal, en fazla 2 cümle.
- Kullanıcıyı yormadan ilerlet.
- Listeyi boca etme.
- Randevu tarihi/saatini ASLA uydurma.
- Randevu bilgisi sadece sistemden gelir.
- Eğer kullanıcı randevu saatini/tarihini soruyorsa cevap üretme; bunu sistemin listelemesi gerekir.
- Emin olmadığın veriyi kesinmiş gibi söyleme.

`.trim();

    const user = `
Görev: Rezervasyon akışında eksik bilgi var.
Eksik alan: ${slot}
İpucu: ${missingHint}

Mevcut seçimler:
- serviceId: ${session.draft.serviceId || 'YOK'}
- staffId: ${session.draft.staffId || 'YOK'}
- name: ${session.draft.customerName || 'YOK'}
- startAt: ${session.draft.startAt || 'YOK'}

Personeller (kısa, sadece referans):
${staffNamesShort || 'YOK'}
`.trim();

    try {
      // log LLM request for naturalAsk prompts
      this.logAction('llm_request', { mode: 'naturalAsk', slot });
      const resp = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
      });

      const outRaw = (resp.choices?.[0]?.message?.content || '').trim();
      const cleaned = this.sanitizeLlmOutput(outRaw);
      // log LLM response for naturalAsk
      this.logAction('llm_response', {
        mode: 'naturalAsk',
        slot,
        response: cleaned,
      });
      if (!cleaned || cleaned.length < 2) return fallback();
      return cleaned;
    } catch {
      return fallback();
    }
  }

  private askService(services: any[], opts: { gentle: boolean }) {
    return opts.gentle
      ? 'Hangi hizmet için yardımcı olayım?'
      : 'Hangi hizmeti istersiniz?';
  }

  private buildNaturalConfirmationPrompt(
    session: SessionState,
    services: any[],
    staff: any[],
    opts?: { editMode?: boolean; seed?: string },
  ) {
    const draft = session.draft || ({} as BookingDraft);
    const serviceName =
      services.find((item: any) => String(item?.id) === String(draft.serviceId))
        ?.name ||
      session.lastServiceName ||
      'randevu';
    const whenText = draft.startAt ? prettyIstanbul(draft.startAt) : null;

    const summary = opts?.editMode
      ? ['Tamam,', `${serviceName} için`, whenText || '', 'güncelliyorum.']
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      : 'Uygunluk durumunu kontrol ederek rezervasyonunuzu oluşturuyorum.';

    return `${summary} ${this.softYesNoHint(opts?.seed || draft.startAt)}`.trim();
  }

  // =========================
  // ✅ Learned context (customers + appointments)
  // =========================
  private async safeGetLearnedCustomerContext(
    tenantId: string,
    phone: string,
    services: any[],
  ): Promise<LearnedCustomerContext> {
    try {
      const customer = await (this.prisma as any).customers
        ?.findUnique({
          where: { tenantId_phoneNumber: { tenantId, phoneNumber: phone } },
          select: { id: true, name: true },
        })
        .catch(() => null);

      if (!customer?.id) return { name: null, summary: '' };

      const appts = await (this.prisma as any).appointments
        ?.findMany({
          where: { tenantId, customerId: String(customer.id) },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { serviceId: true },
        })
        .catch(() => []);

      const serviceCount = new Map<
        string,
        { id: string; name: string; c: number }
      >();
      for (const a of appts || []) {
        const sid = a?.serviceId ? String(a.serviceId) : '';
        if (!sid) continue;
        const svc = services.find((x: any) => String(x.id) === sid);
        const sname = svc?.name ? String(svc.name) : '';
        if (!sname) continue;
        const prev = serviceCount.get(sid) || { id: sid, name: sname, c: 0 };
        prev.c += 1;
        serviceCount.set(sid, prev);
      }
      const topSvc = [...serviceCount.values()].sort((x, y) => y.c - x.c)[0];

      const name = customer?.name ? String(customer.name) : null;
      const summaryParts: string[] = [];
      if (name) summaryParts.push(`Müşteri adı: ${name}`);
      if (topSvc?.name) summaryParts.push(`Müşteri en sık: ${topSvc.name}`);

      return {
        customerId: String(customer.id),
        name,
        summary: summaryParts.join(' • '),
        topServiceId: topSvc?.id,
        topServiceName: topSvc?.name,
      };
    } catch {
      return { name: null, summary: '' };
    }
  }

  // =========================
  // Clash check (OVERLAP): date + staff + [time,endTime)
  // =========================
  private hhmmToMinutes(hhmm: string) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  private overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) {
    const as = this.hhmmToMinutes(aStart);
    const ae = this.hhmmToMinutes(aEnd);
    const bs = this.hhmmToMinutes(bStart);
    const be = this.hhmmToMinutes(bEnd);
    if (as == null || ae == null || bs == null || be == null) return false;
    return as < be && bs < ae;
  }

  private async findOverlapSafe(opts: {
    tenantId: string;
    staffId: string;
    dateAtUtcMidnight: Date;
    timeHHMM: string;
    endTimeHHMM: string;
    ignoreAppointmentId?: string;
  }) {
    const {
      tenantId,
      staffId,
      dateAtUtcMidnight,
      timeHHMM,
      endTimeHHMM,
      ignoreAppointmentId,
    } = opts;

    const existing = await (this.prisma as any).appointments
      .findMany({
        where: { tenantId, staffId, date: dateAtUtcMidnight },
        select: { id: true, time: true, endTime: true },
        take: 200,
      })
      .catch(() => []);

    for (const a of existing || []) {
      if (ignoreAppointmentId && String(a?.id) === String(ignoreAppointmentId))
        continue;
      const s = String(a?.time || '');
      const e = String(a?.endTime || '');
      if (!s || !e) continue;
      if (this.overlaps(timeHHMM, endTimeHHMM, s, e))
        return { id: String(a.id) };
    }
    return null;
  }

  private async resolveInternalStaffAssignment(opts: {
    tenantId: string;
    draft: BookingDraft;
    staffFallbackList?: any[];
    ignoreAppointmentId?: string;
  }): Promise<{ staffId: string; staffName?: string | null } | null> {
    const { tenantId, draft, staffFallbackList, ignoreAppointmentId } = opts;
    const serviceId = draft.serviceId ? String(draft.serviceId) : '';
    const startAt = draft.startAt ? String(draft.startAt) : '';
    if (!serviceId || !startAt) return null;

    const service = await (this.prisma as any).services
      .findFirst({
        where: { id: serviceId, tenantId },
        select: { id: true, duration: true },
      })
      .catch(() => null);
    if (!service) return null;

    const staffList = (
      staffFallbackList?.length
        ? staffFallbackList
        : await this.safeListStaff(tenantId)
    )
      .filter(Boolean)
      .sort((a: any, b: any) =>
        String(a?.id || '').localeCompare(String(b?.id || ''), 'tr'),
      );
    if (!staffList.length) return null;

    const durationMinutes = Number(service.duration) || 30;
    const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(
      startAt,
      durationMinutes,
    );

    for (const item of staffList) {
      const staffId = String(item?.id || '');
      if (!staffId) continue;
      const clash = await this.findOverlapSafe({
        tenantId,
        staffId,
        dateAtUtcMidnight,
        timeHHMM,
        endTimeHHMM: endTimeHHMM || timeHHMM,
        ignoreAppointmentId,
      });
      if (!clash) {
        return {
          staffId,
          staffName: String(item?.name || item?.fullName || '') || null,
        };
      }
    }

    const fallback = staffList[0];
    return fallback?.id
      ? {
          staffId: String(fallback.id),
          staffName: String(fallback?.name || fallback?.fullName || '') || null,
        }
      : null;
  }

  private async precheckAndPrepareConfirm(opts: {
    tenantId: string;
    draft: BookingDraft;
    ignoreAppointmentId?: string;
  }): Promise<
    | { ok: true; summary: string }
    | {
        ok: false;
        code?: string;
        suggestions?: Array<{ startAt: string; endAt: string }>;
      }
  > {
    const { tenantId, draft, ignoreAppointmentId } = opts;

    if (!draft.serviceId || !draft.startAt || !draft.customerPhone)
      return { ok: false };

    const service = await (this.prisma as any).services
      .findFirst({
        where: { id: String(draft.serviceId), tenantId },
        select: { id: true, name: true, duration: true, price: true },
      })
      .catch(() => null);
    if (!service) return { ok: false };

    const resolvedStaff = await this.resolveInternalStaffAssignment({
      tenantId,
      draft,
    });
    if (!resolvedStaff?.staffId) return { ok: false };
    draft.staffId = resolvedStaff.staffId;

    const staffRec = await (this.prisma as any).staff
      ?.findFirst({
        where: { id: String(resolvedStaff.staffId), tenantId },
        select: { id: true, name: true },
      })
      .catch(() => null);

    const startIso = String(draft.startAt);
    const startUtc = new Date(startIso);
    const durationMinutes = Number(service.duration) || 30;

    const endIso = toIstanbulIso(
      new Date(startUtc.getTime() + durationMinutes * 60000),
    );
    if (
      !isWithinWorkingHoursIso(startIso) ||
      !isEndWithinWorkingHoursIso(endIso)
    ) {
      const suggestions = suggestWorkingHourAlternatives(startIso, 5).map(
        (s) => ({ startAt: s, endAt: s }),
      );
      return { ok: false, code: 'OUT_OF_HOURS', suggestions };
    }

    const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(
      startIso,
      durationMinutes,
    );

    const clash = await this.findOverlapSafe({
      tenantId,
      staffId: String(resolvedStaff.staffId),
      dateAtUtcMidnight,
      timeHHMM,
      endTimeHHMM: endTimeHHMM || timeHHMM,
      ignoreAppointmentId,
    });

    if (clash) {
      const suggestions = await this.suggestSlotsSimple({
        tenantId,
        staffId: String(resolvedStaff.staffId),
        startFromIso: startIso,
        durationMinutes,
        stepMinutes: 15,
        maxSuggestions: 5,
        searchDays: 7,
      });
      return { ok: false, code: 'SLOT_TAKEN', suggestions };
    }

    const name = (draft.customerName || '').trim();
    const serviceName = String(service.name || 'Hizmet');
    const staffName = staffRec?.name ? String(staffRec.name) : null;

    const lines: string[] = [];
    lines.push('Randevu özeti:');
    lines.push(
      `• Hizmet: ${serviceName}${service.price != null ? ` — ${service.price}₺` : ''}`,
    );
    if (staffName) lines.push(`• Personel: ${staffName}`);
    lines.push(`• Tarih/Saat: ${prettyIstanbul(startIso)}`);
    if (name) lines.push(`• İsim: ${name}`);

    return { ok: true, summary: lines.join('\n') };
  }

  // =========================
  // CREATE
  // =========================
  private buildMessageConversationId(draft: BookingDraft) {
    return String(
      draft.messageSessionId ||
        `${draft.tenantId}:${draft.customerPhone || 'unknown-customer'}`,
    ).trim();
  }

  private buildMessageSessionId(conversationId: string) {
    const hash = crypto
      .createHash('sha256')
      .update(conversationId)
      .digest('hex');
    return `msg_${hash}`;
  }

  private async ensureAppointmentSessionLinks(args: {
    tenantId: string;
    customerId: string;
    customerPhone: string;
    draft: BookingDraft;
  }) {
    const now = new Date();

    if (args.draft.channel === 'VOICE') {
      const callSessionId = String(args.draft.callSessionId || '').trim();
      if (!callSessionId) {
        return {
          channel: 'VOICE' as const,
          messageSessionId: null,
          callSessionId: null,
        };
      }

      const callSession =
        await (this.prisma as any).call_sessions.upsert({
          where: { id: callSessionId },
          update: {
            customerId: args.customerId,
            from: args.customerPhone,
            updatedAt: now,
          } as any,
          create: {
            id: callSessionId,
            tenantId: args.tenantId,
            customerId: args.customerId,
            callSid: callSessionId,
            from: args.customerPhone,
            status: 'completed',
            createdAt: now,
            updatedAt: now,
          } as any,
          select: { id: true },
        });

      return {
        channel: 'VOICE' as const,
        messageSessionId: null,
        callSessionId: String(callSession.id),
      };
    }

    const conversationId = this.buildMessageConversationId(args.draft);
    const messageSessionId = this.buildMessageSessionId(conversationId);

    const messageSession =
      await (this.prisma as any).message_sessions.upsert({
        where: { conversationId },
        update: {
          customerId: args.customerId,
          channel: 'WHATSAPP',
          isActive: true,
          lastMessageAt: now,
          updatedAt: now,
        } as any,
        create: {
          id: messageSessionId,
          tenantId: args.tenantId,
          customerId: args.customerId,
          channel: 'WHATSAPP',
          conversationId,
          isActive: true,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        } as any,
        select: { id: true },
      });

    return {
      channel: 'WHATSAPP' as const,
      messageSessionId: String(messageSession.id),
      callSessionId: null,
    };
  }

  private async createAppointment(opts: {
    tenantId: string;
    draft: BookingDraft;
    staffFallbackList: any[];
  }): Promise<
    | { ok: true; data: { appointmentId: string; startAt: string } }
    | {
        ok: false;
        code?: string;
        suggestions?: Array<{ startAt: string; endAt: string }>;
      }
  > {
    const { tenantId, draft, staffFallbackList } = opts;

    try {
      const serviceId = String(draft.serviceId || '');
      let staffId = draft.staffId ? String(draft.staffId) : '';
      const startAt = String(draft.startAt || '');
      const customerPhone = String(draft.customerPhone || '');
      const customerName = draft.customerName
        ? String(draft.customerName)
        : null;

      if (!serviceId || !startAt || !customerPhone) return { ok: false };
  
      if (!isWithinWorkingHoursIso(startAt)) {
        const suggestions = suggestWorkingHourAlternatives(startAt, 5).map(
          (s) => ({ startAt: s, endAt: s }),
        );
        return { ok: false, code: 'OUT_OF_HOURS', suggestions };
      }

      const service = await (this.prisma as any).services
        .findFirst({
          where: { id: serviceId, tenantId },
          select: { id: true, name: true, duration: true },
        })
        .catch(() => null);
      if (!service) return { ok: false };

      if (!staffId) {
        const resolvedStaff = await this.resolveInternalStaffAssignment({
          tenantId,
          draft,
          staffFallbackList,
        });
        if (!resolvedStaff?.staffId) return { ok: false };
        staffId = resolvedStaff.staffId;
        draft.staffId = resolvedStaff.staffId;
      }

      const fullName = (customerName || 'Misafir Müşteri').trim();

      const now = new Date();
      const customer = await (this.prisma as any).customers.upsert({
        where: {
          tenantId_phoneNumber: { tenantId, phoneNumber: customerPhone },
        },
        update: {
          name: fullName,
          updatedAt: now,
        } as any,
        create: {
          id: crypto.randomUUID(),
          tenantId,
          phoneNumber: customerPhone,
          name: fullName,
          createdAt: now,
          updatedAt: now,
        } as any,
        select: { id: true } as any,
      });
      const customerId = String(customer.id);

      const durationMinutes = Number(service.duration) || 30;
      const endIso = toIstanbulIso(
        new Date(new Date(startAt).getTime() + durationMinutes * 60000),
      );
      if (!isEndWithinWorkingHoursIso(endIso)) {
        const suggestions = suggestWorkingHourAlternatives(startAt, 5).map(
          (s) => ({ startAt: s, endAt: s }),
        );
        return { ok: false, code: 'OUT_OF_HOURS', suggestions };
      }

      const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(
        startAt,
        durationMinutes,
      );

      const clash = await this.findOverlapSafe({
        tenantId,
        staffId,
        dateAtUtcMidnight,
        timeHHMM,
        endTimeHHMM: endTimeHHMM || timeHHMM,
      });

      if (clash) {
        const suggestions = await this.suggestSlotsSimple({
          tenantId,
          staffId,
          startFromIso: startAt,
          durationMinutes,
          stepMinutes: 15,
          maxSuggestions: 5,
          searchDays: 7,
        });
        return { ok: false, code: 'SLOT_TAKEN', suggestions };
      }

      const sessionLinks = await this.ensureAppointmentSessionLinks({
        tenantId,
        customerId,
        customerPhone,
        draft,
      });

      const appt = await (this.prisma as any).appointments.create({
        data: {
          tenantId,
          customerId,
          serviceId: String(service.id),
          staffId,
          date: dateAtUtcMidnight,
          time: timeHHMM,
          endTime: endTimeHHMM,
          status: 'PENDING',
          channel: sessionLinks.channel,
          messageSessionId: sessionLinks.messageSessionId,
          callSessionId: sessionLinks.callSessionId,
          updatedAt: new Date(),
        } as any,
        select: { id: true },
      });

      const apptIdStr = String(appt.id);
      // log appointment creation for observability
      this.logAction('appointment_created', {
        tenantId,
        phone: customerPhone,
        serviceId: serviceId,
        staffId: staffId,
        startAt,
        appointmentId: apptIdStr,
      });
      return { ok: true, data: { appointmentId: apptIdStr, startAt } };
    } catch (e: any) {
      this.logger.error(`[createAppointment] failed hard: ${e?.message || e}`);
      return { ok: false, code: 'ERROR' };
    }
  }

  // =========================
  // UPDATE / CANCEL (EDIT)
  // =========================
  private buildEditCancelSummary(
    snap: NonNullable<SessionState['targetApptSnapshot']>,
  ) {
    const parts: string[] = [];
    parts.push('Şu randevunuzu iptal edeyim mi?');
    parts.push(`• Tarih/Saat: ${prettyIstanbul(snap.startAtIso)}`);
    if (snap.serviceName) parts.push(`• Hizmet: ${snap.serviceName}`);
    if (snap.staffName) parts.push(`• Personel: ${snap.staffName}`);
    return parts.join('\n');
  }

  private async safeCancelAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<boolean> {
    try {
      await (this.prisma as any).appointments.update({
        where: { id: String(appointmentId) },
        data: { status: 'CANCELLED', updatedAt: new Date() } as any,
      });
      // log soft cancellation (status marked CANCELLED)
      this.logAction('appointment_cancelled', {
        tenantId,
        appointmentId: String(appointmentId),
      });
      return true;
    } catch {
      try {
        await (this.prisma as any).appointments.delete({
          where: { id: String(appointmentId) },
        });
        // log hard cancellation when record is deleted
        this.logAction('appointment_cancelled', {
          tenantId,
          appointmentId: String(appointmentId),
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Cancels multiple appointments by marking their status as CANCELLED. Used when
   * the user requests to cancel “hepsi/tümü” of their upcoming appointments. Each
   * appointment is updated individually. Returns true if all cancellations
   * succeed. If any update fails, the function returns false.
   */
  private async safeCancelMultipleAppointments(
    tenantId: string,
    appointmentIds: string[],
  ): Promise<boolean> {
    try {
      for (const apptId of appointmentIds || []) {
        try {
          await (this.prisma as any).appointments.update({
            where: { id: String(apptId) },
            data: { status: 'CANCELLED', updatedAt: new Date() } as any,
          });
          this.logAction('appointment_cancelled', {
            tenantId,
            appointmentId: String(apptId),
          });
        } catch {
          // If update fails, attempt delete as fallback
          try {
            await (this.prisma as any).appointments.delete({
              where: { id: String(apptId) },
            });
            this.logAction('appointment_cancelled', {
              tenantId,
              appointmentId: String(apptId),
            });
          } catch {
            return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async updateAppointment(opts: {
    tenantId: string;
    appointmentId: string;
    draft: BookingDraft;
  }): Promise<
    | { ok: true; data: { appointmentId: string; startAt: string } }
    | {
        ok: false;
        code?: string;
        suggestions?: Array<{ startAt: string; endAt: string }>;
      }
  > {
    const { tenantId, appointmentId, draft } = opts;

    try {
      const current = await (this.prisma as any).appointments
        .findUnique({
          where: { id: String(appointmentId) },
          select: {
            id: true,
            tenantId: true,
            customerId: true,
            serviceId: true,
            staffId: true,
            date: true,
            time: true,
            channel: true,
            messageSessionId: true,
            callSessionId: true,
          },
        })
        .catch(() => null);

      if (!current?.id) return { ok: false, code: 'NOT_FOUND' };
      if (String(current.tenantId) !== String(tenantId))
        return { ok: false, code: 'NOT_FOUND' };

      const currentStartIso = this.schemaDateTimeToStartIso(
        current.date,
        String(current.time || '00:00'),
      );

      const newServiceId = draft.serviceId
        ? String(draft.serviceId)
        : String(current.serviceId);
      const newStaffId = draft.staffId
        ? String(draft.staffId)
        : String(current.staffId);
      const newStartAt = draft.startAt
        ? String(draft.startAt)
        : String(currentStartIso);

      if (!isWithinWorkingHoursIso(newStartAt)) {
        const suggestions = suggestWorkingHourAlternatives(newStartAt, 5).map(
          (s) => ({ startAt: s, endAt: s }),
        );
        return { ok: false, code: 'OUT_OF_HOURS', suggestions };
      }

      const service = await (this.prisma as any).services
        .findFirst({
          where: { tenantId, id: newServiceId },
          select: { id: true, duration: true },
        })
        .catch(() => null);
      if (!service) return { ok: false, code: 'BAD_SERVICE' };

      const durationMinutes = Number(service.duration) || 30;

      const endIso = toIstanbulIso(
        new Date(new Date(newStartAt).getTime() + durationMinutes * 60000),
      );
      if (!isEndWithinWorkingHoursIso(endIso)) {
        const suggestions = suggestWorkingHourAlternatives(newStartAt, 5).map(
          (s) => ({ startAt: s, endAt: s }),
        );
        return { ok: false, code: 'OUT_OF_HOURS', suggestions };
      }

      const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(
        newStartAt,
        durationMinutes,
      );

      const clash = await this.findOverlapSafe({
        tenantId,
        staffId: newStaffId,
        dateAtUtcMidnight,
        timeHHMM,
        endTimeHHMM: endTimeHHMM || timeHHMM,
        ignoreAppointmentId: String(appointmentId),
      });

      if (clash) {
        const suggestions = await this.suggestSlotsSimple({
          tenantId,
          staffId: newStaffId,
          startFromIso: newStartAt,
          durationMinutes,
          stepMinutes: 15,
          maxSuggestions: 5,
          searchDays: 7,
        });
        return { ok: false, code: 'SLOT_TAKEN', suggestions };
      }

      const sessionLinks = await this.ensureAppointmentSessionLinks({
        tenantId,
        customerId: String(current.customerId),
        customerPhone: String(draft.customerPhone || ''),
        draft: {
          ...draft,
          channel: draft.channel || (current.callSessionId ? 'VOICE' : 'WHATSAPP'),
          messageSessionId:
            draft.messageSessionId || String(current.messageSessionId || ''),
          callSessionId:
            draft.callSessionId || String(current.callSessionId || ''),
        },
      });

      await (this.prisma as any).appointments.update({
        where: { id: String(appointmentId) },
        data: {
          serviceId: newServiceId,
          staffId: newStaffId,
          date: dateAtUtcMidnight,
          time: timeHHMM,
          endTime: endTimeHHMM,
          channel: sessionLinks.channel,
          messageSessionId: sessionLinks.messageSessionId,
          callSessionId: sessionLinks.callSessionId,
          updatedAt: new Date(),
        } as any,
      });

      // emit log for appointment update
      this.logAction('appointment_updated', {
        tenantId,
        appointmentId: String(appointmentId),
        startAt: newStartAt,
        serviceId: newServiceId,
        staffId: newStaffId,
      });
      return {
        ok: true,
        data: { appointmentId: String(appointmentId), startAt: newStartAt },
      };
    } catch (e: any) {
      this.logger.error(`[updateAppointment] failed hard: ${e?.message || e}`);
      return { ok: false, code: 'ERROR' };
    }
  }

  private schemaDateTimeToStartIso(dateUtcMidnight: Date, timeHHMM: string) {
    const yy = dateUtcMidnight.getUTCFullYear();
    const mm = dateUtcMidnight.getUTCMonth();
    const dd = dateUtcMidnight.getUTCDate();
    const m = String(timeHHMM || '').match(/^(\d{1,2}):(\d{2})$/);
    const hh = m ? Number(m[1]) : 0;
    const mi = m ? Number(m[2]) : 0;
    const dUtc = new Date(Date.UTC(yy, mm, dd, hh - 3, mi, 0, 0));
    return toIstanbulIso(dUtc);
  }

  private async safeListUpcomingAppointmentsByPhone(
    tenantId: string,
    phone: string,
    limit: number,
  ): Promise<UpcomingAppt[]> {
    try {
      const customer = await (this.prisma as any).customers
        .findUnique({
          where: { tenantId_phoneNumber: { tenantId, phoneNumber: phone } },
          select: { id: true },
        })
        .catch(() => null);

      if (!customer?.id) return [];

      const nowTr = new Date(Date.now() + IST_OFFSET_MS);
      const y = nowTr.getUTCFullYear();
      const m = nowTr.getUTCMonth();
      const d = nowTr.getUTCDate();
      const todayUtcMidnight = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
      const nowHHMM = `${String(nowTr.getUTCHours()).padStart(2, '0')}:${String(nowTr.getUTCMinutes()).padStart(2, '0')}`;

      const appts = await (this.prisma as any).appointments
        .findMany({
          where: {
            tenantId,
            customerId: String(customer.id),
            // Do not include cancelled/completed/no-show appointments in upcoming lists
            status: { in: ['PENDING', 'CONFIRMED'] },
            OR: [
              { date: { gt: todayUtcMidnight } },
              { date: todayUtcMidnight, time: { gte: nowHHMM } },
            ],
          },
          orderBy: [{ date: 'asc' }, { time: 'asc' }],
          take: Math.max(1, Math.min(20, limit || 6)),
          select: {
            id: true,
            serviceId: true,
            staffId: true,
            date: true,
            time: true,
          },
        })
        .catch(() => []);

      if (!appts?.length) return [];

      const svcIds = [
        ...new Set(
          appts.map((a: any) => String(a.serviceId || '')).filter(Boolean),
        ),
      ];
      const stfIds = [
        ...new Set(
          appts.map((a: any) => String(a.staffId || '')).filter(Boolean),
        ),
      ];

      const [svcs, stfs] = await Promise.all([
        (this.prisma as any).services
          .findMany({
            where: { tenantId, id: { in: svcIds } },
            select: { id: true, name: true },
            take: 100,
          })
          .catch(() => []),
        (this.prisma as any).staff
          .findMany({
            where: { tenantId, id: { in: stfIds } },
            select: { id: true, name: true },
            take: 100,
          })
          .catch(() => []),
      ]);

      const svcMap = new Map<string, string>();
      for (const s of svcs || [])
        svcMap.set(String(s.id), String(s.name || ''));

      const stfMap = new Map<string, string>();
      for (const p of stfs || [])
        stfMap.set(String(p.id), String(p.name || ''));

      return (appts || []).map((a: any) => {
        const startAtIso = this.schemaDateTimeToStartIso(
          a.date,
          String(a.time || '00:00'),
        );
        return {
          id: String(a.id),
          serviceId: String(a.serviceId),
          staffId: String(a.staffId),
          date: a.date,
          time: String(a.time || ''),
          startAtIso,
          serviceName: svcMap.get(String(a.serviceId)) || undefined,
          staffName: stfMap.get(String(a.staffId)) || undefined,
        };
      });
    } catch {
      return [];
    }
  }

  // =========================
  // suggestions
  // =========================
  private async suggestSlotsSimple(opts: {
    tenantId: string;
    staffId: string;
    startFromIso: string;
    durationMinutes: number;
    stepMinutes: number;
    maxSuggestions: number;
    searchDays: number;
  }) {
    const {
      tenantId,
      staffId,
      startFromIso,
      durationMinutes,
      stepMinutes,
      maxSuggestions,
      searchDays,
    } = opts;

    const startUtc = new Date(startFromIso);
    const suggestions: Array<{ startAt: string; endAt: string }> = [];

    let cursor = startUtc;
    for (
      let day = 0;
      day < searchDays && suggestions.length < maxSuggestions;
      day++
    ) {
      const dayTr = new Date(cursor.getTime() + IST_OFFSET_MS);
      const y = dayTr.getUTCFullYear();
      const m = dayTr.getUTCMonth();
      const d = dayTr.getUTCDate();

      const dateAtUtcMidnight = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));

      const existing = await (this.prisma as any).appointments
        .findMany({
          where: { tenantId, staffId, date: dateAtUtcMidnight },
          select: { time: true, endTime: true },
          take: 200,
        })
        .catch(() => []);

      const taken = (existing || [])
        .map((x: any) => ({
          s: String(x?.time || ''),
          e: String(x?.endTime || ''),
        }))
        .filter((x: any) => x.s && x.e);

      for (
        let hh = WORK_START_HH;
        hh < WORK_END_HH && suggestions.length < maxSuggestions;
        hh++
      ) {
        for (
          let mm = 0;
          mm < 60 && suggestions.length < maxSuggestions;
          mm += stepMinutes
        ) {
          const candUtc = new Date(Date.UTC(y, m, d, hh - 3, mm, 0, 0));
          const candIso = toIstanbulIso(candUtc);

          if (!isWithinWorkingHoursIso(candIso)) continue;

          const { timeHHMM, endTimeHHMM } = toSchemaDateTime(
            candIso,
            durationMinutes,
          );

          const endIso = toIstanbulIso(
            new Date(candUtc.getTime() + durationMinutes * 60000),
          );
          if (!isEndWithinWorkingHoursIso(endIso)) continue;

          const clash = taken.some((t: any) =>
            this.overlaps(timeHHMM, endTimeHHMM || timeHHMM, t.s, t.e),
          );
          if (!clash) suggestions.push({ startAt: candIso, endAt: candIso });
        }
      }

      cursor = addDaysMs(cursor, 1);
    }

    return suggestions;
  }

  // =========================
  // LLM
  // =========================
  private async answerWithLLM(opts: {
    raw: string;
    business: any;
    services: any[];
    staff: any[];
    history: HistoryTurn[];
    mode: 'general' | 'procedure';
    focusService: null | { name: string; duration?: any; price?: any };
    avoidRepeat?: boolean;
    learnedCustomerSummary?: string;
  }): Promise<string> {
    if (!this.openai) return '';

    const {
      raw,
      business,
      services,
      staff,
      history,
      mode,
      focusService,
      avoidRepeat,
      learnedCustomerSummary,
    } = opts;

    // Determine a user facing business name for prompts. Default to a generic
    // descriptor to keep the assistant sector agnostic.
    const bizName = business?.name ? String(business.name) : 'işletme';

    const servicesText = servicesToTextShort(services);
    const staffText = staffToTextShort(staff);

    const historyText =
      history && history.length
        ? history
            .slice(-8)
            .map(
              (h) => `${h.role === 'user' ? 'Müşteri' : 'Asistan'}: ${h.text}`,
            )
            .join('\n')
        : 'YOK';

    let system = `
Sen bir ${bizName} için telefonda rezervasyon asistanısın. Türkçe konuş.
Kurallar:
- Cevaplar KISA olsun (maks 2-4 cümle).
- Durduk yere fiyat listesi veya randevu yönlendirmesi yapma.
- Fiyat sadece müşteri sorarsa ver; mümkünse ilgili hizmete özel ver.
- Müşteri randevu/rezervasyon demeden randevu akışına sokma.
- Prosedür sorularında genel bilgi ver ama kesin tıbbi iddialarda bulunma.
- Aynı mesajı tekrarlama. Gerekirse tek kısa soru sor.
- İnternete erişimin yok; "internetten baktım" gibi şeyler söyleme.
- Resmi dil yok; doğal ve samimi konuş.
- “reis”, “kral” gibi aşırı samimi hitaplar kullanma.
- “Biraz sabret” gibi emir/veriştiren dil kullanma. Nazik ve kısa ol.
`.trim();

    if (mode === 'procedure')
      system += `\n- Prosedür modunda yumuşak ve samimi bir dille yanıt ver; sonunda zorla randevu isteme.`;
    if (avoidRepeat)
      system += `\n- Aynı cümleleri tekrar etme; cevabı farklı söyle.`;

    const user = `
Mod: ${mode}
Müşteri mesajı: ${raw}

Müşteri geçmiş özet (varsa):
${learnedCustomerSummary || 'YOK'}

Odak hizmet (varsa): ${focusService ? JSON.stringify(focusService) : 'YOK'}
İşletme verisi: ${business ? JSON.stringify(business) : 'YOK'}

Hizmetler (kısa):
${servicesText || 'YOK'}

Personeller (kısa):
${staffText || 'YOK'}

Son konuşma geçmişi:
${historyText}
`.trim();

    try {
      // log the LLM request for observability
      this.logAction('llm_request', {
        mode,
        prompt: raw,
      });
      const resp = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: avoidRepeat ? 0.7 : 0.6,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      const outRaw = (resp.choices?.[0]?.message?.content || '').trim();
      const cleaned = this.sanitizeLlmOutput(outRaw);
      // log the LLM response after sanitization
      this.logAction('llm_response', {
        mode,
        response: cleaned,
      });
      return cleaned && cleaned.length >= 2 ? cleaned : '';
    } catch (e: any) {
      this.logger.warn(`[LLM] ${e?.message || e}`);
      return '';
    }
  }

  private procedureTemplateForService(
    serviceName: string,
    duration?: any,
    price?: any,
  ) {
    const parts: string[] = [];
    // Use neutral language so the assistant works across sectors
    parts.push(
      `${serviceName} için süreç ve prosedür hizmetin türüne ve kişisel koşullara göre değişebilir.`,
    );
    if (duration != null)
      parts.push(`Ortalama süre genellikle ${duration} dakika civarındadır.`);
    parts.push(
      'Gerekli adım veya seans sayısı seçilen hizmete ve ihtiyaçlara göre değişebilir.',
    );
    const base = parts.join(' ');
    const priceLine = price != null ? `\nFiyat: ${price}₺` : '';
    return base + priceLine;
  }

  // =========================
  // DB lists
  // =========================
  private async safeGetBusinessProfile(tenantId: string) {
    return this.getCachedVoiceReference(
      `business:${tenantId}`,
      async () =>
        await (this.prisma as any).businessProfile
          ?.findUnique({ where: { tenantId } })
          .catch(() => null),
    );
  }

  private async safeListServices(tenantId: string) {
    return this.getCachedVoiceReference(
      `services:${tenantId}`,
      async () =>
        await (this.prisma as any).services
          .findMany({
            where: { tenantId, isActive: true },
            select: { id: true, name: true, price: true, duration: true },
            take: 50,
          })
          .catch(() => []),
    );
  }

  private async safeListStaff(tenantId: string) {
    return this.getCachedVoiceReference(
      `staff:${tenantId}`,
      async () =>
        await (this.prisma as any).staff
          ?.findMany({
            where: { tenantId, isActive: true },
            select: { id: true, name: true },
            take: 50,
          })
          .catch(() => []),
    );
  }

  private async getCachedVoiceReference<T>(
    key: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const cached = this.voiceReferenceCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const value = await loader();
    this.voiceReferenceCache.set(key, {
      value,
      expiresAt: now + VOICE_REFERENCE_CACHE_TTL_MS,
    });
    return value;
  }

  // =========================
  // Session helpers
  // =========================
  private getOrInitSession(
    key: string,
    tenantId: string,
    phone: string,
  ): SessionState {
    const existing = this.sessions.get(key);
    if (existing) {
      // expire session based on configurable TTL
      if (Date.now() - existing.updatedAt > SESSION_TTL_MS) {
        const fresh = this.makeFreshSession(tenantId, phone);
        this.sessions.set(key, fresh);
        return fresh;
      }
      existing.updatedAt = Date.now();
      return existing;
    }
    const s = this.makeFreshSession(tenantId, phone);
    this.sessions.set(key, s);
    return s;
  }

  private makeFreshSession(tenantId: string, phone: string): SessionState {
    return {
      state: WaState.IDLE,
      draft: { tenantId, customerPhone: phone },
      updatedAt: Date.now(),
      history: [],
      repeatCount: 0,
    };
  }

  private saveSession(key: string, s: SessionState) {
    s.updatedAt = Date.now();
    this.sessions.set(key, s);
  }

  /**
   * Compare a full ISO date string against a YYYY-MM-DD value in Turkish timezone.
   * This helper was previously defined outside the class which broke compilation.
   * It is now a proper private method on the service.
   */
  private isSameTrDate(iso: string, ymd: string): boolean {
    const p = getTrPartsFromIso(iso);
    if (!p) return false;
    const target = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return false;
    const got = `${String(p.y)}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    return got === target;
  }

  private softResetSession(
    s: SessionState,
    tenantId: string,
    phone: string,
    opts?: { keepIdempotency?: boolean },
  ) {
    const keep = Boolean(opts?.keepIdempotency);

    const lastCreatedBookingKey = s.lastCreatedBookingKey;
    const lastCreatedAppointmentId = s.lastCreatedAppointmentId;
    const lastCreatedAt = s.lastCreatedAt;

    s.state = WaState.IDLE;
    s.draft = { tenantId, customerPhone: phone };

    s.pendingStartAt = undefined;
    s.pendingDateOnly = undefined;
    s.pendingSummary = undefined;

    s.lastSuggestions = undefined;
    s.suggestedServiceId = undefined;
    s.suggestedServiceName = undefined;

    // ✅ edit reset
    s.editMode = undefined;
    s.targetAppointmentId = undefined;
    s.targetApptSnapshot = undefined;

    if (keep) {
      s.lastCreatedBookingKey = lastCreatedBookingKey;
      s.lastCreatedAppointmentId = lastCreatedAppointmentId;
      s.lastCreatedAt = lastCreatedAt;
    } else {
      s.lastCreatedBookingKey = undefined;
      s.lastCreatedAppointmentId = undefined;
      s.lastCreatedAt = undefined;
    }
  }

  private updateContinuityMemory(
    session: SessionState,
    _services: any[],
    _staff: any[],
  ) {
    const draft = session.draft || ({} as BookingDraft);

    if (draft.serviceId) session.lastServiceId = String(draft.serviceId);
    if (draft.staffId) session.recentStaffId = String(draft.staffId);

    session.bookingDraftSnapshot = {
      serviceId: draft.serviceId ? String(draft.serviceId) : undefined,
      staffId: draft.staffId ? String(draft.staffId) : undefined,
      startAt: draft.startAt ? String(draft.startAt) : undefined,
      updatedAt: Date.now(),
    };
  }

  private tryCarryRecentServiceContext(session: SessionState, services: any[]) {
    if (session.draft.serviceId) return;
    const recentServiceId = session.lastServiceId
      ? String(session.lastServiceId)
      : '';
    if (!recentServiceId) return;
    const hit = services.find((s: any) => String(s?.id) === recentServiceId);
    if (!hit?.id) return;
    session.draft.serviceId = String(hit.id);
  }

  private tryCarryRecentStaffContext(session: SessionState, staff: any[]) {
    if (session.draft.staffId) return;
    const recentStaffId = session.recentStaffId
      ? String(session.recentStaffId)
      : '';
    if (!recentStaffId) return;
    const hit = staff.find((item: any) => String(item?.id) === recentStaffId);
    if (!hit?.id) return;
    session.draft.staffId = String(hit.id);
    session.draft.requestedStaffName = undefined;
  }

  private resolveContinuityContext(opts: {
    session: SessionState;
    raw: string;
    services: any[];
    staff: any[];
    isVoice: boolean;
    phase: 'pre_intent' | 'pre_missing_slot';
  }): ContinuityResolution {
    const { session, raw, services, staff, isVoice, phase } = opts;
    const resolution: ContinuityResolution = {
      inferredBookingContinuation: false,
      usedRecentService: false,
      usedRecentStaff: false,
      usedAssistantSuggestion: false,
      usedDraftSnapshot: false,
      shortFollowUp: this.isShortContextualBookingReply(raw),
    };

    const draft = session.draft || ({} as BookingDraft);
    const normalized = normalizeTr(raw);
    const explicitService = this.detectServiceFromMessage(raw, services);
    const explicitStaff = isNoPreferenceStaff(raw)
      ? null
      : this.detectStaffFromMessage(raw, staff);
    const pickedSuggestion = this.pickFromSuggestions(session, raw);

    if (pickedSuggestion?.type === 'slot' && pickedSuggestion.startAt) {
      draft.startAt = pickedSuggestion.startAt;
      session.pendingStartAt = pickedSuggestion.startAt;
      session.pendingDateOnly = undefined;
      resolution.usedAssistantSuggestion = true;
    }

    if (
      !draft.serviceId &&
      !explicitService?.id &&
      this.shouldUseContinuityService(session, raw, isVoice)
    ) {
      const fromSnapshot = session.bookingDraftSnapshot?.serviceId
        ? String(session.bookingDraftSnapshot.serviceId)
        : '';
      const sourceId = fromSnapshot || session.lastServiceId || '';
      if (sourceId) {
        const hit = services.find((item: any) => String(item?.id) === sourceId);
        if (hit?.id) {
          draft.serviceId = String(hit.id);
          resolution.usedRecentService = true;
          resolution.usedDraftSnapshot = Boolean(fromSnapshot);
          resolution.inferredBookingContinuation = true;
        }
      }
    }

    if (
      !draft.staffId &&
      !explicitStaff?.id &&
      !isNoPreferenceStaff(raw) &&
      this.shouldUseContinuityStaff(session, raw, isVoice)
    ) {
      const sourceId = session.bookingDraftSnapshot?.staffId
        ? String(session.bookingDraftSnapshot.staffId)
        : session.recentStaffId
          ? String(session.recentStaffId)
          : '';
      if (sourceId) {
        const hit = staff.find((item: any) => String(item?.id) === sourceId);
        if (hit?.id) {
          draft.staffId = String(hit.id);
          draft.requestedStaffName = undefined;
          resolution.usedRecentStaff = true;
          resolution.usedDraftSnapshot =
            resolution.usedDraftSnapshot ||
            Boolean(session.bookingDraftSnapshot?.staffId);
          if (phase === 'pre_intent')
            resolution.inferredBookingContinuation = true;
        }
      }
    }

    if (
      resolution.shortFollowUp &&
      (resolution.usedRecentService ||
        resolution.usedRecentStaff ||
        Boolean(session.bookingDraftSnapshot?.serviceId) ||
        session.recentIntentContext === 'booking' ||
        session.recentIntentContext === 'info')
    ) {
      resolution.preservedIntent = 'booking';
      resolution.inferredBookingContinuation = true;
    } else if (resolution.shortFollowUp && session.recentIntentContext) {
      resolution.preservedIntent = session.recentIntentContext;
    }

    if (resolution.preservedIntent) {
      session.recentIntentContext = resolution.preservedIntent;
    } else if (!normalized) {
      resolution.preservedIntent = session.recentIntentContext;
    }

    this.updateContinuityMemory(session, services, staff);
    this.logAction('continuity_resolved', {
      tenantId: draft.tenantId,
      phone: draft.customerPhone,
      phase,
      raw,
      preservedIntent: resolution.preservedIntent || null,
      inferredBookingContinuation: resolution.inferredBookingContinuation,
      usedRecentService: resolution.usedRecentService,
      usedRecentStaff: resolution.usedRecentStaff,
      usedAssistantSuggestion: resolution.usedAssistantSuggestion,
      usedDraftSnapshot: resolution.usedDraftSnapshot,
      state: session.state,
    });
    return resolution;
  }

  // =========================
  // Memory helpers
  // =========================
  private recordHistory(
    session: SessionState,
    role: 'user' | 'assistant',
    text: string,
  ) {
    const clean = (text || '').trim();
    if (!clean) return;
    session.history = session.history || [];
    session.history.push({ role, text: clean, ts: Date.now() });
    if (session.history.length > 20)
      session.history = session.history.slice(-20);
  }

  private getRecentHistory(
    session: SessionState,
    maxTurns: number,
  ): HistoryTurn[] {
    if (!session.history?.length) return [];
    return session.history.slice(-Math.max(1, maxTurns));
  }

  private isLikelyDuplicateInbound(session: SessionState, raw: string) {
    const t = normalizeTr(raw);
    if (!t) return false;
    const now = Date.now();

    if (session.lastUserTextNorm && session.lastUserAt) {
      if (session.lastUserTextNorm === t && now - session.lastUserAt < 15000)
        return true;
    }
    session.lastUserTextNorm = t;
    session.lastUserAt = now;
    return false;
  }

  private isLikelyAssistantEcho(session: SessionState, raw: string) {
    const userNorm = normalizeTr(raw);
    const assistantNorm = normalizeTr(
      session.lastAssistantReply || session.lastAssistantText || '',
    );
    if (!userNorm || !assistantNorm) return false;
    if (userNorm.length < 8) return false;
    if (userNorm === assistantNorm) return true;
    if (
      userNorm.length >= 12 &&
      (assistantNorm.includes(userNorm) || userNorm.includes(assistantNorm))
    ) {
      return true;
    }
    return false;
  }

  private makeBookingKey(tenantId: string, phone: string, draft: BookingDraft) {
    if (!draft?.serviceId || !draft?.startAt) return '';
    const staff = draft.staffId ? String(draft.staffId) : '-';
    return `${tenantId}|${phone}|${String(draft.serviceId)}|${staff}|${String(draft.startAt)}`;
  }

  private safeReply(session: SessionState, reply: string) {
    let out = (reply || '').trim();
    if (!out) out = 'Tamam 👍';

    // Prevent the assistant from claiming it performed actions like booking,
    // cancelling or updating appointments. Such statements should only come
    // from deterministic code after a DB transaction, not from the LLM.
    const outNorm = normalizeTr(out).toLowerCase();
    const banned = [
      'ayarladım',
      'ayarladim',
      'kaydettim',
      'güncelledim',
      'guncelledim',
      'iptal ettim',
      'iptal ettim.',
      'randevuyu kaydettim',
      'randevunuzu kaydettim',
    ];
    if (banned.some((b) => outNorm.includes(b))) {
      out = 'Anladım. Nasıl yardımcı olabilirim?';
    }

    const prev = session.lastAssistantReply || session.lastAssistantText || '';
    const same = prev && normalizeTr(prev) === normalizeTr(out);

    if (same) {
      session.repeatCount = (session.repeatCount || 0) + 1;

      if (session.repeatCount === 1) out = out + ' 🙂';
      else {
        if (session.state !== WaState.IDLE) {
          if (session.state === WaState.WAIT_SERVICE)
            out = this.humanizeAsk('service');
          else if (session.state === WaState.WAIT_DATETIME)
            out = this.humanizeAsk('datetime');
          else out = 'Devam edelim 🙂';
        } else {
          out = 'Anladım 🙂 Nasıl yardımcı olayım?';
        }
        session.repeatCount = 0;
      }
    } else {
      session.repeatCount = 0;
    }

    session.lastAssistantReply = out;
    session.lastAssistantText = out;
    this.recordHistory(session, 'assistant', out);
    // emit structured log for assistant reply
    this.logAction('assistant_reply', {
      tenantId: session.draft?.tenantId,
      phone: session.draft?.customerPhone,
      state: session.state,
      reply: out,
    });
    return out;
  }

  private shouldNudgeBooking(session: SessionState) {
    const recent = this.getRecentHistory(session, 6)
      .map((h) => normalizeTr(h.text))
      .join(' ');
    return (
      recent.includes('randevu') ||
      recent.includes('rezervasyon') ||
      recent.includes('uygun') ||
      recent.includes('yarin') ||
      recent.includes('bugun')
    );
  }

  private shouldPreserveRecentIntentContext(
    session: SessionState,
    raw: string,
  ) {
    const t = normalizeTr(raw);
    if (!t) return true;
    if (t.length > 24) return false;
    if (
      session.recentIntentContext === 'booking' &&
      this.isShortContextualBookingReply(raw)
    ) {
      return true;
    }
    return false;
  }

  private shouldUseContinuityService(
    session: SessionState,
    raw: string,
    isVoice: boolean,
  ) {
    if (!isVoice) return false;
    if (this.hasStrongCarryoverServiceCue(raw)) return true;
    if (!this.isShortContextualBookingReply(raw)) return false;
    return Boolean(
      session.lastServiceId ||
      session.bookingDraftSnapshot?.serviceId ||
      session.recentIntentContext === 'booking' ||
      session.recentIntentContext === 'info',
    );
  }

  private shouldUseContinuityStaff(
    session: SessionState,
    raw: string,
    isVoice: boolean,
  ) {
    return false;
  }

  private resolveServiceForVoiceFollowUp(
    session: SessionState,
    raw: string,
    services: any[],
    isVoice: boolean,
  ) {
    const explicit = this.detectServiceFromMessage(raw, services);
    if (explicit?.id) return explicit;
    if (!isVoice) return null;
    if (!this.shouldUseContinuityService(session, raw, isVoice)) return null;

    const sourceId = session.bookingDraftSnapshot?.serviceId
      ? String(session.bookingDraftSnapshot.serviceId)
      : session.lastServiceId
        ? String(session.lastServiceId)
        : '';
    if (!sourceId) return null;
    return services.find((item: any) => String(item?.id) === sourceId) || null;
  }

  private isGenericBookingIntentWithoutService(raw: string, services: any[]) {
    if (!looksLikeBookingIntent(raw)) return false;
    if (this.detectServiceFromMessage(raw, services)) return false;
    return isGenericBookingIntentPhrase(raw);
  }

  // =========================
  // Matching
  // =========================
  private tryAutofillService(
    draft: BookingDraft,
    services: any[],
    msg: string,
    ctx?: { tenantId?: string; phone?: string; isVoice?: boolean },
  ) {
    // Always attempt to extract a service from the user's message and update the draft.
    // In voice bookings, the user may correct or override a previously selected service (e.g. "hayır lazer değil, protez tırnak").
    // Therefore we do not bail out when draft.serviceId is already set. Instead we detect a new service name and override.
    const hit = this.detectServiceFromMessage(msg, services);
    if (!hit || !hit.id) return;
    // If the message contains negation or override keywords, clear any previously suggested service name.
    const t = normalizeTr(msg);
    const negPatterns = [
      'degil',
      'değil',
      'istemiyorum',
      'istemem',
      'baska',
      'başka',
      'onun icin degil',
      'onun için değil',
      'farkli',
      'farklı',
    ];
    const hasNegation = negPatterns.some((p) => t.includes(p));
    const prev = draft.serviceId ? String(draft.serviceId) : null;
    // Always set the serviceId to the detected hit; this allows overriding a previous choice when the user specifies a new service.
    draft.serviceId = String(hit.id);
    this.logAction('explicit_service_detected', {
      tenantId: ctx?.tenantId || draft.tenantId,
      phone: ctx?.phone || draft.customerPhone,
      serviceId: String(hit.id),
      raw: msg,
      isVoice: Boolean(ctx?.isVoice),
    });
    if (hasNegation) {
      // Clear any suggested service tracking so that the flow does not ask about the old service again.
      (draft as any).suggestedServiceId = undefined;
      (draft as any).suggestedServiceName = undefined;
      this.logAction('service_override_triggered', {
        tenantId: ctx?.tenantId || draft.tenantId,
        phone: ctx?.phone || draft.customerPhone,
        fromServiceId: prev,
        toServiceId: String(hit.id),
        raw: msg,
      });
    }
  }

  private extractSlotsFromMessage(opts: {
    session: SessionState;
    raw: string;
    services: any[];
    staff: any[];
    isVoice: boolean;
  }) {
    const { session, raw, services, staff, isVoice } = opts;
    const draft = session.draft;

    this.tryAutofillService(draft, services, raw, {
      tenantId: draft.tenantId,
      phone: draft.customerPhone,
      isVoice,
    });

    const hasCorrection =
      /\b(hayir|hayır)\b/.test(normalizeTr(raw)) &&
      /\b(degil|değil)\b/.test(normalizeTr(raw));
    if (hasCorrection) {
      const suggestedServiceCleanupPatch = buildSuggestedServiceCleanupPatch();
      session.suggestedServiceId =
        suggestedServiceCleanupPatch.nextSuggestedServiceId;
      session.suggestedServiceName =
        suggestedServiceCleanupPatch.nextSuggestedServiceName;
    }


    const parsed = parseDateTimeTR(raw);
    const tNorm = normalizeTr(raw);
    this.logAction('datetime_slots_extracted', {
      tenantId: draft.tenantId,
      phone: draft.customerPhone,
      raw,
      hasTime: parsed?.hasTime || false,
      hasDate: parsed?.hasDate || false,
      dateOnly: parsed?.dateOnly || null,
    });
    const mergedPendingIso =
      isVoice && !hasExplicitDateMarker(tNorm)
        ? this.mergePendingDateOnlyWithTime(session.pendingDateOnly, tNorm)
        : null;
    if (mergedPendingIso) {
      draft.startAt = mergedPendingIso;
      session.pendingStartAt = draft.startAt;
      session.pendingDateOnly = undefined;
    } else if (parsed?.hasTime) {
      let nextIso = toIstanbulIso(clampToFuture(parsed.dateUtc));
      // Keep existing date when caller only updates the time ("iki", "saat iki", "iki buçuk").
      if (!hasExplicitDateMarker(tNorm)) {
        const baseIso = draft.startAt || session.pendingStartAt;
        const parts = getTrPartsFromIso(nextIso);
        if (baseIso && parts) {
          const merged = buildIsoWithSameDate(baseIso, parts.hh, parts.mm);
          if (merged) nextIso = merged;
        }
      }
      const dateTimeCommitPatch = buildDateTimeCommitPatch(nextIso);
      draft.startAt = dateTimeCommitPatch.nextStartAt;
      session.pendingStartAt = dateTimeCommitPatch.nextPendingStartAt;
      if (dateTimeCommitPatch.clearPendingDateOnly) {
        session.pendingDateOnly = undefined;
      }
    } else if (parsed?.dateOnly) {
      // Keep existing time when caller only updates date ("yarın", "perşembe").
      let mergedWithExistingTime = false;
      if (draft.startAt) {
        const mergedIso = mergeDateOnlyWithExistingTime(
          parsed.dateOnly,
          draft.startAt,
          {
            getTrPartsFromIso,
            clampToFuture,
            toIstanbulIso,
          },
        );
        if (mergedIso) {
          const dateTimeCommitPatch = buildDateTimeCommitPatch(mergedIso);
          draft.startAt = dateTimeCommitPatch.nextStartAt;
          session.pendingStartAt = dateTimeCommitPatch.nextPendingStartAt;
          if (dateTimeCommitPatch.clearPendingDateOnly) {
            session.pendingDateOnly = undefined;
          }
          mergedWithExistingTime = true;
        }
      }
      if (!mergedWithExistingTime) {
        const pendingDateOnlyPatch = buildPendingDateOnlyPatch(parsed.dateOnly);
        session.pendingDateOnly = pendingDateOnlyPatch.nextPendingDateOnly;
      }
    }

    const canCaptureName = looksLikeExplicitNameStatement(raw);
    if (!draft.customerName && canCaptureName) {
      this.trySaveCustomerNameFromVoiceInput({
        session,
        raw,
        staff,
        isVoice,
        source: 'slot_extraction',
      });
    }

    this.updateContinuityMemory(session, services, staff);
  }

  private tryAutofillStaff(
    draft: BookingDraft,
    staff: any[],
    msg: string,
    opts?: { isVoice?: boolean },
  ) {
    const hit = this.detectStaffFromMessage(msg, staff);

    if (!hit?.id) return;
    if (opts?.isVoice && !this.isStrongVoiceStaffSignal(msg, hit)) return;
    draft.staffId = String(hit.id);
    draft.requestedStaffName = undefined;
  }

  private detectStaffFromMessage(msg: string, staff: any[]) {
    return detectStaffFromMessageHelper(msg, staff);
  }

  private mergePendingDateOnlyWithTime(
    pendingDateOnly: string | undefined,
    rawNorm: string,
  ): string | null {
    return mergePendingDateOnlyWithTimeHelper(pendingDateOnly, rawNorm, {
      parseTimeBest,
      clampToFuture,
      toIstanbulIso,
    });
  }

  private shouldCaptureCustomerName(
    raw: string,
    maybeName: string,
    isVoice: boolean,
  ) {
    if (!isVoice) return true;
    return isLikelyMeaningfulVoiceName(raw, maybeName);
  }

  private trySaveCustomerNameFromVoiceInput(opts: {
    session: SessionState;
    raw: string;
    staff: any[];
    isVoice: boolean;
    source: 'wait_name' | 'slot_extraction';
  }) {
    const { session, raw, staff, isVoice, source } = opts;
    if (session.draft.customerName) return session.draft.customerName;

    const staffHit = this.detectStaffFromMessage(raw, staff);
    if (staffHit?.id && this.isStaffSelectionUtterance(raw)) {
      this.logAction('name_capture_skipped_due_to_staff_match', {
        tenantId: session.draft.tenantId,
        phone: session.draft.customerPhone,
        state: session.state,
        source,
        raw,
        staffId: String(staffHit.id),
        staffName: String(staffHit.name || staffHit.fullName || ''),
      });
      return null;
    }

    const candidate = isVoice
      ? extractVoiceCustomerName(raw)
      : extractName(raw);

    if (!candidate) {
      this.logAction('name_candidate_rejected', {
        tenantId: session.draft.tenantId,
        phone: session.draft.customerPhone,
        state: session.state,
        source,
        raw,
        reason: 'no_candidate',
      });
      return null;
    }

    this.logAction('name_candidate_detected', {
      tenantId: session.draft.tenantId,
      phone: session.draft.customerPhone,
      state: session.state,
      source,
      raw,
      candidate,
      reason: isVoice ? 'voice_parser' : 'generic_parser',
    });

    const candidateNorm = normalizePersonName(candidate);
    const looksLikeStaffName = staff?.some(
      (p: any) =>
        normalizePersonName(String(p?.name || '')) === candidateNorm ||
        normalizePersonName(String(p?.fullName || '')) === candidateNorm,
    );
    if (looksLikeStaffName) {
      this.logAction('name_candidate_rejected', {
        tenantId: session.draft.tenantId,
        phone: session.draft.customerPhone,
        state: session.state,
        source,
        raw,
        candidate,
        reason: 'matches_staff_name',
      });
      return null;
    }

    if (!this.shouldCaptureCustomerName(raw, candidate, isVoice)) {
      this.logAction('name_candidate_rejected', {
        tenantId: session.draft.tenantId,
        phone: session.draft.customerPhone,
        state: session.state,
        source,
        raw,
        candidate,
        reason: 'failed_capture_rules',
      });
      return null;
    }

    const customerNameCommitPatch = buildCustomerNameCommitPatch(candidate);
    session.draft.customerName = customerNameCommitPatch.nextCustomerName;
    this.logAction('customer_name_saved', {
      tenantId: session.draft.tenantId,
      phone: session.draft.customerPhone,
      state: session.state,
      source,
      raw,
      candidate,
    });
    return candidate;
  }

  private isStaffSelectionUtterance(raw: string) {
    const cleaned = stripVoiceContextMetadata(raw);
    const t = normalizeTr(cleaned);
    if (!t) return false;
    if (isNoPreferenceStaff(cleaned)) return true;
    if (
      /\b(olsun|olabilir|tercih|istiyorum|isterim|o olsun|onunla|kendisiyle|hanim|hanım|bey)\b/.test(
        t,
      )
    ) {
      return true;
    }
    const tokens = cleaned
      .replace(/[.?!,]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return tokens.length >= 1 && tokens.length <= 2;
  }

  private shouldCaptureRequestedStaffName(
    raw: string,
    maybeSpoken: string,
    isVoice: boolean,
  ) {
    if (!isVoice) return true;
    return isLikelyMeaningfulVoiceStaffPhrase(raw, maybeSpoken);
  }

  private isStrongVoiceStaffSignal(msg: string, hit: any) {
    const rawNorm = normalizeTr(msg);
    const staffName = normalizePersonName(String(hit?.name || ''));
    if (!rawNorm || !staffName) return false;
    const rawWords = normalizePersonName(msg)
      .split(/\s+/)
      .filter((word) => word.length >= 3);

    if (normalizePersonName(msg) === staffName) return true;
    if (rawWords.length && rawWords.every((word) => staffName.includes(word)))
      return true;
    if (
      rawNorm.includes(` ${staffName} `) ||
      rawNorm.startsWith(`${staffName} `) ||
      rawNorm.endsWith(` ${staffName}`)
    )
      return true;

    return /(ile|olsun|tercih|istiyorum|hanim|hanım|bey)/.test(rawNorm);
  }

  private hasStrongVoiceBookingIntent(raw: string, services: any[]) {
    const t = normalizeTr(raw);
    if (!t) return false;
    if (!/(randevu|rezervasyon)/.test(t)) return false;
    if (
      /(iptal|degistir|değiştir|ertele|listele|goster|göster|var mi|var mı)/.test(
        t,
      )
    )
      return false;
    if (
      /(almak istiyorum|almak isterim|almak istiyordum|olustur|oluştur|yeni)/.test(
        t,
      )
    )
      return true;

    const parsed = parseDateTimeTR(raw);
    if (this.detectServiceFromMessage(raw, services)) return true;
    if (parsed?.hasDate || parsed?.hasTime) return true;
    return false;
  }

  private hasStrongCarryoverServiceCue(raw: string) {
    const t = normalizeTr(raw);
    if (!t) return false;
    return (
      /(randevu|rezervasyon)/.test(t) &&
      /(almak|yaptir|yaptır|olustur|oluştur|ayarl|yarin|yarın|bugun|bugün|saat|musait|müsait|uygun)/.test(
        t,
      )
    );
  }

  private isShortContextualBookingReply(raw: string) {
    const t = normalizeTr(raw);
    if (!t) return false;
    if (t.length > 48) return false;

    const cues = [
      /\b(bunu|buna|böyle|boyle|onu|onu alalim|onu alalım)\b/,
      /\b(tamam|olur|evet)\b.*\b(alalim|alayim|alalım|alayım|olsun|uyar|uygun)\b/,
      /\b(yarin|yarın|bugun|bugün|saat|ogle|öğle|sabah|aksam|akşam)\b/,
      /\b(randevu|rezervasyon)\b.*\b(alalim|alayim|olsun|yapalim|yapalım|yaptiralim|yaptıralım)\b/,
      /\b(alalim|alayim|olsun|yapalim|yapalım|ayarlayalim|ayarlayalım)\b/,
    ];

    return cues.some((pattern) => pattern.test(t));
  }

  private isContextualBookingFollowUp(
    session: SessionState,
    raw: string,
    isVoice: boolean,
  ) {
    if (!isVoice) return false;
    if (!this.isShortContextualBookingReply(raw)) return false;

    return Boolean(
      session.lastServiceId ||
      session.bookingDraftSnapshot?.serviceId ||
      session.recentIntentContext === 'booking' ||
      session.recentIntentContext === 'info',
    );
  }

  private shouldCarryRecentStaffContext(raw: string, session: SessionState) {
    if (!session.recentStaffId) return false;
    const t = normalizeTr(raw);
    if (!t) return false;
    if (
      /(hanim|hanım|bey|personel|uzman)/.test(t) &&
      !/(fark etmez|kim olursa|kim uygun|biri olsun)/.test(t)
    ) {
      return true;
    }

    return /(o olsun|onunla|kendisiyle|ayni kisi|aynı kişi|ayni personel|aynı personel)/.test(
      t,
    );
  }

  private detectServiceFromMessage(raw: string, services: any[]) {
    return detectServiceFromMessage(raw, services);
  }

  private hasExplicitUnknownServiceRequest(raw: string, services: any[]) {
    const t = normalizeTr(raw);
    if (!t || !hasStrongServiceRequestCue(t)) return false;
    if (this.detectServiceFromMessage(raw, services)) return false;

    // If caller is only giving date/time/staff/name info, do not label as unknown service.
    if (
      parseDateTimeTR(raw)?.hasDate ||
      parseTimeBest(t) ||
      isNoPreferenceStaff(raw) ||
      Boolean(extractName(raw))
    ) {
      return false;
    }

    return true;
  }

  private getNextMissingSlot(
    session: SessionState,
  ): 'service' | 'name' | 'datetime' | 'confirm' {
    if (!session.draft.serviceId) return 'service';
    if (!session.draft.startAt) return 'datetime';
    return 'confirm';
  }

  // =========================
  // Learning profile (best effort)
  // =========================
  private async saveLearningProfile(
    tenantId: string,
    phone: string,
    patch: Partial<LearningProfile>,
  ) {
    const data: LearningProfile = { ...(patch as any), updatedAt: Date.now() };
    try {
      if ((this.prisma as any).customerProfile?.upsert) {
        await (this.prisma as any).customerProfile.upsert({
          where: { tenantId_phoneNumber: { tenantId, phoneNumber: phone } },
          update: { data } as any,
          create: { tenantId, phoneNumber: phone, data } as any,
        });
        return;
      }
    } catch {}

    try {
      const c = await (this.prisma as any).customers?.findUnique?.({
        where: { tenantId_phoneNumber: { tenantId, phoneNumber: phone } },
        select: { meta: true, profile: true, profileJson: true } as any,
      });

      const base =
        (c as any)?.meta ??
        (c as any)?.profile ??
        (c as any)?.profileJson ??
        {};
      const merged = {
        ...(base && typeof base === 'object' ? base : {}),
        ...data,
      };

      try {
        await (this.prisma as any).customers.update({
          where: { tenantId_phoneNumber: { tenantId, phoneNumber: phone } },
          data: { meta: merged } as any,
        });
        return;
      } catch {}

      try {
        await (this.prisma as any).customers.update({
          where: { tenantId_phoneNumber: { tenantId, phoneNumber: phone } },
          data: { profileJson: JSON.stringify(merged) } as any,
        });
        return;
      } catch {}
    } catch {}
  }

  private async learnFromSuccessfulBooking(
    tenantId: string,
    phone: string,
    draft: BookingDraft,
  ) {
    const patch: Partial<LearningProfile> = {
      lastServiceId: draft.serviceId ? String(draft.serviceId) : null,
      lastStaffId: draft.staffId ? String(draft.staffId) : null,
      lastStartAt: draft.startAt ? String(draft.startAt) : null,
    };

    if (draft.startAt) {
      const parts = getTrPartsFromIso(String(draft.startAt));
      if (parts)
        patch.preferredTimeHint = `${String(parts.hh).padStart(2, '0')}:${String(parts.mm).padStart(2, '0')}`;
    }

    await this.saveLearningProfile(tenantId, phone, patch);
  }
}

// =========================
// Helpers
// =========================
function normalizeTr(s: string) {
  return (s || '')
    .toLowerCase()
    .replace(/[’'`"]/g, '')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePersonName(s: string) {
  let t = normalizeTr(s);
  t = t
    .replace(/\b(uzman|uzmani|uzmanı|usta|dr|doktor|mr|ms)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

function isNoPreferenceStaff(raw: string) {
  const t = normalizeTr(raw);
  return (
    t.includes('fark etmez') ||
    t.includes('farketmez') ||
    t.includes('siz secin') ||
    t.includes('siz seçin') ||
    t.includes('siz belirleyin') ||
    t.includes('herhangi') ||
    t.includes('kim olursa') ||
    t.includes('kiminle olursa') ||
    t === 'farketmez' ||
    t === 'fark etmez'
  );
}

function looksLikeUpcomingQuery(raw: string) {
  const t = normalizeTr(raw);

  // Randevu bilgisi isteme / görüntüleme niyeti
  const hasApptWord =
    t.includes('randevu') ||
    t.includes('rezervasyon') ||
    t.includes('randevum') ||
    t.includes('rezervasyonum');

  if (!hasApptWord) return false;

  const wantsInfo =
    t.includes('saatimi unuttum') ||
    t.includes('saatini unuttum') ||
    t.includes('unuttum') ||
    t.includes('kontrol') ||
    t.includes('kontrol et') ||
    t.includes('goster') ||
    t.includes('göster') ||
    t.includes('goruntule') ||
    t.includes('görüntüle') ||
    t.includes('listele') ||
    t.includes('ne zaman') ||
    t.includes('ne zamana') ||
    t.includes('ne zamandi') ||
    t.includes('ne zamandı') ||
    t.includes('tarih') ||
    t.includes('tarihim') ||
    t.includes('saat kac') ||
    t.includes('saat kaç') ||
    t.includes('kacda') ||
    t.includes('kaçta');

  // “randevu saatim?” gibi soru işaretli kısa sorular
  const shortQuestion =
    t.includes('?') && (t.includes('randevu') || t.includes('rezervasyon'));

  return wantsInfo || shortQuestion;
}

function isSimpleGreetingOnly(raw: string) {
  const t = normalizeTr(raw);
  if (!t) return false;
  return (
    t === 'merhaba' ||
    t === 'selam' ||
    t === 'selamlar' ||
    t === 'iyi gunler' ||
    t === 'iyi aksamlar'
  );
}

function hasStrongServiceRequestCue(raw: string) {
  const t = normalizeTr(raw);
  return (
    t.includes('rezervasyon') ||
    t.includes('randevu') ||
    t.includes('hizmet') ||
    t.includes('islem') ||
    t.includes('işlem') ||
    t.includes('bakim') ||
    t.includes('bakım') ||
    t.includes('icin') ||
    t.includes('için')
  );
}

function isGenericBookingIntentPhrase(raw: string) {
  const t = normalizeTr(raw);
  if (!t) return false;
  if (!looksLikeBookingIntent(raw)) return false;
  if (parseDateTimeTR(raw)?.hasDate || parseDateTimeTR(raw)?.hasTime)
    return false;
  const genericPhrases = [
    'randevu almak istiyorum',
    'rezervasyon yapmak istiyorum',
    'rezervasyon yaptirmak istiyorum',
    'rezervasyon yaptırmak istiyorum',
    'randevu olusturmak istiyorum',
    'randevu oluşturmak istiyorum',
    'randevu istiyorum',
    'rezervasyon istiyorum',
  ].map((item) => normalizeTr(item));
  return genericPhrases.some((phrase) => t === phrase || t.includes(phrase));
}

function looksLikeBookingIntent(raw: string) {
  const t = normalizeTr(raw);
  if (t === 'randevu' || t === 'rezervasyon') return true;
  const hasRandevu = t.includes('randevu') || t.includes('rezervasyon');
  const serviceLedBooking =
    /(almak|istiyorum|istiyoruz|isterim|istiyoruz|olsun|ayarla|olustur|oluştur)/.test(
      t,
    ) &&
    /(lazer|epilasyon|cilt|bakim|bakım|manikur|manikür|pedikur|pedikür|protez|tirnak|tırnak)/.test(
      t,
    );
  if (!hasRandevu && !serviceLedBooking) return false;
  const verbs = [
    'olustur',
    'oluştur',
    'ayarla',
    'yap',
    'yapal',
    'al',
    'alin',
    'almak',
    'istiyorum',
    'istiyoruz',
    'isterim',
    'rezervasyon yap',
    'randevu yap',
    'randevu al',
  ];
  if (serviceLedBooking || verbs.some((v) => t.includes(normalizeTr(v)))) return true;
  if (t.includes('yarin') || t.includes('bugun') || /\b\d{1,2}:\d{2}\b/.test(t))
    return true;
  return false;
}

function looksLikeCancelIntent(raw: string) {
  const t = normalizeTr(raw);
  return (
    t === 'iptal' ||
    t.includes('iptal et') ||
    t.includes('randevu iptal') ||
    t.includes('randevumu iptal') ||
    t.includes('vazgectim') ||
    t.includes('vazgec')
  );
}

function looksLikeRescheduleIntent(raw: string) {
  const t = normalizeTr(raw);

  // klasik
  if (
    t.includes('randevu degis') ||
    t.includes('randevu değiş') ||
    t.includes('randevumu degis') ||
    t.includes('randevumu değiş') ||
    t.includes('tarih degis') ||
    t.includes('saat degis') ||
    t.includes('ertele') ||
    t.includes('ileri al') ||
    t.includes('geri al') ||
    t.includes('baska saate') ||
    t.includes('baska tarihe')
  )
    return true;

  // randevu kelimesi olmadan da yakala: “saatini 10 yap”, “10'a al”
  const hasTime =
    /\b\d{1,2}:\d{2}\b/.test(t) ||
    /\b(saat\s*)?\d{1,2}(\.?\d{2})?\s*(a|e)?\b/.test(t);
  const hasChangeVerb =
    t.includes('degis') ||
    t.includes('değiş') ||
    t.includes('guncelle') ||
    t.includes('güncelle') ||
    t.includes('al') ||
    t.includes('cek') ||
    t.includes('çek') ||
    t.includes('tas') ||
    t.includes('taş') ||
    t.includes('yap');

  if (hasTime && hasChangeVerb) return true;
  if (t.includes('saatini') && hasChangeVerb) return true;

  // “randevuyu 10'a aldın mı” gibi teyit cümlelerini de reschedule domain'e al
  if (
    (t.includes('randevu') || t.includes('saatini')) &&
    (t.includes('aldin mi') ||
      t.includes('aldın mı') ||
      t.includes('yaptin mi') ||
      t.includes('yaptın mı'))
  )
    return true;

  return false;
}
function looksLikeGenericEditIntent(raw: string) {
  const t = normalizeTr(raw);
  return (
    (t.includes('randevu') &&
      (t.includes('degis') ||
        t.includes('değiş') ||
        t.includes('guncelle') ||
        t.includes('güncelle') ||
        t.includes('duzenle') ||
        t.includes('düzenle'))) ||
    (t.includes('randevu') && (t.includes('iptal') || t.includes('ertele'))) ||
    (t.includes('randevu') &&
      (t.includes('ne zaman') ||
        t.includes('ne zamana') ||
        t.includes('hangi gun') ||
        t.includes('hangi gün') ||
        t.includes('tarihi') ||
        t.includes('saat kac') ||
        t.includes('saat kaç') ||
        t.includes('ne zamandi') ||
        t.includes('ne zamandı')))
  );
}

function looksLikeServiceListRequest(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('hizmetler') ||
    t.includes('hizmet list') ||
    t.includes('listeyi at') ||
    t.includes('neler var') ||
    t.includes('servisler')
  );
}

function looksLikePriceQuestion(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('fiyat') ||
    t.includes('ucret') ||
    t.includes('kac tl') ||
    t.includes('kaç tl')
  );
}

function looksLikeAddressOrHours(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('adres') ||
    t.includes('konum') ||
    t.includes('nerde') ||
    t.includes('nerede') ||
    t.includes('calisma saati') ||
    t.includes('çalışma saati') ||
    t.includes('kacda') ||
    t.includes('kaçta')
  );
}

function shouldExitBookingFlow(msgNorm: string, raw: string) {
  if (isYes(msgNorm) || isNo(msgNorm)) return false;
  const t = normalizeTr(raw);
  if (!t) return false;
  if (looksLikeBookingIntent(raw)) return false;
  return (
    t.includes('selam') ||
    t.includes('merhaba') ||
    t.includes('tesekkur') ||
    t.includes('teşekkür') ||
    t.includes('bilgi') ||
    t.includes('soru') ||
    t.includes('istemiyorum') ||
    t.includes('vazgec') ||
    t.includes('vazgeç') ||
    t === 'hayir' ||
    t === 'hayır'
  );
}

function looksLikeProcedureQuestion(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('nasil') ||
    t.includes('hakkinda bilgi') ||
    t.includes('hakkında bilgi') ||
    t.includes('bilgi almak istiyorum') ||
    t.includes('surec') ||
    t.includes('kac seans') ||
    t.includes('seans') ||
    t.includes('acitir') ||
    t.includes('can yakar') ||
    t.includes('zararli') ||
    t.includes('yan etk') ||
    t.includes('risk') ||
    t.includes('sonrasi') ||
    t.includes('bakim') ||
    t.includes('kimlere uygun degil') ||
    t.includes('kimler icin uygun degil')
  );
}

function isCancel(msg: string) {
  const t = normalizeTr(msg);
  return (
    t === 'iptal' ||
    t.includes('iptal et') ||
    t.includes('vazgectim') ||
    t.includes('vazgec')
  );
}

function isRestart(msg: string) {
  const t = normalizeTr(msg);
  return (
    t === 'bastan' ||
    t.includes('yeniden') ||
    t.includes('sifirla') ||
    t.includes('sıfırla')
  );
}

function isYes(msg: string) {
  const t = normalizeTr(msg);
  if (!t) return false;
  if (/^(e|evet|olur|tamam|tabi|tabii|aynen|dogru|do[ğg]ru)$/.test(t))
    return true;
  if (
    /(onayl[iı]yorum|onay|kesinlikle|evet olsun|aynen oyle|aynen öyle)/.test(t)
  )
    return true;
  return false;
}

function isNo(msg: string) {
  const t = normalizeTr(msg);
  if (!t) return false;
  if (/^(h|hayir|hayır|yok|olmaz|yanlis|yanlış)$/.test(t)) return true;
  if (
    /(istemiyorum|olmasin|olmasın|iptal|degil|değil|oyle degil|öyle değil)/.test(
      t,
    )
  )
    return true;
  return false;
}

function servicesToTextShort(
  services: any[],
  opts?: { limit?: number; compact?: boolean },
) {
  if (!services || services.length === 0) return '';
  const limit = Math.max(1, opts?.limit ?? 6);
  const compact = Boolean(opts?.compact);
  return services
    .slice(0, limit)
    .map((s: any) => {
      const name = String(s?.name || 'Hizmet');
      if (compact) return name;
      const price = s?.price != null ? `${s.price}₺` : '-';
      const dur = s?.duration != null ? `${s.duration} dk` : '-';
      return `• ${name} (${price}, ${dur})`;
    })
    .join(compact ? ', ' : '\n');
}

function staffToTextShort(staff: any[]) {
  if (!staff || staff.length === 0) return '';
  return staff
    .slice(0, 6)
    .map((p: any) => `• ${String(p?.name || 'Personel')}`)
    .join('\n');
}

function looksLikeExplicitNameStatement(raw: string) {
  const t = normalizeTr(raw);
  if (!t) return false;
  return (
    t.startsWith('ben ') ||
    t.startsWith('adim ') ||
    t.startsWith('adım ') ||
    t.startsWith('isim ') ||
    t.startsWith('ismim ')
  );
}

function extractVoiceCustomerName(rawText: string): string | null {
  const cleaned = sanitizeVoiceNameInput(rawText);
  if (!cleaned) return null;

  const normalized = normalizeTr(cleaned);
  if (!normalized) return null;
  if (normalized.includes('?')) return null;
  if (containsRejectedVoiceNamePhrase(normalized)) return null;
  if (/\d/.test(cleaned)) return null;

  const withoutPrefix = cleaned.replace(
    /^(ben(?:im)?(?: adim| adım)?|adim|adım|isim|ismim)\s+/i,
    '',
  );
  const withoutHonorific = withoutPrefix.replace(
    /\s+(hanim|hanım|bey|beyefendi|hanimefendi)$/i,
    '',
  );
  const candidate = withoutHonorific.trim();
  if (!candidate) return null;

  const tokens = candidate
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, ''))
    .filter(Boolean);
  if (!tokens.length || tokens.length > 4) return null;
  if (
    !tokens.every(
      (token) => /^[\p{L}][\p{L}'’-]{0,29}$/u.test(token) && token.length >= 2,
    )
  ) {
    return null;
  }

  return formatSpokenName(tokens);
}

function extractLikelyStaffName(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(
    /([A-Za-zÇĞİÖŞÜçğıöşü']{2,})(?:['’]?(?:ten|tan|le|la)|\s+ile)\b/i,
  );
  if (!m?.[1]) return null;
  const candidate = m[1].replace(/['’]$/, '').trim();
  if (!candidate) return null;
  if (candidate.length < 2) return null;
  return candidate;
}

function stripVoiceContextMetadata(raw: string): string {
  return String(raw || '')
    .replace(/\[voice_context:[\s\S]*?\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeVoiceNameInput(raw: string): string {
  return stripVoiceContextMetadata(raw)
    .replace(/^[\s"'“”'`.,:;!?-]+|[\s"'“”'`.,:;!?-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsRejectedVoiceNamePhrase(normalized: string): boolean {
  const banned = [
    'fark etmez',
    'tamam',
    'evet',
    'hayir',
    'hayır',
    'jarvis',
    'rezervasyon',
    'randevu',
    'yarin',
    'yarın',
    'bugun',
    'bugün',
    'ogle',
    'öğle',
    'aksam',
    'akşam',
    'musait',
    'müsait',
    'uygun',
    'beni duyuyor musun',
    'kimsiniz',
    'sen kimsin',
    'fiyati ne',
    'fiyatı ne',
    'hakaret',
  ];
  return banned.some(
    (phrase) =>
      normalized === normalizeTr(phrase) ||
      normalized.includes(normalizeTr(phrase)),
  );
}

function formatSpokenName(tokens: string[]): string {
  return tokens
    .map((token) =>
      token
        .split(/([-'’])/)
        .map((part) =>
          /[-'’]/.test(part)
            ? part
            : part.charAt(0).toLocaleUpperCase('tr-TR') +
              part.slice(1).toLocaleLowerCase('tr-TR'),
        )
        .join(''),
    )
    .join(' ');
}

function isLikelyMeaningfulVoiceName(raw: string, maybeName: string): boolean {
  const rawNorm = normalizeTr(stripVoiceContextMetadata(raw));
  const candidateNorm = normalizeTr(maybeName);
  if (!rawNorm || !candidateNorm) return false;
  if (candidateNorm.length < 2) return false;

  const bannedPhrases = [
    'bir defa olsun',
    'bir kere',
    'fark etmez',
    'bilmiyorum',
    'emin degilim',
    'emin değilim',
    'uygunsa',
    'musaitseniz',
    'müsaitseniz',
    'yarin',
    'yarın',
    'bugun',
    'bugün',
    'cuma gunu',
    'cuma günü',
  ];
  if (bannedPhrases.some((phrase) => rawNorm.includes(normalizeTr(phrase))))
    return false;

  if (
    /(randevu|saat|yarin|yarın|bugun|bugün|sabah|ogle|öğle|aksam|akşam|lazer|protez|manikur|manikür|pedikur|pedikür)/.test(
      rawNorm,
    )
  )
    return false;

  const words = candidateNorm.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  return words.every((word) => word.length >= 2);
}

function isLikelyMeaningfulVoiceStaffPhrase(
  raw: string,
  maybeSpoken: string,
): boolean {
  const rawNorm = normalizeTr(raw);
  const candidateNorm = normalizeTr(maybeSpoken);
  if (!rawNorm || !candidateNorm) return false;
  if (candidateNorm.length < 2) return false;
  if (
    /(bir defa olsun|fark etmez|bilmiyorum|yarin|yarın|bugun|bugün)/.test(
      rawNorm,
    )
  )
    return false;
  return /(ile|olsun|tercih|hanim|hanım|bey)/.test(rawNorm);
}

// ===== TZ + Working hours helpers =====
const IST_OFFSET_MIN = 180;
const IST_OFFSET_MS = IST_OFFSET_MIN * 60 * 1000;

const WORK_START_HH = 8;
const WORK_END_HH = 22;

function addDaysMs(d: Date, n: number) {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

function toIstanbulIso(dUtc: Date) {
  const x = new Date(dUtc.getTime() + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = x.getUTCFullYear();
  const month = pad(x.getUTCMonth() + 1);
  const day = pad(x.getUTCDate());
  const hh = pad(x.getUTCHours());
  const mm = pad(x.getUTCMinutes());
  const ss = pad(x.getUTCSeconds());
  return `${year}-${month}-${day}T${hh}:${mm}:${ss}+03:00`;
}

function prettyIstanbul(iso: string) {
  const dUtc = new Date(iso);
  if (isNaN(dUtc.getTime())) return iso;

  const x = new Date(dUtc.getTime() + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(x.getUTCDate())}.${pad(x.getUTCMonth() + 1)}.${x.getUTCFullYear()} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

function getTrPartsFromIso(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const tr = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    y: tr.getUTCFullYear(),
    m: tr.getUTCMonth() + 1,
    d: tr.getUTCDate(),
    hh: tr.getUTCHours(),
    mm: tr.getUTCMinutes(),
  };
}

function isWithinWorkingHoursIso(iso: string) {
  const p = getTrPartsFromIso(iso);
  if (!p) return false;
  if (p.hh < WORK_START_HH) return false;
  if (p.hh >= WORK_END_HH) return false;
  return true;
}

function isEndWithinWorkingHoursIso(iso: string) {
  const p = getTrPartsFromIso(iso);
  if (!p) return false;
  if (p.hh < WORK_START_HH) return false;
  if (p.hh > WORK_END_HH) return false;
  if (p.hh === WORK_END_HH && p.mm > 0) return false;
  return true;
}

function suggestWorkingHourAlternatives(requestedIso: string, count: number) {
  const p = getTrPartsFromIso(requestedIso);

  if (!p) {
    const nowUtc = new Date();
    const tomorrowTr = new Date(nowUtc.getTime() + IST_OFFSET_MS);
    tomorrowTr.setUTCDate(tomorrowTr.getUTCDate() + 1);
    const dUtc = new Date(
      Date.UTC(
        tomorrowTr.getUTCFullYear(),
        tomorrowTr.getUTCMonth(),
        tomorrowTr.getUTCDate(),
        WORK_START_HH - 3,
        0,
        0,
        0,
      ),
    );
    return [toIstanbulIso(dUtc)];
  }

  const suggestions: string[] = [];
  const startDayOffset = p.hh >= WORK_END_HH ? 1 : 0;

  let dayOffset = startDayOffset;
  while (suggestions.length < count && dayOffset < 14) {
    for (
      let hh = WORK_START_HH;
      hh < WORK_END_HH && suggestions.length < count;
      hh += 2
    ) {
      const dUtc = new Date(
        Date.UTC(p.y, p.m - 1, p.d + dayOffset, hh - 3, 0, 0, 0),
      );
      suggestions.push(toIstanbulIso(dUtc));
    }
    dayOffset += 1;
  }

  return suggestions.slice(0, count);
}

type ParsedTRDateTime = {
  dateUtc: Date;
  hasTime: boolean;
  hasDate: boolean;
  dateOnly?: string;
};

function extractWeekdayIndex(tNorm: string): number | null {
  const words = (tNorm || '').split(/\s+/).filter(Boolean);
  for (const w0 of words) {
    const w = w0.trim();
    if (!w) continue;
    if (w.startsWith('pazartesi') || w === 'pzt') return 1;
    if (w.startsWith('sali') || w === 'sal') return 2;
    if (w.startsWith('carsamba') || w === 'crs' || w === 'car') return 3;
    if (w.startsWith('persembe') || w === 'prs' || w === 'per') return 4;
    if (w.startsWith('cuma')) return 5;
    if (w.startsWith('cumartesi') || w === 'cmt') return 6;
    if (w.startsWith('pazar')) return 0;
  }
  if (tNorm.includes('pazartesi') || tNorm.includes('pzt')) return 1;
  if (tNorm.includes('sali')) return 2;
  if (tNorm.includes('carsamba') || tNorm.includes('crs')) return 3;
  if (tNorm.includes('persembe') || tNorm.includes('prs')) return 4;
  if (tNorm.includes('cuma')) return 5;
  if (tNorm.includes('cumartesi') || tNorm.includes('cmt')) return 6;
  if (tNorm.includes('pazar')) return 0;
  return null;
}

function nextOccurrenceOfWeekday(
  nowTr: Date,
  targetDow: number,
): { year: number; month: number; day: number } {
  const todayDow = nowTr.getUTCDay();
  let delta = (targetDow - todayDow + 7) % 7;
  if (delta === 0) delta = 7;
  const target = addDaysMs(nowTr, delta);
  return {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth(),
    day: target.getUTCDate(),
  };
}

function parseDateTimeTR(raw: string): ParsedTRDateTime | null {
  const s = (raw || '').trim();
  if (!s) return null;

  const t = normalizeTr(s);
  const nowTr = new Date(Date.now() + IST_OFFSET_MS);

  const hasTomorrow = t.includes('yarin');
  const hasToday = t.includes('bugun');

  const weekdayIdx = extractWeekdayIndex(t);

  const mNumeric = t.match(/\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b/);
  const mMonth = t.match(
    /\b(\d{1,2})\s+(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/,
  );

  let timeOnly = parseTimeBest(t);
  let hasTime = Boolean(timeOnly);

  let baseTr = new Date(nowTr.getTime());
  if (hasTomorrow) baseTr = addDaysMs(baseTr, 1);

  let year = baseTr.getUTCFullYear();
  let month = baseTr.getUTCMonth();
  let day = baseTr.getUTCDate();

  let hasExplicitDate = false;

  if (mNumeric) {
    hasExplicitDate = true;
    day = Number(mNumeric[1]);
    month = Number(mNumeric[2]) - 1;
    if (mNumeric[3]) {
      const y = Number(mNumeric[3]);
      year = y < 100 ? 2000 + y : y;
    }
  } else if (mMonth) {
    hasExplicitDate = true;
    day = Number(mMonth[1]);
    month = monthNameToIndex(mMonth[2]);
  } else if (weekdayIdx != null) {
    hasExplicitDate = true;
    const next = nextOccurrenceOfWeekday(nowTr, weekdayIdx);
    year = next.year;
    month = next.month;
    day = next.day;
  } else if (hasTomorrow || hasToday) {
    hasExplicitDate = true;
  } else if (!hasTime) {
    return null;
  }

  // If no explicit time was found yet, try a loose parse for standalone numbers.
  // Keep numeric-date phrases excluded to avoid parsing day/month as hour.
  if (!hasTime && !mNumeric && !mMonth) {
    const loose = parseTimeLoose(t);
    if (loose) {
      timeOnly = loose;
      hasTime = true;
    }
  }

  if (!hasTime) {
    const dateOnly = `${String(year)}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dummyUtc = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    return { dateUtc: dummyUtc, hasTime: false, hasDate: true, dateOnly };
  }

  const hh = timeOnly!.hh;
  const mm = timeOnly!.mm;

  const dUtc = new Date(Date.UTC(year, month, day, hh - 3, mm, 0, 0));
  if (isNaN(dUtc.getTime())) return null;

  if (!hasExplicitDate && hasTime) {
    const nowUtc = new Date();
    if (dUtc.getTime() <= nowUtc.getTime()) {
      const moved = addDaysMs(dUtc, 1);
      return { dateUtc: moved, hasTime: true, hasDate: true };
    }
  }

  return { dateUtc: dUtc, hasTime: true, hasDate: true };
}

function parseTimeBest(t: string): { hh: number; mm: number } | null {
  const spoken = parseSpokenTurkishTime(t);
  if (spoken) return spoken;

  // Turkish phone speech variants: "9'a", "3'e", "2'ye", "sabah 9'a", "yarın 3'e"
  const mSuffix = t.match(/\b(\d{1,2})\s*['’]?(?:a|e|ya|ye)\b/);
  if (mSuffix) {
    let hh = Number(mSuffix[1]);
    const hasDayPeriod = /\b(sabah|ogle|oglen|aksam|gece)\b/.test(t);
    if (/\b(aksam|gece)\b/.test(t) && hh <= 11) hh += 12;
    else if (/\b(ogle|oglen)\b/.test(t) && hh <= 5) hh += 12;
    else if (!hasDayPeriod && hh >= 1 && hh <= 7) hh += 12;
    if (hh >= 0 && hh <= 23) return { hh, mm: 0 };
  }

  const matches: Array<{ hh: number; mm: number; idx: number }> = [];
  const reStrong = /(\d{1,2})\s*[:.]\s*(\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = reStrong.exec(t))) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)
      matches.push({ hh, mm, idx: m.index });
  }

  if (matches.length === 0 && t.includes('saat')) {
    const reWeak = /saat\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?/g;
    while ((m = reWeak.exec(t))) {
      let hh = Number(m[1]);
      const mm = m[2] ? Number(m[2]) : 0;
      if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) continue;
      // Apply an afternoon assumption for single‑digit hours (1–7) when no minutes are provided.
      // Many callers say “saat 2” or “saat iki” meaning 14:00 rather than 02:00. We treat
      // only hours 1–7 specially to avoid converting 08–12. A provided minute value overrides
      // this assumption, so “saat 2:30” becomes 14:30.
      if (!m[2] && hh >= 1 && hh <= 7) {
        hh = hh + 12;
      }
      matches.push({ hh, mm, idx: m.index });
    }
  }

  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { hh: last.hh, mm: last.mm };
}

function parseSpokenTurkishTime(t: string): { hh: number; mm: number } | null {
  const wordHour: Record<string, number> = {
    bir: 1,
    iki: 2,
    uc: 3,
    dort: 4,
    bes: 5,
    alti: 6,
    yedi: 7,
    sekiz: 8,
    dokuz: 9,
    on: 10,
    'on bir': 11,
    onbir: 11,
    'on iki': 12,
    oniki: 12,
  };

  const pickHour = (s: string): number | null => {
    const direct = s.match(/\b(1[0-2]|[1-9])\b/);
    if (direct) return Number(direct[1]);
    for (const [k, v] of Object.entries(wordHour)) {
      if (new RegExp(`\\b${k}\\b`).test(s)) return v;
    }
    return null;
  };

  const quarterPast = t.match(/\bceyrek\s+gece\s+([a-z0-9\s]+)$/);
  if (quarterPast) {
    const hh = pickHour(quarterPast[1]);
    if (hh != null) return applyDayPeriod(t, hh, 15);
  }

  const quarterTo = t.match(/\b([a-z0-9\s]+)e\s+ceyrek\s+var\b/);
  if (quarterTo) {
    const nextHour = pickHour(quarterTo[1]);
    if (nextHour != null) {
      const hh = nextHour === 1 ? 12 : nextHour - 1;
      return applyDayPeriod(t, hh, 45);
    }
  }

  if (/\bbucuk\b/.test(t)) {
    const hh = pickHour(t);
    if (hh != null) return applyDayPeriod(t, hh, 30);
  }

  return null;
}

function applyDayPeriod(
  t: string,
  hour12: number,
  minute: number,
): { hh: number; mm: number } {
  let hh = hour12;
  if (/\b(aksam|gece)\b/.test(t) && hh <= 11) hh += 12;
  else if (/\b(ogle|oglen)\b/.test(t) && hh <= 5) hh += 12;
  else if (!/\b(sabah|ogle|oglen|aksam|gece)\b/.test(t) && hh >= 1 && hh <= 7)
    hh += 12;
  return { hh, mm: minute };
}

/**
 * Loosely parse a time from free‑form Turkish text when no explicit time
 * indicator like ":" or "saat" is present. This is a best‑effort fallback
 * used when parseTimeBest fails and the user only provides a bare hour
 * number. Examples:
 *  - "10" → { hh: 10, mm: 0 }
 *  - "4"  → { hh: 16, mm: 0 } (afternoon assumption for 1–7)
 *
 * To avoid misinterpreting dates, this will only extract one or two digit
 * numbers and ignore larger values. If multiple candidates exist the last
 * occurrence is used. Values outside the 0–23 range are ignored.
 */
function parseTimeLoose(t: string): { hh: number; mm: number } | null {
  if (!t) return null;
  // First try to parse spelled‑out Turkish numbers. Normalize the string by
  // converting to lowercase and removing diacritics for reliable matching.
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[’'`”]/g, '')
      .replace(/ç/g, 'c')
      .replace(/ğ/g, 'g')
      .replace(/ı/g, 'i')
      .replace(/ö/g, 'o')
      .replace(/ş/g, 's')
      .replace(/ü/g, 'u');
  const spelledMap: { [key: string]: number } = {
    bir: 1,
    iki: 2,
    uc: 3,
    üç: 3,
    uch: 3,
    ucur: 3,
    dort: 4,
    dört: 4,
    bes: 5,
    beş: 5,
    alti: 6,
    altı: 6,
    yedi: 7,
    sekiz: 8,
    dokuz: 9,
    on: 10,
    onbir: 11,
    'on bir': 11,
    oniki: 12,
    'on iki': 12,
    onüç: 13,
    'on üç': 13,
    onuc: 13,
    ondört: 14,
    'on dört': 14,
    ondort: 14,
    onbes: 15,
    'on beş': 15,
    onbeş: 15,
  };
  const tokens = normalize(t).split(/\s+/).filter(Boolean);
  const spelledHours: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // Check both the token itself and combinations like "on" + next token for numbers
    let num: number | undefined = spelledMap[tok];
    if (num == null && i < tokens.length - 1) {
      const two = tok + ' ' + tokens[i + 1];
      num = spelledMap[two];
      if (num != null) i++; // skip the next token if we consumed two words
    }
    if (num != null) spelledHours.push(num);
  }
  if (spelledHours.length) {
    let hh = spelledHours[spelledHours.length - 1];
    const mm = 0;
    if (hh >= 1 && hh <= 7) hh += 12;
    return { hh, mm };
  }
  // Fallback: find standalone one or two digit numbers (not part of a longer number)
  const matches = [] as number[];
  const re = /\b(\d{1,2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (!isNaN(n) && n >= 0 && n <= 23) matches.push(n);
  }
  if (!matches.length) return null;
  const hour = matches[matches.length - 1];
  let hh = hour;
  // Assume afternoon for single digits 1–7 to better match user expectations
  if (hh >= 1 && hh <= 7) hh = hh + 12;
  return { hh, mm: 0 };
}

function monthNameToIndex(m: string) {
  switch (m) {
    case 'ocak':
      return 0;
    case 'subat':
      return 1;
    case 'mart':
      return 2;
    case 'nisan':
      return 3;
    case 'mayis':
      return 4;
    case 'haziran':
      return 5;
    case 'temmuz':
      return 6;
    case 'agustos':
      return 7;
    case 'eylul':
      return 8;
    case 'ekim':
      return 9;
    case 'kasim':
      return 10;
    case 'aralik':
      return 11;
    default:
      return 0;
  }
}

function clampToFuture(d: Date) {
  const now = new Date();
  if (d.getTime() > now.getTime()) return d;
  let x = new Date(d.getTime());
  for (let i = 0; i < 366; i++) {
    x = addDaysMs(x, 1);
    if (x.getTime() > now.getTime()) return x;
  }
  return addDaysMs(now, 1);
}

function hasExplicitDateMarker(tNorm: string) {
  if (!tNorm) return false;
  if (
    tNorm.includes('yarin') ||
    tNorm.includes('bugun') ||
    tNorm.includes('haftaya')
  )
    return true;
  if (/\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b/.test(tNorm))
    return true;
  if (
    /\b(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/.test(
      tNorm,
    )
  )
    return true;
  if (extractWeekdayIndex(tNorm) != null) return true;
  return false;
}

function buildIsoWithSameDate(baseStartAtIso: string, hh: number, mm: number) {
  const p = getTrPartsFromIso(baseStartAtIso);
  if (!p) return null;
  const dUtc = new Date(Date.UTC(p.y, p.m - 1, p.d, hh - 3, mm, 0, 0));
  return toIstanbulIso(clampToFuture(dUtc));
}
function extractOrdinal1to9(raw: string): number | null {
  const t = normalizeTr(raw);
  // "2. randevu", "2 randevum", "2. rezervasyon"
  const m = t.match(/\b([1-9])\s*\.?\s*(randevu|rezervasyon)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 9 ? n : null;
}

function toSchemaDateTime(startAtIso: string, durationMinutes?: number) {
  const parts = getTrPartsFromIso(startAtIso);
  if (!parts) {
    return {
      dateAtUtcMidnight: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      timeHHMM: '00:00',
      endTimeHHMM: durationMinutes ? '00:00' : undefined,
    };
  }

  const dateAtUtcMidnight = new Date(
    Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0),
  );
  const timeHHMM = `${String(parts.hh).padStart(2, '0')}:${String(parts.mm).padStart(2, '0')}`;

  let endTimeHHMM: string | undefined = undefined;
  if (typeof durationMinutes === 'number' && durationMinutes > 0) {
    const startUtc = new Date(startAtIso);
    const endIso = toIstanbulIso(
      new Date(startUtc.getTime() + durationMinutes * 60000),
    );
    const ep = getTrPartsFromIso(endIso);
    if (ep)
      endTimeHHMM = `${String(ep.hh).padStart(2, '0')}:${String(ep.mm).padStart(2, '0')}`;
  }

  return { dateAtUtcMidnight, timeHHMM, endTimeHHMM };
}

// -----------------------------------------------------------------------------
// CHANGELOG
//
// 1. Removed stray global function isSameTrDate and implemented it as a private
//    method of AgentService. Updated all references to call this method.
// 2. Added global configuration constants (SESSION_TTL_MS, SUGGESTION_TTL_MS,
//    IDEMPOTENCY_WINDOW_MS, MAX_LLM_OUTPUT_LENGTH) to centralize timeouts and
//    safety limits.
// 3. Introduced structured logging via a new private logAction() helper. Key
//    actions such as incoming messages, assistant replies, LLM calls, and
//    appointment lifecycle events now emit JSON logs including tenantId,
//    customer phone, session state and error codes for observability.
// 4. Added sanitizeLlmOutput() to strip URLs and limit the length of LLM
//    responses to MAX_LLM_OUTPUT_LENGTH characters. answerWithLLM now uses
//    this sanitization and logs both the request and the cleaned response.
// 5. Updated naturalAsk() and answerWithLLM() system prompts to be
//    sector‑agnostic. They now refer to the business name (if available) or
//    generic “işletme” instead of hard‑coded “güzellik merkezi”.
// 6. Generalized procedureTemplateForService() to avoid beauty‑specific
//    language; it now talks about service types and personal conditions instead
//    of body hair or skin.
// 7. Ensured sessions expire using SESSION_TTL_MS and removed stray “dev@...”
//    lines that were breaking compilation. safeReply now logs outgoing
//    messages.
// 8. Added logging for appointment creation, update and cancellation. Each
//    relevant method now records a log entry with context before returning.
// 9. Added dynamic selection of business name in prompts and improved LLM
//    prompts to respect the single‑question rule and avoid pushing bookings.
// 10. Included manual test script examples below to facilitate manual QA of
//     typical user flows.

// Manual test script examples:
// - “randevu almak istiyorum yarın 16:00”
// - “fark etmez”
// - “2. randevuyu 13:00 yap”
// - “randevum ne zamandı”
// - “adres?”
// - “lazer acıtır mı”
// - “fiyat listesi”
// - “işlem iptal”
// - “randevu değiştir 2. randevu 18:00”
// - “pazartesi 12:00 uygun mu?”
