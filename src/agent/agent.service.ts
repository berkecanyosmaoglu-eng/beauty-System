// Agent service for a multi‑tenant, sector agnostic booking platform
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

// -----------------------------------------------------------------------------
// Global configuration constants
// These values centralize the configuration for session timeouts, suggestion
// validity windows, idempotency windows and LLM safety. Changing these in one
// place propagates the behaviour throughout the service.
// -----------------------------------------------------------------------------
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;    // 2 hours session expiry
const SUGGESTION_TTL_MS = 20 * 60 * 1000;     // suggestions live for 20 minutes
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000; // 10 minute idempotency window
const MAX_LLM_OUTPUT_LENGTH = 600;            // maximum characters allowed from LLM

type BookingDraft = {
  tenantId: string;
  customerPhone: string;
  customerName?: string | null;

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
  WAIT_SERVICE = 'WAIT_SERVICE',
  WAIT_STAFF = 'WAIT_STAFF',
  WAIT_NAME = 'WAIT_NAME',
  WAIT_DATETIME = 'WAIT_DATETIME',
  WAIT_CONFIRM = 'WAIT_CONFIRM',

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

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly openai =
    process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  constructor(private readonly prisma: PrismaService) {}

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

  // =========================
  // ✅ mini metin motoru
  // =========================
  private pickOne(list: string[], seedText?: string) {
    if (!list?.length) return '';
    const seed = normalizeTr(seedText || '') || String(Date.now());
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return list[h % list.length];
  }

  private softYesNoHint(seed?: string) {
    return this.pickOne(
      ['Onaylıyor musun?', 'Tamam mı, onaylayayım mı?', 'Bunu böyle kaydediyorum, doğru mu?'],
      seed,
    );
  }

  
private humanizeAsk(kind: 'service' | 'staff' | 'name' | 'datetime', seed?: string) {
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
  if (kind === 'staff') {
    return this.pickOne(
      [
        "Hangi personeli tercih edersiniz? 'Fark etmez' diyebilirsiniz.",
        "Kiminle olsun istersiniz? 'Fark etmez' diyebilirsiniz.",
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
  // When only the time is needed, ask succinctly.
  return this.pickOne(
    [
      "Saat kaç olsun? Örneğin: '16:00'.",
      "Kaçta ayarlayalım? Örneğin: '16:00'.",
      "Saat alayım. Örneğin: '16:00'.",
    ],
    seed,
  );
}
private humanizeConfirmNeedEH(seed?: string) {
    // In voice calls, ask the customer to verbally confirm or decline. Keep it short and clear.
    return this.pickOne(
      [
        'Onaylıyor musunuz?',
        'Tamamsa evet deyin, istemezseniz hayır diyebilirsiniz.',
        'Randevuyu onaylıyor musunuz? Evet veya hayır diyebilirsiniz.',
      ],
      seed,
    );
  }

  private formatBookingSuccess(startAtIso: string, apptId: string, seed?: string) {
    const pretty = prettyIstanbul(startAtIso);
    return `${pretty} için rezervasyonunuzu oluşturdum.\nRezervasyondan 2 saat önce telefonunuza bir hatırlatma mesajı gönderilecektir. Görüşmek üzere.`;
  }

  private formatEditSuccess(startAtIso: string, apptId: string, seed?: string) {
    return this.pickOne(
      [
        `Randevunuzu güncelledim. Yeni tarih: ${prettyIstanbul(startAtIso)}. Kayıt numarası: ${apptId}.`,
        `Randevu güncellendi. Yeni tarih: ${prettyIstanbul(startAtIso)}. Kayıt numarası: ${apptId}.`,
        `Randevu değiştirildi. Yeni tarih: ${prettyIstanbul(startAtIso)}. Kayıt numarası: ${apptId}.`,
      ],
      seed || startAtIso + apptId,
    );
  }

  // =========================
  // MAIN
  // =========================
  async replyText(opts: { tenantId: string; from: string; text: string }): Promise<string> {
    const { tenantId, from } = opts;
    const raw = (opts.text ?? '').trim();
    const msg = normalizeTr(raw);

    const key = `${tenantId}:${from}`;
    const session = this.getOrInitSession(key, tenantId, from);

    // log incoming user message for observability
    this.logAction('incoming', {
      tenantId,
      phone: from,
      state: session.state,
      text: raw,
    });



    if (this.isLikelyDuplicateInbound(session, raw)) {
      const prev = session.lastAssistantReply || session.lastAssistantText || 'Tamam 👍';
      return this.safeReply(session, prev);
    }

    this.recordHistory(session, 'user', raw);


    // ====================================================
    // Follow-up memory: if the caller asks about the recent reservation, answer without starting a new booking flow
    // Recognize queries such as "Randevuyu oluşturdun mu?", "Hangi saate aldık?", "Ben neye randevu aldım?", "Kimleydi?".
    try {
      const q = normalizeTr(raw);
      if ((session as any).lastBookingSummary) {
        const followKeywords = ['randevu', 'rezervasyon'];
        const questionKeywords = ['olustur', 'oluştur', 'saat', 'hangi', 'kim', 'ne', 'kimin'];
        const hasFollow = followKeywords.some((k) => q.includes(k));
        const hasQuestion = questionKeywords.some((k) => q.includes(k));
        if (hasFollow && hasQuestion) {
          const ctx = session.lastBookingContext;
          if (ctx?.startAtIso && (q.includes('saat') || q.includes('hangi saate') || q.includes('kacta') || q.includes('kaçta'))) {
            return this.safeReply(session, `Randevunuz ${prettyIstanbul(ctx.startAtIso)} olarak görünüyor.`);
          }
          if (ctx?.staffName && (q.includes('kimle') || q.includes('kimleydi') || q.includes('kiminle'))) {
            return this.safeReply(session, `Randevunuz ${ctx.staffName} ile görünüyor.`);
          }
          if (ctx?.serviceName && (q.includes('hangi hizmet') || q.includes('neye') || q.includes('hangi islem') || q.includes('hangi işlem'))) {
            return this.safeReply(session, `Hizmetiniz ${ctx.serviceName} olarak görünüyor.`);
          }
          return this.safeReply(session, (session as any).lastBookingSummary as string);
        }
      }
    } catch (err) {
      // Ignore follow-up detection errors
    }

    try {
      // =========================
      // ✅ Follow-up: user asked appointment info, we are waiting a pick or a date hint
      // =========================
      if (session.state === WaState.WAIT_INFO_APPT_PICK) {
        const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 9);
        if (!list?.length) {
          this.softResetSession(session, tenantId, from, { keepIdempotency: true });
          this.saveSession(key, session);
          return this.safeReply(session, 'Şu an görünen bir randevun yok 🙂');
        }

        // If user wants to cancel all appointments ("hepsi", "hepsini", "tum", "tumu", "tümünü")
        const tHepsi2 = normalizeTr(raw);
        if (
          (tHepsi2.includes('hepsi') || tHepsi2.includes('hepsini') || tHepsi2.includes('tum') || tHepsi2.includes('tumu') || tHepsi2.includes('tümünü')) &&
          list && list.length
        ) {
          // switch to cancel mode for all appointments
          session.editMode = 'CANCEL';
          session.cancelAllIds = list.map((a) => String(a.id));
          session.pendingSummary = `Toplam ${list.length} randevunuz var. Hepsini iptal etmek istediğinize emin misiniz?`;
          session.state = WaState.WAIT_CONFIRM;
          // Do not set targetAppointmentId for bulk cancel
          this.saveSession(key, session);
          return this.safeReply(session, `${session.pendingSummary}\n${this.softYesNoHint(from + 'all')}`);
        }

        // If user answered with a date hint like "yarın/bugün/01.03"
        const parsedInfo = parseDateTimeTR(raw);
        if (parsedInfo?.hasDate && !parsedInfo.hasTime) {
          const dateOnly = parsedInfo.dateOnly; // YYYY-MM-DD
          if (dateOnly) {
            const hits = list.filter((a) => this.isSameTrDate(a.startAtIso, dateOnly));
            if (hits.length === 1) {
              const a = hits[0];
              this.softResetSession(session, tenantId, from, { keepIdempotency: true });
              this.saveSession(key, session);
              const line =
                `Randevun şurada görünüyor:\n` +
                `• ${prettyIstanbul(a.startAtIso)}` +
                (a.serviceName ? ` • ${a.serviceName}` : '') +
                (a.staffName ? ` • ${a.staffName}` : '');
              return this.safeReply(session, line);
            }
          }
        }

        // Or pick by menu number / suggestion
        const picked = this.pickFromSuggestions(session, raw);
        let apptId = picked?.type === 'appt' ? picked.apptId : '';

        if (!apptId) {
          // try ordinal "2. randevu" style
          const ord = extractOrdinal1to9(raw);
          if (ord != null) {
            const idx = Math.max(0, Math.min(8, ord - 1));
            apptId = list[idx]?.id ? String(list[idx].id) : '';
          }
        }

        const chosen = list.find((a) => String(a.id) === String(apptId)) || null;
        if (!chosen) {
          // re-ask
          session.lastSuggestions = {
            type: 'appt',
            items: list.slice(0, 9).map((a) => ({
              label: `${prettyIstanbul(a.startAtIso)}${a.serviceName ? ` • ${a.serviceName}` : ''}${a.staffName ? ` • ${a.staffName}` : ''}`,
              value: String(a.id),
            })),
            ts: Date.now(),
          };
          const lines = session.lastSuggestions.items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
          this.saveSession(key, session);
          return this.safeReply(session, `Şu randevularını görüyorum:\n${lines}\n\nHangisi? 1-9 söylemen yeterli 🙂`);
        }

        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        this.saveSession(key, session);

        const line =
          `Randevun şurada görünüyor:\n` +
          `• ${prettyIstanbul(chosen.startAtIso)}` +
          (chosen.serviceName ? ` • ${chosen.serviceName}` : '') +
          (chosen.staffName ? ` • ${chosen.staffName}` : '');
        return this.safeReply(session, line);
      }


      if (isCancel(msg)) {
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        this.saveSession(key, session);
        return this.safeReply(session, 'Tamam, iptal ettim. Yeni randevu için “randevu” diyebilirsin.');
      }

      if (isRestart(msg)) {
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        session.state = WaState.WAIT_SERVICE;
        this.saveSession(key, session);

        const services = await this.safeListServices(tenantId);
        const reply = this.askService(services, { gentle: true });
        return this.safeReply(session, reply);
      }

      const business = await (this.prisma as any).businessProfile?.findUnique({ where: { tenantId } }).catch(() => null);
      const services = await this.safeListServices(tenantId);
      const staff = await this.safeListStaff(tenantId);

      if (isSimpleGreetingOnly(raw)) {
        return this.safeReply(session, 'Merhaba, hoş geldiniz. Nasıl yardımcı olayım?');
      }

      this.extractSlotsFromMessage({ session, raw, services, staff });

      const learned = await this.safeGetLearnedCustomerContext(tenantId, from, services);

      if (learned?.name && !session.draft.customerName) {
        session.draft.customerName = String(learned.name);
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
        });
        this.saveSession(key, session);
        return this.safeReply(session, reply);
      }

      // =========================
      // ✅ Upcoming appointment inquiry (IDLE iken)
      // =========================
      if (looksLikeUpcomingQuery(raw)) {
        const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 6);

        if (!list?.length) {
          return this.safeReply(session, 'Şu an görünen bir randevun yok 🙂');
        }

        if (list.length === 1) {
          const a = list[0];
          const line =
            `Randevun şurada görünüyor:\n` +
            `• ${prettyIstanbul(a.startAtIso)}` +
            (a.serviceName ? ` • ${a.serviceName}` : '') +
            (a.staffName ? ` • ${a.staffName}` : '');

          return this.safeReply(session, line);
        }

        // ✅ if multiple: move to WAIT_INFO_APPT_PICK so follow-ups like "yarınaydı" won't fall into LLM
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

        const lines = session.lastSuggestions.items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
        return this.safeReply(session, `Randevuların:\n${lines}\n\nHangisiyle ilgiliydi? 1-9 söyleyebilir ya da “yarın/bugün” diyebilirsin 🙂`);
      }


      // =========================
      // ✅ Edit intent (IDLE iken): randevu iptal/değiştir
      // Kullanıcı açıkça iptal/değiştir niyeti belirtmediği sürece edit akışına girmeyiz.
      // Yeni randevu isteği (booking intent) her zaman önceliklidir.
      // =========================
      const explicitEditIntent = looksLikeCancelIntent(raw) || looksLikeRescheduleIntent(raw) || looksLikeGenericEditIntent(raw);
      const explicitNewBookingIntent = looksLikeBookingIntent(raw) && !explicitEditIntent;
      if (explicitEditIntent && !explicitNewBookingIntent) {
        const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 6);
        if (!list?.length) return this.safeReply(session, 'Görünen bir randevunuz yok 🙂');

        // Tek randevu varsa: direkt hedefi set et
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
          // set base date for time-only edits
          session.editBaseStartAtIso = String(a.startAtIso);

          // draft'ı mevcut randevudan doldur (edit yapacağız)
          session.draft.serviceId = String(a.serviceId);
          session.draft.staffId = String(a.staffId);
          session.draft.startAt = String(a.startAtIso);

          // 1) Kullanıcı direkt iptal dediyse -> direkt onay
          if (looksLikeCancelIntent(raw)) {
            session.editMode = 'CANCEL';
            session.pendingSummary = this.buildEditCancelSummary(session.targetApptSnapshot);
            session.state = WaState.WAIT_CONFIRM;
            this.saveSession(key, session);
            return this.safeReply(session, `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`);
          }

          // 2) Kullanıcı direkt yeni saat/tarih yazdıysa -> direkt onay akışına al
          const tNorm = normalizeTr(raw);
          const onlyTime = parseTimeBest(tNorm);
          const parsed = parseDateTimeTR(raw);

          // “saat 11:00” gibi (tarih yoksa): aynı gün kalsın
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
                return this.safeReply(session, 'O saati ayarlayamadım 😕 Başka bir saat söyler misin?');
              }

              session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
              session.state = WaState.WAIT_CONFIRM;
              this.saveSession(key, session);
              return this.safeReply(session, `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`);
            }
          }

          // parsed içinde tarih+saat varsa
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
              return this.safeReply(session, 'O zamanı ayarlayamadım 😕 Başka bir tarih/saat söyler misin?');
            }

            session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
            session.state = WaState.WAIT_CONFIRM;
            this.saveSession(key, session);
            return this.safeReply(session, `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`);
          }

          // sadece tarih geldiyse -> saat sor
          if (parsed?.dateOnly) {
            session.editMode = 'RESCHEDULE';
            session.pendingDateOnly = parsed.dateOnly;
            session.state = WaState.WAIT_DATETIME;
            this.saveSession(key, session);
            return this.safeReply(session, this.humanizeAskTimeOnly(raw));
          }

          // 3) Net değilse menü sor
          session.state = WaState.WAIT_EDIT_ACTION;
          this.saveSession(key, session);
          return this.safeReply(session, this.askEditActionMenu(session, a));
        }

// ✅ IDLE iken: "2. randevuyu 13:00 yap" gibi tek mesajda hem seçim hem saat varsa menüyü atla
const tInline = normalizeTr(raw);
const mPick = tInline.match(/^\s*([1-9])\s*[\.\)\-:]?/); // "1." "2)" "3-" gibi
const parsedInline = parseDateTimeTR(raw);
const onlyTimeInline = parseTimeBest(tInline);

if (mPick && (parsedInline?.hasTime || onlyTimeInline)) {
  const idx = Math.max(0, Math.min(8, Number(mPick[1]) - 1));
  const chosen = list[idx];

  if (chosen) {
    // hedef randevu snapshot
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

    // draft'ı randevudan doldur
    session.draft.serviceId = String(chosen.serviceId);
    session.draft.staffId = String(chosen.staffId);

    // iptal dediyse direkt iptal onayı
    if (looksLikeCancelIntent(raw)) {
      session.editMode = 'CANCEL';
      session.pendingSummary = this.buildEditCancelSummary(session.targetApptSnapshot);
      session.state = WaState.WAIT_CONFIRM;
      this.saveSession(key, session);
      return this.safeReply(session, `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`);
    }

    // saat/tarih değişikliği
    let iso: string | null = null;

    // sadece saat verdiyse mevcut tarihle birleştir
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
        // doluysa tekrar saat sor
        session.draft.startAt = String(chosen.startAtIso);
        session.state = WaState.WAIT_DATETIME;
        this.saveSession(key, session);
        return this.safeReply(session, 'O saat dolu gibi 😕 Başka bir saat söyler misin?');
      }

      session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
      session.state = WaState.WAIT_CONFIRM;
      this.saveSession(key, session);
      return this.safeReply(session, `${session.pendingSummary}\n${this.softYesNoHint(from + iso)}`);
    }
  }
}

        // Birden fazla randevu -> seçtir
        session.state = WaState.WAIT_APPT_PICK;
        this.saveSession(key, session);
        return this.safeReply(session, this.askAppointmentPickMenu(session, list));
      }

      // =========================
      // Booking intent
      // =========================
      if (looksLikeBookingIntent(raw)) {
        const svc = this.detectServiceFromMessage(raw, services);
        if (svc?.id) session.draft.serviceId = String(svc.id);

        if (!svc?.id && this.hasExplicitUnknownServiceRequest(raw, services)) {
          this.logAction('unknown_service_detected', {
            tenantId,
            phone: from,
            raw,
          });
          return this.safeReply(
            session,
            'Bu isimde bir hizmetimizi bulamadım. İsterseniz mevcut işlemlerimizden birini söyleyebilirsiniz.',
          );
        }

        const parsed = parseDateTimeTR(raw);
        if (parsed?.hasTime) {
          session.pendingStartAt = toIstanbulIso(clampToFuture(parsed.dateUtc));
          if (!session.draft.startAt && session.pendingStartAt) session.draft.startAt = session.pendingStartAt;
          session.pendingDateOnly = undefined;
        } else if (parsed?.dateOnly) {
          session.pendingDateOnly = parsed.dateOnly;
        }

        if (!isNoPreferenceStaff(raw)) this.tryAutofillStaff(session.draft, staff, raw);

        if (!session.draft.serviceId) {
          session.state = WaState.WAIT_SERVICE;
          this.saveSession(key, session);
          return this.safeReply(session, await this.naturalAsk(session, 'service', { services, staff, business }));
        }

        if (staff && staff.length > 0 && !session.draft.staffId) {
          session.state = WaState.WAIT_STAFF;
          this.saveSession(key, session);
          return this.safeReply(session, this.askStaffMenu(session, staff));
        }

        session.state = WaState.WAIT_NAME;
        this.saveSession(key, session);
        return this.safeReply(session, await this.naturalAsk(session, 'name', { services, staff, business }));
      }

      // =========================
      // info flows
      // =========================
      if (looksLikePriceQuestion(msg)) {
        const svc = this.detectServiceFromMessage(raw, services);
        if (svc) {
          const name = String(svc.name || 'Hizmet');
          const price = svc.price ?? null;
          const dur = svc.duration ?? null;

          const parts: string[] = [];
          if (price != null) parts.push(`${name} fiyatı: ${price}₺`);
          else parts.push(`${name} için fiyat bilgisi henüz eklenmemiş görünüyor.`);
          if (dur != null) parts.push(`Süre: ${dur} dk`);

          const nudge = this.shouldNudgeBooking(session) ? '\nİstersen “randevu oluştur” diyebilirsin, hemen ayarlayalım.' : '';
          return this.safeReply(session, parts.join(' • ') + nudge);
        }
        return this.safeReply(session, 'Hangi hizmetin fiyatını soruyorsun? (Örn: “Hizmet adı fiyatı”)');
      }

      if (looksLikeServiceListRequest(msg)) {
        const list = servicesToTextShort(services);
        if (!list) return this.safeReply(session, 'Şu an hizmet listem görünmüyor 😕 Birazdan tekrar dener misin?');
        return this.safeReply(session, `Hizmetlerimiz:\n${list}`);
      }

      if (looksLikeAddressOrHours(msg)) {
        const addr = business?.address || business?.fullAddress || business?.location || null;
        const parts: string[] = [];
        if (addr) parts.push(`📍 Adres: ${String(addr)}`);
        parts.push(`⏰ Çalışma saatleri: Her gün 08:00 - 22:00`);
        return this.safeReply(session, parts.join('\n'));
      }

      if (looksLikeProcedureQuestion(msg)) {
        const svc = this.detectServiceFromMessage(raw, services);
        session.lastTopic = 'procedure';
        session.lastServiceId = svc && svc.id ? String(svc.id) : undefined;

        let out = await this.answerWithLLM({
          raw,
          business,
          services,
          staff,
          history: this.getRecentHistory(session, 8),
          mode: 'procedure',
          focusService: svc ? { name: String(svc.name || ''), duration: svc.duration, price: svc.price } : null,
          learnedCustomerSummary: learned?.summary || '',
        });

        if (!out) {
          const base = svc
            ? this.procedureTemplateForService(String(svc.name || ''), svc.duration, svc.price)
            : 'Genel olarak süreç hizmetin türüne göre değişir. Hangi işlem veya hizmet için soruyorsun?';
          return this.safeReply(session, base);
        }

        if (session.lastAssistantReply && normalizeTr(session.lastAssistantReply) === normalizeTr(out)) {
          const alt = await this.answerWithLLM({
            raw,
            business,
            services,
            staff,
            history: this.getRecentHistory(session, 8),
            mode: 'procedure',
            focusService: svc ? { name: String(svc.name || ''), duration: svc.duration, price: svc.price } : null,
            avoidRepeat: true,
            learnedCustomerSummary: learned?.summary || '',
          });
          if (alt && normalizeTr(alt) !== normalizeTr(session.lastAssistantReply || '')) out = alt;
          else out = 'Tam olarak hangi hizmet veya konu hakkında bilgi almak istiyorsunuz?';
        }

        return this.safeReply(session, out);
      }

      session.lastTopic = 'general';
      session.lastServiceId = undefined;

      let llmAnswer = await this.answerWithLLM({
        raw,
        business,
        services,
        staff,
        history: this.getRecentHistory(session, 8),
        mode: 'general',
        focusService: null,
        learnedCustomerSummary: learned?.summary || '',
      });

      if (!llmAnswer) llmAnswer = '';

      if (llmAnswer && session.lastAssistantReply && normalizeTr(session.lastAssistantReply) === normalizeTr(llmAnswer)) {
        const alt = await this.answerWithLLM({
          raw,
          business,
          services,
          staff,
          history: this.getRecentHistory(session, 8),
          mode: 'general',
          focusService: null,
          avoidRepeat: true,
          learnedCustomerSummary: learned?.summary || '',
        });
        llmAnswer =
          alt && normalizeTr(alt) !== normalizeTr(session.lastAssistantReply || '')
            ? alt
            : 'Tam olarak ne öğrenmek istiyorsunuz?';
      }

      return this.safeReply(session, llmAnswer || 'Anlayamadım 😕 İstersen ne yapmak istediğini kısaca söyle.');
    } catch (e: any) {
      this.logger.error(`[AgentService.replyText] ${e?.message || e}`);
      return this.safeReply(session, 'Şu an bir hata oluştu 😕 Lütfen tekrar dener misin?');
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
  }): Promise<string> {
    const { key, session, tenantId, from, msg, raw, services, staff } = opts;

// ✅ Booking/edit akışındayken kullanıcı bilgi sorarsa akıştan çık (ama draft kalsın)
if (!session.editMode && session.state !== WaState.IDLE) {
  const infoBreak =
    looksLikeProcedureQuestion(raw) ||
    looksLikePriceQuestion(msg) ||
    looksLikeServiceListRequest(msg) ||
    looksLikeAddressOrHours(msg) ||
    looksLikeUpcomingQuery(raw);

  if (infoBreak && !isYes(msg) && !isNo(msg) && !looksLikeBookingIntent(raw)) {
    session.state = WaState.IDLE;
    session.pendingSummary = undefined;
    session.lastSuggestions = undefined;
    // draft'ı SAKLIYORUZ (kullanıcı sonra “randevu” derse hızlanır)
  }
}


    // ✅ Edit/Booking flow içinde “konu değişti” diye çıkma:
    if (session.state !== WaState.WAIT_APPT_PICK && session.state !== WaState.WAIT_EDIT_ACTION) {
      if (!session.editMode && shouldExitBookingFlow(msg, raw)) {
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        this.saveSession(key, session);
        return 'Tamam 👍 Anladım. Nasıl yardımcı olayım?';
      }
    }

    // ✅ Edit başlangıcı: randevu seçimi
    if (session.state === WaState.WAIT_APPT_PICK) {
      const list = await this.safeListUpcomingAppointmentsByPhone(tenantId, from, 6);
      if (!list?.length) {
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        return 'Görünen bir randevunuz yok 🙂';
      }

      // Kullanıcı “hepsi” veya “tümünü” derse tüm randevuları iptal etmek istediğini varsay
      const tHepsi = normalizeTr(raw);
      if (tHepsi.includes('hepsi') || tHepsi.includes('hepsini') || tHepsi.includes('tum') || tHepsi.includes('tumu') || tHepsi.includes('tümünü')) {
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
            session.pendingSummary = this.buildEditCancelSummary(session.targetApptSnapshot);
            session.state = WaState.WAIT_CONFIRM;
            return `${session.pendingSummary}\n${this.softYesNoHint(from + session.targetAppointmentId)}`;
          }

          // reschedule inline
          let iso: string | null = null;
          if (onlyTimeInline && !hasExplicitDateMarker(normalizeTr(raw))) {
            const baseIso = session.editBaseStartAtIso || String(chosen.startAtIso);
            iso = buildIsoWithSameDate(baseIso, onlyTimeInline.hh, onlyTimeInline.mm);
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
          normalizeTr(`${a.serviceName || ''} ${a.staffName || ''} ${prettyIstanbul(a.startAtIso)}`).includes(t),
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
    const baseIso = session.editBaseStartAtIso || String(chosen.startAtIso);
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
        session.pendingSummary = this.buildEditCancelSummary(session.targetApptSnapshot);
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
            return this.askSlotMenu(session, isoList, `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`);
          }
          if (pre.code === 'SLOT_TAKEN' && pre.suggestions?.length) {
            session.draft.startAt = undefined;
            const isoList = pre.suggestions.map((s) => s.startAt);
            return this.askSlotMenu(session, isoList, `O saat dolu 😕 Şunlar uygun:`);
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
      const wantsService = act === 'SERVICE' || t.includes('hizmet') || t.includes('islem') || t.includes('işlem');
      const wantsStaff =
        act === 'STAFF' ||
        t.includes('usta') ||
        t.includes('personel') ||
        t.includes('calisan') ||
        t.includes('çalışan');
      const wantsCancel = act === 'CANCEL' || t === 'iptal' || t.includes('iptal');
      const wantsAbort = act === 'ABORT' || t.includes('vazgec') || t.includes('vazgeç') || t.includes('bosver') || t.includes('boşver');

      if (wantsAbort) {
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        this.saveSession(key, session);
        return 'Tamam 👍 Vazgeçtik. Nasıl yardımcı olayım?';
      }

      if (wantsCancel) {
        session.editMode = 'CANCEL';
        session.pendingSummary = this.buildEditCancelSummary(session.targetApptSnapshot);
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
        session.state = WaState.WAIT_STAFF;
        return this.askStaffMenu(session, staff);
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
      session.pendingStartAt = toIstanbulIso(clampToFuture(parsedEarly.dateUtc));
      if (!session.draft.startAt && session.pendingStartAt) session.draft.startAt = session.pendingStartAt;
      session.pendingDateOnly = undefined;
    } else if (parsedEarly?.dateOnly) {
      session.pendingDateOnly = parsedEarly.dateOnly;
    }

    this.extractSlotsFromMessage({ session, raw, services, staff });
    this.logAction('extracted_slots', {
      tenantId,
      phone: from,
      serviceId: session.draft.serviceId || null,
      staffId: session.draft.staffId || null,
      startAt: session.draft.startAt || null,
      customerName: session.draft.customerName || null,
      pendingDateOnly: session.pendingDateOnly || null,
    });
    this.logAction('next_missing_slot_selection', {
      tenantId,
      phone: from,
      nextSlot: this.getNextMissingSlot(session),
      state: session.state,
    });

    const picked = this.pickFromSuggestions(session, raw);
    if (picked?.type === 'staff' && picked.staffId) session.draft.staffId = picked.staffId;
    if (picked?.type === 'slot' && picked.startAt) {
      session.draft.startAt = picked.startAt;
      session.pendingStartAt = picked.startAt;
      session.pendingDateOnly = undefined;
    }

    if (!session.draft.serviceId && services.length === 1 && services[0]?.id) session.draft.serviceId = String(services[0].id);
    if (!session.draft.staffId && staff.length === 1 && staff[0]?.id) session.draft.staffId = String(staff[0].id);

    if (session.state === WaState.WAIT_SERVICE) {
      // Voice flow must not ask/confirm previously suggested services.
      session.suggestedServiceId = undefined;
      session.suggestedServiceName = undefined;

      if (session.editMode) {
        if (!session.draft.serviceId) return await this.naturalAsk(session, 'service', { services, staff, business: null });

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

      if (!session.draft.serviceId && this.hasExplicitUnknownServiceRequest(raw, services)) {
        this.logAction('unknown_service_detected', {
          tenantId,
          phone: from,
          raw,
          state: session.state,
        });
        return 'Bu isimde bir hizmetimizi bulamadım. İsterseniz mevcut işlemlerimizden birini söyleyebilirsiniz.';
      }

      if (!session.draft.serviceId) return await this.naturalAsk(session, 'service', { services, staff, business: null });
      session.state = WaState.WAIT_STAFF;
    }

    if (session.state === WaState.WAIT_STAFF) {
      if (!staff || staff.length === 0) {
        return 'Şu an personel listem görünmüyor 😕 Birazdan tekrar dener misin?';
      }

      if (isNoPreferenceStaff(raw)) {
        session.draft.staffId = String(staff[0].id);
        session.state = session.editMode ? WaState.WAIT_CONFIRM : WaState.WAIT_NAME;
      } else if (!session.draft.staffId) {
        // Caller provided a name that doesn't match our staff list. Treat as no preference and store it.
        session.draft.staffId = String(staff[0].id);
        session.draft.requestedStaffName = raw.trim();
        session.state = session.editMode ? WaState.WAIT_CONFIRM : WaState.WAIT_NAME;
      } else {
        session.state = session.editMode ? WaState.WAIT_CONFIRM : WaState.WAIT_NAME;
      }

      if (session.editMode) {
        const pre = await this.precheckAndPrepareConfirm({
          tenantId,
          draft: session.draft,
          ignoreAppointmentId: session.targetAppointmentId || undefined,
        });
        if (!pre.ok) {
          session.draft.staffId = undefined;
          if (pre.code === 'SLOT_TAKEN') return 'O personelin o saati dolu 😕 Başka bir personel seçelim mi?';
          return 'Bu personelle şu anki randevu çakışıyor gibi 😕 Başka bir personel seçebilir misin?';
        }
        session.pendingSummary = `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}`;
        session.state = WaState.WAIT_CONFIRM;
        return `${session.pendingSummary}\n${this.softYesNoHint(from + (session.draft.startAt || ''))}`;
      }
    }

    if (session.state === WaState.WAIT_NAME) {
      if (!session.draft.customerName) {
        const maybeName = extractName(raw);
        const looksLikeStaffName = staff?.some((p: any) => normalizePersonName(String(p?.name || '')) === normalizePersonName(raw));
        if (!looksLikeStaffName && maybeName) session.draft.customerName = maybeName;
      }

      if (!session.draft.customerName) return await this.naturalAsk(session, 'name', { services, staff, business: null });
      session.state = WaState.WAIT_DATETIME;
    }

    if (session.state === WaState.WAIT_DATETIME) {
      let startIso = session.draft.startAt;

      if (parsedEarly?.hasTime) {
        session.pendingDateOnly = undefined;
      }

      if (!startIso) {
        const parsed = parseDateTimeTR(raw);

        if (!parsed && session.pendingDateOnly) return this.humanizeAskTimeOnly(raw);
        if (parsed && !parsed.hasTime && session.pendingDateOnly) return this.humanizeAskTimeOnly(raw);

        const onlyTime = parseTimeBest(normalizeTr(raw));
        if (onlyTime && session.pendingDateOnly) {
          const [yy, mm, dd] = session.pendingDateOnly.split('-').map(Number);
          const dUtc = new Date(Date.UTC(yy, mm - 1, dd, onlyTime.hh - 3, onlyTime.mm, 0, 0));
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
        return this.askSlotMenu(session, suggestions, `Bu saatlerde çalışmıyoruz 😕\n⏰ 08:00 - 22:00\nŞunlar uygun olabilir:`);
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
          return this.askSlotMenu(session, isoList, `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`);
        }

        if (pre.code === 'SLOT_TAKEN' && pre.suggestions?.length) {
          session.draft.startAt = undefined;
          const isoList = pre.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(session, isoList, `O saat dolu 😕 Şunlar uygun:`);
        }

        session.draft.startAt = undefined;
        return this.pickOne(
          ['Randevu kontrolünde bir sorun oldu 😕 Farklı bir saat dener misin?', 'Bir şey takıldı 😕 Başka bir saat deneyelim mi?'],
          raw,
        );
      }

      session.pendingSummary = session.editMode ? `Değişiklik özeti:\n${pre.summary.replace(/^Randevu özeti:\n?/, '')}` : pre.summary!;
      session.state = WaState.WAIT_CONFIRM;
      return `${session.pendingSummary}\n${this.softYesNoHint(from + (session.draft.startAt || ''))}`;
    }

    if (session.state === WaState.WAIT_CONFIRM) {
      const parsed = parseDateTimeTR(raw);
      if (parsed?.hasTime) {
        const iso = toIstanbulIso(clampToFuture(parsed.dateUtc));
        if (!isWithinWorkingHoursIso(iso)) {
          const suggestions = suggestWorkingHourAlternatives(iso, 5);
          return this.askSlotMenu(session, suggestions, `Bu saatlerde çalışmıyoruz 😕\n⏰ 08:00 - 22:00\nŞunlar uygun olabilir:`);
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
          const isBulk = !!(session.cancelAllIds && session.cancelAllIds.length);
          // If multiple IDs to cancel (hepsi) use bulk cancellation
          if (isBulk && session.cancelAllIds) {
            ok = await this.safeCancelMultipleAppointments(tenantId, session.cancelAllIds);
          } else if (session.targetAppointmentId) {
            ok = await this.safeCancelAppointment(tenantId, session.targetAppointmentId);
          }
          this.softResetSession(session, tenantId, from, { keepIdempotency: true });
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
          return this.askSlotMenu(session, isoList, `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`);
        }

        if (!upd.ok && upd.code === 'SLOT_TAKEN' && upd.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = upd.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(session, isoList, `O saat dolu 😕 Şunlar uygun:`);
        }

        if (!upd.ok) {
          session.state = WaState.WAIT_EDIT_ACTION;
          session.pendingSummary = undefined;
          return 'Bir şey takıldı 😕 Ne yapalım: saat mi değişsin, hizmet mi, personel mi, iptal mi?';
        }

        const newIso = upd.data.startAt;
        const apptId = upd.data.appointmentId;

        session.lastBookingContext = {
          startAtIso: newIso,
          serviceName: session.targetApptSnapshot?.serviceName,
          staffName: session.targetApptSnapshot?.staffName,
          customerName: session.draft.customerName || undefined,
        };
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
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
        this.softResetSession(session, tenantId, from, { keepIdempotency: true });
        this.saveSession(key, session);
        const reply = this.formatBookingSuccess(startAt, apptId, from + startAt);
        (session as any).lastBookingSummary = reply;
        (session as any).lastBookingStartAt = startAt;
        this.saveSession(key, session);
        return reply;
      }

      const created = await this.createAppointment({ tenantId, draft: session.draft, staffFallbackList: staff });

      if (!created.ok && created.code === 'NEED_NAME') {
        session.state = WaState.WAIT_NAME;
        return await this.naturalAsk(session, 'name', { services, staff, business: null });
      }

      if (!created.ok) {
        if (created.code === 'OUT_OF_HOURS' && created.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = created.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(session, isoList, `Bu saatlerde çalışmıyoruz 😕 (08:00 - 22:00)\nŞunlar uygun:`);
        }

        if (created.code === 'SLOT_TAKEN' && created.suggestions?.length) {
          session.state = WaState.WAIT_DATETIME;
          session.draft.startAt = undefined;
          const isoList = created.suggestions.map((s) => s.startAt);
          return this.askSlotMenu(session, isoList, `O saat dolu 😕 Şunlar uygun:`);
        }

        session.state = WaState.WAIT_DATETIME;
        session.draft.startAt = undefined;
        return this.pickOne(['Randevu oluştururken bir şey ters gitti 😕 Başka bir saat dener misin?', 'Bir hata oldu 😕 Hangi saat uygun, tekrar deneyelim.'], raw);
      }

      session.lastCreatedBookingKey = bookingKey || undefined;
      session.lastCreatedAppointmentId = created.data.appointmentId;
      session.lastCreatedAt = Date.now();

      await this.learnFromSuccessfulBooking(tenantId, from, session.draft);

      session.lastBookingContext = {
        startAtIso: created.data.startAt,
        serviceName: services.find((s: any) => String(s?.id) === String(session.draft.serviceId))?.name,
        staffName:
          staff.find((p: any) => String(p?.id) === String(session.draft.staffId))?.name ||
          session.draft.requestedStaffName,
        customerName: session.draft.customerName || undefined,
      };
      this.softResetSession(session, tenantId, from, { keepIdempotency: true });
      this.saveSession(key, session);
      const successMsg = this.formatBookingSuccess(created.data.startAt, created.data.appointmentId, from + created.data.startAt);
      // Persist last booking summary and start time for follow‑up queries
      (session as any).lastBookingSummary = successMsg;
      (session as any).lastBookingStartAt = created.data.startAt;
      this.saveSession(key, session);
      return successMsg;
    }

    session.state = WaState.WAIT_SERVICE;
    return await this.naturalAsk(session, 'service', { services, staff, business: null });
  }

  // =========================
  // Menus
  // =========================
  private askStaffMenu(session: SessionState, staff: any[]) {
    // Prepare suggestions for UI/WhatsApp clients but avoid reading out long lists on the phone.
    const items = (staff || [])
      .filter(Boolean)
      .slice(0, 9)
      .map((p: any) => ({
        id: String(p.id),
        label: String(p.name || 'Personel'),
        value: String(p.id),
      }));

    session.lastSuggestions = { type: 'staff', items, ts: Date.now() };
    // For voice calls, ask succinctly without enumerating every option.
    return 'Hangi personeli tercih edersiniz? İsim söyleyebilirsiniz ya da fark etmez diyebilirsiniz.';
  }

private askSlotMenu(session: SessionState, isoList: string[], header: string) {
    const items = (isoList || [])
      .filter(Boolean)
      .slice(0, 9)
      .map((iso) => ({
        label: prettyIstanbul(iso),
        value: iso,
      }));

    session.lastSuggestions = { type: 'slot', items, ts: Date.now() };

    const lines = items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
    const tail = this.pickOne(['Birini seç (1-9) ya da saati söyle 🙂', '1-9 seçebilirsin, istersen saati söyle (örn: 17:15)'], lines);
    return `${header}\n${lines}\n\n${tail}`;
  }

  private askAppointmentPickMenu(session: SessionState, appts: UpcomingAppt[]) {
    const items = (appts || [])
      .slice(0, 9)
      .map((a) => {
        const labelParts: string[] = [];
        labelParts.push(prettyIstanbul(a.startAtIso));
        if (a.serviceName) labelParts.push(String(a.serviceName));
        if (a.staffName) labelParts.push(`(${String(a.staffName)})`);
        return { label: labelParts.join(' • '), value: String(a.id) };
      });

    session.lastSuggestions = { type: 'appt', items, ts: Date.now() };

    const lines = items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
    const header = this.pickOne(
      ['Birden fazla randevun var 🙂 Hangisini değiştirelim/iptal edelim?', 'Şu randevularını görüyorum. Hangisiyle işlem yapalım?'],
      lines,
    );

    return `${header}\n${lines}\n\n1-9 söylemen yeterli.`;
  }

  private askEditActionMenu(session: SessionState, appt: { startAtIso: string; serviceName?: string; staffName?: string; id: string }) {
    const headerParts: string[] = [];
    headerParts.push('Tamam 🙂 Şu randevu için işlem yapacağız:');
    headerParts.push(`• ${prettyIstanbul(appt.startAtIso)}${appt.serviceName ? ` • ${appt.serviceName}` : ''}${appt.staffName ? ` • ${appt.staffName}` : ''}`);

    const items: SuggestionItem[] = [
      { label: 'Tarih/Saat değiştir', value: 'TIME' },
      { label: 'Hizmet değiştir', value: 'SERVICE' },
      { label: 'Personel/Usta değiştir', value: 'STAFF' },
      { label: 'Randevuyu iptal et', value: 'CANCEL' },
      { label: 'Vazgeç', value: 'ABORT' },
    ];

    session.lastSuggestions = { type: 'editAction', items, ts: Date.now() };

    const lines = items.map((it, i) => `${i + 1}) ${it.label}`).join('\n');
    const tail = 'İstersen 1-5 söyle, istersen direkt “saat değiştir / hizmet değiştir / personel değiştir / iptal” diyebilirsin 🙂';
    return `${headerParts.join('\n')}\n\nNe yapmak istersin?\n${lines}\n\n${tail}`;
  }

  private pickFromSuggestions(
    session: SessionState,
    raw: string,
  ):
    | { type: 'staff'; staffId: string }
    | { type: 'slot'; startAt: string }
    | { type: 'appt'; apptId: string }
    | { type: 'editAction'; action: 'TIME' | 'SERVICE' | 'STAFF' | 'CANCEL' | 'ABORT' }
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
      if (s.type === 'staff') return { type: 'staff', staffId: String(it.value) };
      if (s.type === 'slot') return { type: 'slot', startAt: String(it.value) };
      if (s.type === 'appt') return { type: 'appt', apptId: String(it.value) };
      if (s.type === 'editAction') return { type: 'editAction', action: String(it.value) as any };
      return null;
    }

    if (s.type === 'staff') {
      const tn = normalizePersonName(raw);
      const hit = s.items.find((it) => normalizePersonName(it.label) === tn);
      if (hit) return { type: 'staff', staffId: String(hit.value) };
    }

    if (s.type === 'slot') {
      const tm = parseTimeBest(t);
      if (tm) {
        const hhmm = `${String(tm.hh).padStart(2, '0')}:${String(tm.mm).padStart(2, '0')}`;
        const hit = s.items.find((it) => normalizeTr(it.label).endsWith(hhmm));
        if (hit) return { type: 'slot', startAt: String(hit.value) };
      }
      const hit2 = s.items.find((it) => normalizeTr(it.label) === normalizeTr(raw));
      if (hit2) return { type: 'slot', startAt: String(hit2.value) };
    }

    if (s.type === 'appt') {
      const hit = s.items.find((it) => normalizeTr(it.label).includes(normalizeTr(raw)));
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
        ['staff', 'STAFF'],
        ['personel', 'STAFF'],
        ['usta', 'STAFF'],
        ['calisan', 'STAFF'],
        ['çalışan', 'STAFF'],
        ['cancel', 'CANCEL'],
        ['iptal', 'CANCEL'],
        ['abort', 'ABORT'],
        ['vazgec', 'ABORT'],
        ['vazgeç', 'ABORT'],
        ['bosver', 'ABORT'],
        ['boşver', 'ABORT'],
      ];
      for (const [k, v] of map) {
        if (tt.includes(normalizeTr(k))) return { type: 'editAction', action: v };
      }
    }

    return null;
  }

  // =========================
  // Natural booking prompts
  // =========================
  private async naturalAsk(
    session: SessionState,
    slot: 'service' | 'staff' | 'name' | 'datetime',
    ctx: { services: any[]; staff: any[]; business: any },
  ): Promise<string> {
    const fallback = () => {
      if (slot === 'service') return this.humanizeAsk('service');
      if (slot === 'staff') return this.askStaffMenu(session, ctx.staff);
      if (slot === 'name') return this.humanizeAsk('name');
      return this.humanizeAsk('datetime');
    };

    if (!this.openai) return fallback();

    const missingHint =
      slot === 'service'
        ? 'Müşteriden sadece hangi hizmet istediğini sor.'
        : slot === 'staff'
          ? 'Müşteriden hangi personeli tercih ettiğini sor. “Fark etmez” diyebileceğini de söyle.'
          : slot === 'name'
            ? 'Müşteriden ad soyadını sor. Kısa ve doğal sor.'
            : 'Müşteriden gün ve saat bilgisini sor. Örnek format ver ama çok uzun yazma. Saat aralığı 08:00-22:00.';

    const staffNamesShort = staffToTextShort(ctx.staff) || '';

    // Build a dynamic system prompt. If we have a business profile name use it,
    // otherwise fall back to a generic “işletme” descriptor. This avoids
    // hard‑coding any specific sector such as beauty and keeps the wording
    // neutral for multi‑tenant deployments.
    const businessLabel = ctx.business?.name ? String(ctx.business.name) : 'işletme';
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
      this.logAction('llm_response', { mode: 'naturalAsk', slot, response: cleaned });
      if (!cleaned || cleaned.length < 2) return fallback();
      return cleaned;
    } catch {
      return fallback();
    }
  }

  private askService(services: any[], opts: { gentle: boolean }) {
    return opts.gentle ? 'Hangi hizmet için yardımcı olayım?' : 'Hangi hizmeti istersiniz?';
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

      const serviceCount = new Map<string, { id: string; name: string; c: number }>();
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
    const { tenantId, staffId, dateAtUtcMidnight, timeHHMM, endTimeHHMM, ignoreAppointmentId } = opts;

    const existing = await (this.prisma as any).appointments
      .findMany({
        where: { tenantId, staffId, date: dateAtUtcMidnight },
        select: { id: true, time: true, endTime: true },
        take: 200,
      })
      .catch(() => []);

    for (const a of existing || []) {
      if (ignoreAppointmentId && String(a?.id) === String(ignoreAppointmentId)) continue;
      const s = String(a?.time || '');
      const e = String(a?.endTime || '');
      if (!s || !e) continue;
      if (this.overlaps(timeHHMM, endTimeHHMM, s, e)) return { id: String(a.id) };
    }
    return null;
  }

  private async precheckAndPrepareConfirm(opts: {
    tenantId: string;
    draft: BookingDraft;
    ignoreAppointmentId?: string;
  }): Promise<
    | { ok: true; summary: string }
    | { ok: false; code?: string; suggestions?: Array<{ startAt: string; endAt: string }> }
  > {
    const { tenantId, draft, ignoreAppointmentId } = opts;

    if (!draft.serviceId || !draft.startAt || !draft.customerPhone) return { ok: false };

    const service = await (this.prisma as any).services
      .findFirst({
        where: { id: String(draft.serviceId), tenantId },
        select: { id: true, name: true, duration: true, price: true },
      })
      .catch(() => null);
    if (!service) return { ok: false };

    if (!draft.staffId) return { ok: false };

    const staffRec = await (this.prisma as any).staff
      ?.findFirst({
        where: { id: String(draft.staffId), tenantId },
        select: { id: true, name: true },
      })
      .catch(() => null);

    const startIso = String(draft.startAt);
    const startUtc = new Date(startIso);
    const durationMinutes = Number(service.duration) || 30;

    const endIso = toIstanbulIso(new Date(startUtc.getTime() + durationMinutes * 60000));
    if (!isWithinWorkingHoursIso(startIso) || !isEndWithinWorkingHoursIso(endIso)) {
      const suggestions = suggestWorkingHourAlternatives(startIso, 5).map((s) => ({ startAt: s, endAt: s }));
      return { ok: false, code: 'OUT_OF_HOURS', suggestions };
    }

    const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(startIso, durationMinutes);

    const clash = await this.findOverlapSafe({
      tenantId,
      staffId: String(draft.staffId),
      dateAtUtcMidnight,
      timeHHMM,
      endTimeHHMM: endTimeHHMM || timeHHMM,
      ignoreAppointmentId,
    });

    if (clash) {
      const suggestions = await this.suggestSlotsSimple({
        tenantId,
        staffId: String(draft.staffId),
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
    lines.push(`• Hizmet: ${serviceName}${service.price != null ? ` — ${service.price}₺` : ''}`);
    if (staffName) lines.push(`• Personel: ${staffName}`);
    lines.push(`• Tarih/Saat: ${prettyIstanbul(startIso)}`);
    if (name) lines.push(`• İsim: ${name}`);

    return { ok: true, summary: lines.join('\n') };
  }

  // =========================
  // CREATE
  // =========================
  private async createAppointment(opts: {
    tenantId: string;
    draft: BookingDraft;
    staffFallbackList: any[];
  }): Promise<
    | { ok: true; data: { appointmentId: string; startAt: string } }
    | { ok: false; code?: string; suggestions?: Array<{ startAt: string; endAt: string }> }
  > {
    const { tenantId, draft, staffFallbackList } = opts;

    try {
      const serviceId = String(draft.serviceId || '');
      let staffId = draft.staffId ? String(draft.staffId) : '';
      const startAt = String(draft.startAt || '');
      const customerPhone = String(draft.customerPhone || '');
      const customerName = draft.customerName ? String(draft.customerName) : null;

      if (!serviceId || !startAt || !customerPhone) return { ok: false };
      if (!customerName || customerName.trim().length < 2) return { ok: false, code: 'NEED_NAME' };

      if (!isWithinWorkingHoursIso(startAt)) {
        const suggestions = suggestWorkingHourAlternatives(startAt, 5).map((s) => ({ startAt: s, endAt: s }));
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
        const list = staffFallbackList?.length ? staffFallbackList : await this.safeListStaff(tenantId);
        if (!list?.length) return { ok: false };
        staffId = String(list[0].id);
      }

      const fullName = customerName.trim();

      const now = new Date();
      const customer = await (this.prisma as any).customers.upsert({
        where: { tenantId_phoneNumber: { tenantId, phoneNumber: customerPhone } },
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

      const durationMinutes = Number(service.duration) || 30;
      const endIso = toIstanbulIso(new Date(new Date(startAt).getTime() + durationMinutes * 60000));
      if (!isEndWithinWorkingHoursIso(endIso)) {
        const suggestions = suggestWorkingHourAlternatives(startAt, 5).map((s) => ({ startAt: s, endAt: s }));
        return { ok: false, code: 'OUT_OF_HOURS', suggestions };
      }

      const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(startAt, durationMinutes);

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

      const appt = await (this.prisma as any).appointments.create({
        data: {
          tenantId,
          customerId: String(customer.id),
          serviceId: String(service.id),
          staffId,
          date: dateAtUtcMidnight,
          time: timeHHMM,
          endTime: endTimeHHMM,
          status: 'PENDING',
          channel: 'WHATSAPP',
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
  private buildEditCancelSummary(snap: NonNullable<SessionState['targetApptSnapshot']>) {
    const parts: string[] = [];
    parts.push('Şu randevunuzu iptal edeyim mi?');
    parts.push(`• Tarih/Saat: ${prettyIstanbul(snap.startAtIso)}`);
    if (snap.serviceName) parts.push(`• Hizmet: ${snap.serviceName}`);
    if (snap.staffName) parts.push(`• Personel: ${snap.staffName}`);
    return parts.join('\n');
  }

  private async safeCancelAppointment(tenantId: string, appointmentId: string): Promise<boolean> {
    try {
      await (this.prisma as any).appointments.update({
        where: { id: String(appointmentId) },
        data: { status: 'CANCELLED', updatedAt: new Date() } as any,
      });
      // log soft cancellation (status marked CANCELLED)
      this.logAction('appointment_cancelled', { tenantId, appointmentId: String(appointmentId) });
      return true;
    } catch {
      try {
        await (this.prisma as any).appointments.delete({
          where: { id: String(appointmentId) },
        });
        // log hard cancellation when record is deleted
        this.logAction('appointment_cancelled', { tenantId, appointmentId: String(appointmentId) });
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
  private async safeCancelMultipleAppointments(tenantId: string, appointmentIds: string[]): Promise<boolean> {
    try {
      for (const apptId of appointmentIds || []) {
        try {
          await (this.prisma as any).appointments.update({
            where: { id: String(apptId) },
            data: { status: 'CANCELLED', updatedAt: new Date() } as any,
          });
          this.logAction('appointment_cancelled', { tenantId, appointmentId: String(apptId) });
        } catch {
          // If update fails, attempt delete as fallback
          try {
            await (this.prisma as any).appointments.delete({ where: { id: String(apptId) } });
            this.logAction('appointment_cancelled', { tenantId, appointmentId: String(apptId) });
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
    | { ok: false; code?: string; suggestions?: Array<{ startAt: string; endAt: string }> }
  > {
    const { tenantId, appointmentId, draft } = opts;

    try {
      const current = await (this.prisma as any).appointments
        .findUnique({
          where: { id: String(appointmentId) },
          select: { id: true, tenantId: true, serviceId: true, staffId: true, date: true, time: true },
        })
        .catch(() => null);

      if (!current?.id) return { ok: false, code: 'NOT_FOUND' };
      if (String(current.tenantId) !== String(tenantId)) return { ok: false, code: 'NOT_FOUND' };

      const currentStartIso = this.schemaDateTimeToStartIso(current.date, String(current.time || '00:00'));

      const newServiceId = draft.serviceId ? String(draft.serviceId) : String(current.serviceId);
      const newStaffId = draft.staffId ? String(draft.staffId) : String(current.staffId);
      const newStartAt = draft.startAt ? String(draft.startAt) : String(currentStartIso);

      if (!isWithinWorkingHoursIso(newStartAt)) {
        const suggestions = suggestWorkingHourAlternatives(newStartAt, 5).map((s) => ({ startAt: s, endAt: s }));
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

      const endIso = toIstanbulIso(new Date(new Date(newStartAt).getTime() + durationMinutes * 60000));
      if (!isEndWithinWorkingHoursIso(endIso)) {
        const suggestions = suggestWorkingHourAlternatives(newStartAt, 5).map((s) => ({ startAt: s, endAt: s }));
        return { ok: false, code: 'OUT_OF_HOURS', suggestions };
      }

      const { dateAtUtcMidnight, timeHHMM, endTimeHHMM } = toSchemaDateTime(newStartAt, durationMinutes);

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

      await (this.prisma as any).appointments.update({
        where: { id: String(appointmentId) },
        data: {
          serviceId: newServiceId,
          staffId: newStaffId,
          date: dateAtUtcMidnight,
          time: timeHHMM,
          endTime: endTimeHHMM,
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
      return { ok: true, data: { appointmentId: String(appointmentId), startAt: newStartAt } };
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

  private async safeListUpcomingAppointmentsByPhone(tenantId: string, phone: string, limit: number): Promise<UpcomingAppt[]> {
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
          select: { id: true, serviceId: true, staffId: true, date: true, time: true },
        })
        .catch(() => []);

      if (!appts?.length) return [];

      const svcIds = [...new Set(appts.map((a: any) => String(a.serviceId || '')).filter(Boolean))];
      const stfIds = [...new Set(appts.map((a: any) => String(a.staffId || '')).filter(Boolean))];

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
      for (const s of svcs || []) svcMap.set(String(s.id), String(s.name || ''));

      const stfMap = new Map<string, string>();
      for (const p of stfs || []) stfMap.set(String(p.id), String(p.name || ''));

      return (appts || []).map((a: any) => {
        const startAtIso = this.schemaDateTimeToStartIso(a.date, String(a.time || '00:00'));
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
    const { tenantId, staffId, startFromIso, durationMinutes, stepMinutes, maxSuggestions, searchDays } = opts;

    const startUtc = new Date(startFromIso);
    const suggestions: Array<{ startAt: string; endAt: string }> = [];

    let cursor = startUtc;
    for (let day = 0; day < searchDays && suggestions.length < maxSuggestions; day++) {
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
        .map((x: any) => ({ s: String(x?.time || ''), e: String(x?.endTime || '') }))
        .filter((x: any) => x.s && x.e);

      for (let hh = WORK_START_HH; hh < WORK_END_HH && suggestions.length < maxSuggestions; hh++) {
        for (let mm = 0; mm < 60 && suggestions.length < maxSuggestions; mm += stepMinutes) {
          const candUtc = new Date(Date.UTC(y, m, d, hh - 3, mm, 0, 0));
          const candIso = toIstanbulIso(candUtc);

          if (!isWithinWorkingHoursIso(candIso)) continue;

          const { timeHHMM, endTimeHHMM } = toSchemaDateTime(candIso, durationMinutes);

          const endIso = toIstanbulIso(new Date(candUtc.getTime() + durationMinutes * 60000));
          if (!isEndWithinWorkingHoursIso(endIso)) continue;

          const clash = taken.some((t: any) => this.overlaps(timeHHMM, endTimeHHMM || timeHHMM, t.s, t.e));
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

    const { raw, business, services, staff, history, mode, focusService, avoidRepeat, learnedCustomerSummary } = opts;

    // Determine a user facing business name for prompts. Default to a generic
    // descriptor to keep the assistant sector agnostic.
    const bizName = business?.name ? String(business.name) : 'işletme';

    const servicesText = servicesToTextShort(services);
    const staffText = staffToTextShort(staff);

    const historyText =
      history && history.length
        ? history
            .slice(-8)
            .map((h) => `${h.role === 'user' ? 'Müşteri' : 'Asistan'}: ${h.text}`)
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

    if (mode === 'procedure') system += `\n- Prosedür modunda yumuşak ve samimi bir dille yanıt ver; sonunda zorla randevu isteme.`;
    if (avoidRepeat) system += `\n- Aynı cümleleri tekrar etme; cevabı farklı söyle.`;

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

  private procedureTemplateForService(serviceName: string, duration?: any, price?: any) {
    const parts: string[] = [];
    // Use neutral language so the assistant works across sectors
    parts.push(`${serviceName} için süreç ve prosedür hizmetin türüne ve kişisel koşullara göre değişebilir.`);
    if (duration != null) parts.push(`Ortalama süre genellikle ${duration} dakika civarındadır.`);
    parts.push('Gerekli adım veya seans sayısı seçilen hizmete ve ihtiyaçlara göre değişebilir.');
    const base = parts.join(' ');
    const priceLine = price != null ? `\nFiyat: ${price}₺` : '';
    return base + priceLine;
  }

  // =========================
  // DB lists
  // =========================
  private async safeListServices(tenantId: string) {
    return await (this.prisma as any).services
      .findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, price: true, duration: true },
        take: 50,
      })
      .catch(() => []);
  }

  private async safeListStaff(tenantId: string) {
    return await (this.prisma as any).staff
      ?.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true },
        take: 50,
      })
      .catch(() => []);
  }

  // =========================
  // Session helpers
  // =========================
  private getOrInitSession(key: string, tenantId: string, phone: string): SessionState {
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

  private softResetSession(s: SessionState, tenantId: string, phone: string, opts?: { keepIdempotency?: boolean }) {
    const keep = Boolean(opts?.keepIdempotency);

    const lastCreatedBookingKey = s.lastCreatedBookingKey;
    const lastCreatedAppointmentId = s.lastCreatedAppointmentId;
    const lastCreatedAt = s.lastCreatedAt;

    s.state = WaState.IDLE;
    s.draft = { tenantId, customerPhone: phone };

    s.pendingStartAt = undefined;
    s.pendingDateOnly = undefined;
    s.pendingSummary = undefined;

    s.lastTopic = undefined;
    s.lastServiceId = undefined;
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

  // =========================
  // Memory helpers
  // =========================
  private recordHistory(session: SessionState, role: 'user' | 'assistant', text: string) {
    const clean = (text || '').trim();
    if (!clean) return;
    session.history = session.history || [];
    session.history.push({ role, text: clean, ts: Date.now() });
    if (session.history.length > 20) session.history = session.history.slice(-20);
  }

  private getRecentHistory(session: SessionState, maxTurns: number): HistoryTurn[] {
    if (!session.history?.length) return [];
    return session.history.slice(-Math.max(1, maxTurns));
  }

  private isLikelyDuplicateInbound(session: SessionState, raw: string) {
    const t = normalizeTr(raw);
    if (!t) return false;
    const now = Date.now();

    if (session.lastUserTextNorm && session.lastUserAt) {
      if (session.lastUserTextNorm === t && now - session.lastUserAt < 15000) return true;
    }
    session.lastUserTextNorm = t;
    session.lastUserAt = now;
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
    const banned = ['ayarladım', 'ayarladim', 'kaydettim', 'güncelledim', 'guncelledim', 'iptal ettim', 'iptal ettim.', 'randevuyu kaydettim', 'randevunuzu kaydettim'];
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
          if (session.state === WaState.WAIT_SERVICE) out = this.humanizeAsk('service');
          else if (session.state === WaState.WAIT_STAFF) out = this.humanizeAsk('staff');
          else if (session.state === WaState.WAIT_NAME) out = this.humanizeAsk('name');
          else if (session.state === WaState.WAIT_DATETIME) out = this.humanizeAsk('datetime');
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
    const recent = this.getRecentHistory(session, 6).map((h) => normalizeTr(h.text)).join(' ');
    return recent.includes('randevu') || recent.includes('rezervasyon') || recent.includes('uygun') || recent.includes('yarin') || recent.includes('bugun');
  }

  // =========================
  // Matching
  // =========================
  private tryAutofillService(draft: BookingDraft, services: any[], msg: string) {
    // Always attempt to extract a service from the user's message and update the draft.
    // In voice bookings, the user may correct or override a previously selected service (e.g. "hayır lazer değil, protez tırnak").
    // Therefore we do not bail out when draft.serviceId is already set. Instead we detect a new service name and override.
    const hit = this.detectServiceFromMessage(msg, services);
    if (!hit || !hit.id) return;
    // If the message contains negation or override keywords, clear any previously suggested service name.
    const t = normalizeTr(msg);
    const negPatterns = ['degil', 'değil', 'istemiyorum', 'istemem', 'baska', 'başka', 'onun icin degil', 'onun için değil', 'farkli', 'farklı'];
    const hasNegation = negPatterns.some((p) => t.includes(p));
    // Always set the serviceId to the detected hit; this allows overriding a previous choice when the user specifies a new service.
    draft.serviceId = String(hit.id);
    if (hasNegation) {
      // Clear any suggested service tracking so that the flow does not ask about the old service again.
      (draft as any).suggestedServiceId = undefined;
      (draft as any).suggestedServiceName = undefined;
    }
  }

  private extractSlotsFromMessage(opts: { session: SessionState; raw: string; services: any[]; staff: any[] }) {
    const { session, raw, services, staff } = opts;
    const draft = session.draft;

    this.tryAutofillService(draft, services, raw);

    const hasCorrection = /\b(hayir|hayır)\b/.test(normalizeTr(raw)) && /\b(degil|değil)\b/.test(normalizeTr(raw));
    if (hasCorrection) {
      session.suggestedServiceId = undefined;
      session.suggestedServiceName = undefined;
    }

    if (!isNoPreferenceStaff(raw)) {
      this.tryAutofillStaff(draft, staff, raw);
      if (!draft.staffId) {
        const maybeSpoken = extractLikelyStaffName(raw);
        if (maybeSpoken) {
          draft.requestedStaffName = maybeSpoken;
          if (staff?.[0]?.id) draft.staffId = String(staff[0].id);
        }
      }
    }

    const parsed = parseDateTimeTR(raw);
    const tNorm = normalizeTr(raw);
    if (parsed?.hasTime) {
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
      draft.startAt = nextIso;
      session.pendingStartAt = draft.startAt;
      session.pendingDateOnly = undefined;
    } else if (parsed?.dateOnly) {
      // Keep existing time when caller only updates date ("yarın", "perşembe").
      let mergedWithExistingTime = false;
      if (draft.startAt) {
        const [yy, mm, dd] = parsed.dateOnly.split('-').map(Number);
        const prev = getTrPartsFromIso(draft.startAt);
        if (prev) {
          const mergedUtc = new Date(Date.UTC(yy, mm - 1, dd, prev.hh - 3, prev.mm, 0, 0));
          draft.startAt = toIstanbulIso(clampToFuture(mergedUtc));
          session.pendingStartAt = draft.startAt;
          session.pendingDateOnly = undefined;
          mergedWithExistingTime = true;
        }
      }
      if (!mergedWithExistingTime) {
        session.pendingDateOnly = parsed.dateOnly;
      }
    }

    const maybeName = extractName(raw);
    const looksLikeStaffName = staff?.some((p: any) => normalizePersonName(String(p?.name || '')) === normalizePersonName(raw));
    if (!looksLikeStaffName && maybeName) draft.customerName = maybeName;
  }

  private tryAutofillStaff(draft: BookingDraft, staff: any[], msg: string) {
    if (draft.staffId) return;
    const t = normalizePersonName(msg);
    const words = normalizePersonName(msg).split(/\s+/).filter(Boolean);

    const hit =
      staff.find((p: any) => normalizePersonName(String(p?.name || '')) === t) ||
      staff.find((p: any) => {
        const name = normalizePersonName(String(p?.name || ''));
        return words.some((w) => w.length >= 3 && name.includes(w));
      });

    if (hit?.id) draft.staffId = String(hit.id);
  }

  private detectServiceFromMessage(raw: string, services: any[]) {
    if (!services || services.length === 0) return null;
    const t = normalizeTr(raw);
    const words = t.split(/\s+/).filter(Boolean);

    const direct = services.find((s: any) => normalizeTr(String(s?.name || '')).includes(t));
    if (direct) return direct;

    const best = services.find((s: any) => {
      const name = normalizeTr(String(s?.name || ''));
      return words.some((w) => w.length >= 3 && name.includes(w));
    });

    return best || null;
  }

  private hasExplicitUnknownServiceRequest(raw: string, services: any[]) {
    const t = normalizeTr(raw);
    if (!t || !hasStrongServiceRequestCue(t)) return false;
    if (this.detectServiceFromMessage(raw, services)) return false;

    // If caller is only giving date/time/staff/name info, do not label as unknown service.
    if (parseDateTimeTR(raw)?.hasDate || parseTimeBest(t) || isNoPreferenceStaff(raw) || Boolean(extractName(raw))) {
      return false;
    }

    return true;
  }

  private getNextMissingSlot(session: SessionState): 'service' | 'staff' | 'name' | 'datetime' | 'confirm' {
    if (!session.draft.serviceId) return 'service';
    if (!session.draft.staffId) return 'staff';
    if (!session.draft.customerName) return 'name';
    if (!session.draft.startAt) return 'datetime';
    return 'confirm';
  }

  // =========================
  // Learning profile (best effort)
  // =========================
  private async saveLearningProfile(tenantId: string, phone: string, patch: Partial<LearningProfile>) {
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

      const base = (c as any)?.meta ?? (c as any)?.profile ?? (c as any)?.profileJson ?? {};
      const merged = { ...(base && typeof base === 'object' ? base : {}), ...data };

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

  private async learnFromSuccessfulBooking(tenantId: string, phone: string, draft: BookingDraft) {
    const patch: Partial<LearningProfile> = {
      lastServiceId: draft.serviceId ? String(draft.serviceId) : null,
      lastStaffId: draft.staffId ? String(draft.staffId) : null,
      lastStartAt: draft.startAt ? String(draft.startAt) : null,
    };

    if (draft.startAt) {
      const parts = getTrPartsFromIso(String(draft.startAt));
      if (parts) patch.preferredTimeHint = `${String(parts.hh).padStart(2, '0')}:${String(parts.mm).padStart(2, '0')}`;
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
  t = t.replace(/\b(uzman|uzmani|uzmanı|usta|dr|doktor|mr|ms)\b/g, ' ').replace(/\s+/g, ' ').trim();
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
  const shortQuestion = t.includes('?') && (t.includes('randevu') || t.includes('rezervasyon'));

  return wantsInfo || shortQuestion;
}

function isSimpleGreetingOnly(raw: string) {
  const t = normalizeTr(raw);
  if (!t) return false;
  return t === 'merhaba' || t === 'selam' || t === 'selamlar' || t === 'iyi gunler' || t === 'iyi aksamlar';
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


function looksLikeBookingIntent(raw: string) {
  const t = normalizeTr(raw);
  if (t === 'randevu' || t === 'rezervasyon') return true;
  const hasRandevu = t.includes('randevu') || t.includes('rezervasyon');
  if (!hasRandevu) return false;
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
    'isterim',
    'rezervasyon yap',
    'randevu yap',
    'randevu al',
  ];
  if (verbs.some((v) => t.includes(normalizeTr(v)))) return true;
  if (t.includes('yarin') || t.includes('bugun') || /\b\d{1,2}:\d{2}\b/.test(t)) return true;
  return false;
}

function looksLikeCancelIntent(raw: string) {
  const t = normalizeTr(raw);
  return t === 'iptal' || t.includes('iptal et') || t.includes('randevu iptal') || t.includes('randevumu iptal') || t.includes('vazgectim') || t.includes('vazgec');
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
  ) return true;

  // ✅ randevu kelimesi olmadan da yakala:
  // “saatini 13:00 yap”, “13:00’a al”, “13:00 ile değiştir”
  const hasTime = /\b\d{1,2}:\d{2}\b/.test(t);
  const hasChangeVerb =
    t.includes('degis') || t.includes('değiş') || t.includes('guncelle') || t.includes('güncelle') ||
    t.includes('al') || t.includes('cek') || t.includes('çek') || t.includes('tas') || t.includes('taş');

  if (hasTime && hasChangeVerb) return true;
  if (t.includes('saatini') && hasChangeVerb) return true;

  return false;
}
function looksLikeGenericEditIntent(raw: string) {
  const t = normalizeTr(raw);
  return (
    (t.includes('randevu') &&
      (t.includes('degis') || t.includes('değiş') || t.includes('guncelle') || t.includes('güncelle') || t.includes('duzenle') || t.includes('düzenle'))) ||
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
  return t.includes('hizmetler') || t.includes('hizmet list') || t.includes('listeyi at') || t.includes('neler var') || t.includes('servisler');
}

function looksLikePriceQuestion(msg: string) {
  const t = normalizeTr(msg);
  return t.includes('fiyat') || t.includes('ucret') || t.includes('kac tl') || t.includes('kaç tl');
}

function looksLikeAddressOrHours(msg: string) {
  const t = normalizeTr(msg);
  return t.includes('adres') || t.includes('konum') || t.includes('nerde') || t.includes('nerede') || t.includes('calisma saati') || t.includes('çalışma saati') || t.includes('kacda') || t.includes('kaçta');
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
  return t === 'iptal' || t.includes('iptal et') || t.includes('vazgectim') || t.includes('vazgec');
}

function isRestart(msg: string) {
  const t = normalizeTr(msg);
  return t === 'bastan' || t.includes('yeniden') || t.includes('sifirla') || t.includes('sıfırla');
}

function isYes(msg: string) {
  const t = normalizeTr(msg);
  if (!t) return false;
  if (/^(e|evet|olur|tamam|tabi|tabii|aynen|dogru|do[ğg]ru)$/.test(t)) return true;
  if (/(onayl[iı]yorum|onay|kesinlikle|evet olsun|aynen oyle|aynen öyle)/.test(t)) return true;
  return false;
}

function isNo(msg: string) {
  const t = normalizeTr(msg);
  if (!t) return false;
  if (/^(h|hayir|hayır|yok|olmaz|yanlis|yanlış)$/.test(t)) return true;
  if (/(istemiyorum|olmasin|olmasın|iptal|degil|değil|oyle degil|öyle değil)/.test(t)) return true;
  return false;
}

function servicesToTextShort(services: any[]) {
  if (!services || services.length === 0) return '';
  return services
    .slice(0, 6)
    .map((s: any) => {
      const name = String(s?.name || 'Hizmet');
      const price = s?.price != null ? `${s.price}₺` : '-';
      const dur = s?.duration != null ? `${s.duration} dk` : '-';
      return `• ${name} (${price}, ${dur})`;
    })
    .join('\n');
}

function staffToTextShort(staff: any[]) {
  if (!staff || staff.length === 0) return '';
  return staff.slice(0, 6).map((p: any) => `• ${String(p?.name || 'Personel')}`).join('\n');
}

function extractName(raw: string) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.length < 2) return null;
  if (/^\+?\d[\d\s-]+$/.test(s)) return null;

  const t = normalizeTr(s);
  const banned = [
    'fark etmez',
    'farketmez',
    'siz secin',
    'siz seçin',
    'herhangi',
    'kim olursa',
    'istemiyorum',
    'vazgectim',
    'vazgec',
'merhaba', 'selam', 'slm', 'sa', 'hey', 'günaydın', 'iyi akşamlar', 'iyi aksamlar', 'iyi geceler',
 'nasilsin', 'naber',  
  'iptal',
    'tamam',
    'evet',
    'hayir',
    'hayır',
  ];
  if (banned.some((b) => t === normalizeTr(b) || t.includes(normalizeTr(b)))) return null;

  const m = s.match(/^(ben\s+)?([a-zA-ZÇĞİÖŞÜçğıöşü\s]{2,})$/);
  if (!m) return null;
  const name = m[2].trim();
  if (name.length < 2) return null;
  return name;
}

function extractLikelyStaffName(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/([A-Za-zÇĞİÖŞÜçğıöşü']{2,})(?:['’]?(?:ten|tan|le|la)|\s+ile)\b/i);
  if (!m?.[1]) return null;
  const candidate = m[1].replace(/['’]$/, '').trim();
  if (!candidate) return null;
  if (candidate.length < 2) return null;
  return candidate;
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
  return { y: tr.getUTCFullYear(), m: tr.getUTCMonth() + 1, d: tr.getUTCDate(), hh: tr.getUTCHours(), mm: tr.getUTCMinutes() };
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
    const dUtc = new Date(Date.UTC(tomorrowTr.getUTCFullYear(), tomorrowTr.getUTCMonth(), tomorrowTr.getUTCDate(), WORK_START_HH - 3, 0, 0, 0));
    return [toIstanbulIso(dUtc)];
  }

  const suggestions: string[] = [];
  const startDayOffset = p.hh >= WORK_END_HH ? 1 : 0;

  let dayOffset = startDayOffset;
  while (suggestions.length < count && dayOffset < 14) {
    for (let hh = WORK_START_HH; hh < WORK_END_HH && suggestions.length < count; hh += 2) {
      const dUtc = new Date(Date.UTC(p.y, p.m - 1, p.d + dayOffset, hh - 3, 0, 0, 0));
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

function nextOccurrenceOfWeekday(nowTr: Date, targetDow: number): { year: number; month: number; day: number } {
  const todayDow = nowTr.getUTCDay();
  let delta = (targetDow - todayDow + 7) % 7;
  if (delta === 0) delta = 7;
  const target = addDaysMs(nowTr, delta);
  return { year: target.getUTCFullYear(), month: target.getUTCMonth(), day: target.getUTCDate() };
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
  const mMonth = t.match(/\b(\d{1,2})\s+(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/);

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

  // If no explicit time was found yet, try a loose parse for standalone numbers
  // Only attempt this when there is no explicit date and no recognised time
  if (!hasTime && !mNumeric && !mMonth && weekdayIdx == null && !hasTomorrow && !hasToday) {
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
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) matches.push({ hh, mm, idx: m.index });
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

function applyDayPeriod(t: string, hour12: number, minute: number): { hh: number; mm: number } {
  let hh = hour12;
  if (/\b(aksam|gece)\b/.test(t) && hh <= 11) hh += 12;
  else if (/\b(ogle|oglen)\b/.test(t) && hh <= 5) hh += 12;
  else if (!/\b(sabah|ogle|oglen|aksam|gece)\b/.test(t) && hh >= 1 && hh <= 7) hh += 12;
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
    case 'ocak': return 0;
    case 'subat': return 1;
    case 'mart': return 2;
    case 'nisan': return 3;
    case 'mayis': return 4;
    case 'haziran': return 5;
    case 'temmuz': return 6;
    case 'agustos': return 7;
    case 'eylul': return 8;
    case 'ekim': return 9;
    case 'kasim': return 10;
    case 'aralik': return 11;
    default: return 0;
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
  if (tNorm.includes('yarin') || tNorm.includes('bugun') || tNorm.includes('haftaya')) return true;
  if (/\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b/.test(tNorm)) return true;
  if (/\b(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/.test(tNorm)) return true;
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

  const dateAtUtcMidnight = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0));
  const timeHHMM = `${String(parts.hh).padStart(2, '0')}:${String(parts.mm).padStart(2, '0')}`;

  let endTimeHHMM: string | undefined = undefined;
  if (typeof durationMinutes === 'number' && durationMinutes > 0) {
    const startUtc = new Date(startAtIso);
    const endIso = toIstanbulIso(new Date(startUtc.getTime() + durationMinutes * 60000));
    const ep = getTrPartsFromIso(endIso);
    if (ep) endTimeHHMM = `${String(ep.hh).padStart(2, '0')}:${String(ep.mm).padStart(2, '0')}`;
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
