import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { VoiceAgentService } from '../agent/voice-agent.service';

type BridgeMeta = {
  tenantId: string;
  callId: string;
  from?: string;
  to?: string;
  streamSid?: string;
};

type BridgeInboundMessage =
  | {
      event: 'start';
      start: {
        callId: string;
        tenantId: string;
        from?: string;
        to?: string;
        streamSid?: string;
      };
    }
  | {
      event: 'media';
      media: {
        payload: string; // base64 g711 ulaw
      };
    }
  | { event: 'stop' }
  | { event: 'mark'; mark?: any }
  | { event: 'clear' };

type OpenAiEvent = {
  type: string;
  [key: string]: any;
};

type RecentEntityContext = {
  name: string;
  id?: string;
  source: 'user' | 'assistant';
  turnId: number;
  timestamp: number;
};

type RecentIntentContext = {
  intent: 'booking' | 'info' | 'staff_preference' | 'general';
  source: 'user' | 'assistant';
  turnId: number;
  timestamp: number;
};

type BookingDraftSnapshot = {
  serviceId?: string;
  serviceName?: string;
  staffId?: string;
  staffName?: string;
  customerName?: string;
  startAt?: string;
  state?: string;
  updatedAt: number;
};

type VoiceTimingStage =
  | 'websocket_connected'
  | 'openai_connected'
  | 'session_created'
  | 'session_updated'
  | 'first_greeting_started'
  | 'speech_started'
  | 'speech_stopped'
  | 'transcript_normalized'
  | 'agent_processing_start'
  | 'agent_reply_ready'
  | 'elevenlabs_request_start'
  | 'elevenlabs_first_byte'
  | 'elevenlabs_success'
  | 'final_audio_send_start'
  | 'tts_cache_hit'
  | 'tts_cache_miss'
  | 'deterministic_bypass'
  | 'bridge_context_loaded';

@Injectable()
export class RealtimeBridgeService {
  private readonly logger = new Logger(RealtimeBridgeService.name);
  static readonly openingGreeting =
    'Merhaba, ben güzellik merkezimizin sesli yapay zeka asistanıyım. Size nasıl yardımcı olabilirim?';
  static openingGreetingAudio: Buffer | null = null;
  static openingGreetingPromise: Promise<Buffer | null> | null = null;
  static readonly shortReplyAudioCache = new Map<string, Buffer>();

  constructor(private readonly agentService: VoiceAgentService) {
    void this.prewarmOpeningGreetingCache();
  }

  private async prewarmOpeningGreetingCache() {
    if (RealtimeBridgeService.openingGreetingAudio) {
      return;
    }

    if (RealtimeBridgeService.openingGreetingPromise) {
      await RealtimeBridgeService.openingGreetingPromise;
      return;
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) {
      this.logger.warn(
        '[voice] opening_greeting_prewarm_skipped missing_elevenlabs_config',
      );
      return;
    }

    this.logger.log('[voice] opening_greeting_prewarm_start');
    const promise = fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text: RealtimeBridgeService.openingGreeting,
          model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
          language_code: 'tr',
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.8,
            speed: 0.96,
          },
        }),
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          const bodyText = await response.text();
          throw new Error(
            `prewarm_failed status=${response.status} body=${bodyText}`,
          );
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        RealtimeBridgeService.openingGreetingAudio = audioBuffer;
        RealtimeBridgeService.shortReplyAudioCache.set(
          normalizeTtsCacheKey(RealtimeBridgeService.openingGreeting),
          audioBuffer,
        );
        this.logger.log(
          `[voice] opening_greeting_prewarm_success bytes=${audioBuffer.length}`,
        );
        return audioBuffer;
      })
      .catch((err: any) => {
        this.logger.warn(
          `[voice] opening_greeting_prewarm_failed error=${err?.message || err}`,
        );
        return null;
      })
      .finally(() => {
        RealtimeBridgeService.openingGreetingPromise = null;
      });

    RealtimeBridgeService.openingGreetingPromise = promise;
    await promise;
  }

  handleBridgeSocket(clientWs: WebSocket, meta: BridgeMeta) {
    const session = new VoiceBridgeSession(
      this.agentService,
      this.logger,
      clientWs,
      meta,
    );
    session.start();
  }

  handleTwilioWebSocket(ws: WebSocket, url: string) {
    const qs = new URL(url, 'http://localhost').searchParams;

    const tenantId =
      qs.get('tenantId') ||
      qs.get('customTenant') ||
      process.env.DEFAULT_TENANT_ID ||
      'cmkeas8p500056hpg59gmkquc';

    const callId =
      qs.get('callId') || qs.get('streamSid') || `ws-${Date.now()}`;
    const from = qs.get('from') || undefined;
    const to = qs.get('to') || undefined;
    const streamSid = qs.get('streamSid') || callId;

    this.logger.log(
      `[voice] compat handleTwilioWebSocket tenantId=${tenantId} callId=${callId}`,
    );

    return this.handleBridgeSocket(ws, {
      tenantId,
      callId,
      from,
      to,
      streamSid,
    });
  }
}

class VoiceBridgeSession {
  private readonly openaiUrl: string;
  private openaiWs: WebSocket | null = null;
  private closed = false;

  private sessionReady = false;
  private greeted = false;
  private bridgeReady = false;
  private greetingInFlight = false;
  private turnSequence = 0;
  private activeTurnId = 0;

  private lastAssistantAudioAt = 0;
  private assistantSpeaking = false;
  private assistantStartedAt = 0;
  private activeResponse = false;

  private speechEnergyFrames = 0;
  private lastObservedSpeechEnergy = 0;
  private readonly speechEnergyThreshold = 900;
  private readonly speechFramesForBargeIn = 3;
  private readonly assistantGuardMs = 400;
  private readonly openingGreetingBargeInGuardMs = 500;

  private lastTranscriptAt = 0;
  private lastTranscriptText = '';
  private lastTranscriptNorm = '';
  private pendingTranscriptText = '';
  private pendingTranscriptTimer: NodeJS.Timeout | null = null;
  private pendingTranscriptState: string | null = null;
  private agentTurnInFlight = false;
  private queuedTranscript: { text: string; state: string | null } | null =
    null;
  private lastBotReplyText = '';
  private lastBargeInAt = 0;
  private lastSpeechStoppedAt = 0;

  private playbackToken = 0;
  private playbackTimer: NodeJS.Timeout | null = null;
  private currentTtsAbort: AbortController | null = null;
  private currentPlaybackDurationMs = 0;
  private currentPlaybackOffsetBytes = 0;
  private currentReplyTurnId = 0;
  private hasIntroducedSelf = false;
  private recentServiceContext: RecentEntityContext | null = null;
  private recentStaffContext: RecentEntityContext | null = null;
  private recentIntentContext: RecentIntentContext | null = null;
  private bookingDraftSnapshot: BookingDraftSnapshot | null = null;
  private cachedServices: any[] | null = null;
  private lastGreetingSuppressedAt = 0;
  private lastOpeningGreetingIgnoreLogAt = 0;
  private lastBargeInSuppressLogAt = 0;
  private lastBargeInSuppressReason = '';
  private lastCancellationReason: 'real_barge_in' | 'new_reply' | 'close' | null = null;

  // 20ms @ 8kHz μ-law = 160 bytes
  private readonly ulawFrameBytes = 160;
  private readonly ulawFrameMs = 20;
  private readonly realtimeTtsStreamingEnabled =
    String(process.env.VOICE_TTS_STREAMING_ENABLED || 'true').toLowerCase() !==
    'false';

  private readonly ghostRegex =
    /^(ad[ií]os|bye|bye-bye|thank you|thank you very much|all y['’]all|hallo|hello)\.?$/i;
  private readonly sessionStartedAt = Date.now();
  private readonly timings: Partial<Record<VoiceTimingStage, number>> = {};
  private openingGreetingProtectionUntil = 0;
  private assistantPlaybackProtectionUntil = 0;

  constructor(
    private readonly agentService: VoiceAgentService,
    private readonly parentLogger: Logger,
    private readonly clientWs: WebSocket,
    private readonly meta: BridgeMeta,
  ) {
    const model =
      process.env.JARVIS_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    this.openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  }

  start() {
    this.markTiming('websocket_connected');

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.parentLogger.error('[voice] OPENAI_API_KEY missing');
      this.safeClose();
      return;
    }

    this.openaiWs = new WebSocket(this.openaiUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.openaiWs.on('open', () => {
      this.markTiming('openai_connected');
      this.parentLogger.log(
        `[voice] OpenAI realtime connected callId=${this.meta.callId}`,
      );
      this.configureOpenAiSession();
    });

    this.openaiWs.on('message', async (buf) => {
      try {
        const evt = JSON.parse(buf.toString()) as OpenAiEvent;
        await this.onOpenAiEvent(evt);
      } catch (err: any) {
        this.parentLogger.error(
          `[voice] OpenAI event parse error callId=${this.meta.callId}: ${err?.message || err}`,
        );
      }
    });

    this.openaiWs.on('close', () => {
      this.parentLogger.warn(
        `[voice] OpenAI WS closed callId=${this.meta.callId}`,
      );
      this.safeClose();
    });

    this.openaiWs.on('error', (err) => {
      this.parentLogger.error(
        `[voice] OpenAI WS error callId=${this.meta.callId}: ${String(err)}`,
      );
    });

    this.clientWs.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as BridgeInboundMessage;
        await this.onBridgeMessage(msg);
      } catch (err: any) {
        this.parentLogger.error(
          `[voice] bridge message parse error callId=${this.meta.callId}: ${err?.message || err}`,
        );
      }
    });

    this.clientWs.on('close', () => {
      this.parentLogger.warn(
        `[voice] bridge WS closed callId=${this.meta.callId}`,
      );
      this.safeClose();
    });

    this.clientWs.on('error', (err) => {
      this.parentLogger.error(
        `[voice] bridge WS error callId=${this.meta.callId}: ${String(err)}`,
      );
    });
  }

  private configureOpenAiSession() {
    this.sendOpenAi({
      type: 'session.update',
      session: {
        instructions: [
          'You are the voice layer for a premium Turkish beauty center assistant.',
          'You do not decide business logic.',
          'You only speak the exact approved reply text provided by the app.',
          'Speak in Turkish unless the caller clearly speaks another language.',
          'Speak naturally, calmly, warmly, professionally, and slightly slower than default phone assistants.',
          'Keep sentences very short.',
          'Do not add extra filler.',
          'Do not invent bookings, confirmations, prices, or availability.',
          'Never read emojis, markdown, symbols, or decorative characters.',
        ].join(' '),

        modalities: ['audio', 'text'],
        voice: process.env.JARVIS_REALTIME_VOICE || 'cedar',

        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',

        input_audio_transcription: {
          model: process.env.JARVIS_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
          language: 'tr',
          prompt:
            'Bu bir Türkiye telefon görüşmesi. Güzellik merkezi, randevu, rezervasyon, lazer epilasyon, cilt bakımı, protez tırnak, saç, kaş, kirpik, tarih, saat, personel gibi kelimeler beklenir. Türkçe özel isimleri doğru yaz. Kısa isimleri ve personel isimlerini mümkün olduğunca doğru yaz.',
        },

        turn_detection: {
          type: 'server_vad',
          create_response: false,
          interrupt_response: false,
          threshold: 0.58,
          prefix_padding_ms: 120,
          silence_duration_ms: 140,
        },
      },
    });
  }

  private async onBridgeMessage(msg: BridgeInboundMessage) {
    if (
      this.closed ||
      !this.openaiWs ||
      this.openaiWs.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (msg.event === 'start') {
      this.bridgeReady = true;
      this.parentLogger.log(
        `[voice] bridge start callId=${this.meta.callId} tenantId=${this.meta.tenantId}`,
      );
      this.maybeStartOpeningGreeting();
      return;
    }

    if (msg.event === 'stop') {
      this.parentLogger.log(`[voice] bridge stop callId=${this.meta.callId}`);
      this.safeClose();
      return;
    }

    if (msg.event === 'clear') {
      this.parentLogger.log(`[voice] bridge clear callId=${this.meta.callId}`);
      return;
    }

    if (msg.event === 'media') {
      const payload = msg.media?.payload;
      if (!payload) return;

      this.handlePossibleBargeIn(payload);

      if (
        this.assistantSpeaking &&
        !this.shouldPassInboundDuringAssistant(payload)
      ) {
        return;
      }

      this.sendOpenAi({
        type: 'input_audio_buffer.append',
        audio: payload,
      });
    }
  }

  private async onOpenAiEvent(evt: OpenAiEvent) {
    switch (evt.type) {
      case 'session.created':
        this.markTiming('session_created');
        this.parentLogger.log(
          `[voice] session.created callId=${this.meta.callId}`,
        );
        return;

      case 'session.updated':
        this.sessionReady = true;
        this.markTiming('session_updated');
        this.parentLogger.log(
          `[voice] session.updated callId=${this.meta.callId}`,
        );
        this.parentLogger.log(
          `[voice] opening_greeting_queued callId=${this.meta.callId} sessionReady=${this.sessionReady} bridgeReady=${this.bridgeReady}`,
        );
        this.maybeStartOpeningGreeting();
        return;

      case 'response.created':
        this.assistantSpeaking = true;
        this.activeResponse = true;
        this.assistantStartedAt = Date.now();
        this.parentLogger.log(
          `[voice] response.created callId=${this.meta.callId}`,
        );
        return;

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (!evt.delta) return;

        this.lastAssistantAudioAt = Date.now();
        this.assistantSpeaking = true;

        // This path is only used when ElevenLabs fails and OpenAI TTS fallback is active.
        this.sendBridge({
          event: 'media',
          media: { payload: evt.delta },
        });
        return;

      case 'response.output_audio.done':
      case 'response.audio.done':
      case 'response.done':
        this.assistantSpeaking = false;
        this.activeResponse = false;
        this.parentLogger.log(`[voice] ${evt.type} callId=${this.meta.callId}`);
        return;

      case 'conversation.item.input_audio_transcription.completed': {
        const rawTranscript = String(evt.transcript || '').trim();
        if (!rawTranscript) return;
        await this.handleCompletedTranscript(rawTranscript);
        return;
      }

      case 'input_audio_buffer.speech_started':
        this.markTiming('speech_started');
        this.parentLogger.log(
          `[voice] speech_started callId=${this.meta.callId}`,
        );
        const protectionRemaining = this.getAssistantProtectionMsRemaining();
        if (protectionRemaining > 0) {
          this.logBargeInSuppressed(
            'inside_protection_window',
            `protectionMsRemaining=${protectionRemaining}`,
          );
          return;
        }
        if (this.assistantSpeaking) {
          this.logBargeInSuppressed(
            'playback_guard',
            `event=speech_started speechFrames=${this.speechEnergyFrames} rms=${this.lastObservedSpeechEnergy.toFixed(0)}`,
          );
        }
        return;

      case 'input_audio_buffer.speech_stopped':
        this.lastSpeechStoppedAt = Date.now();
        this.markTiming('speech_stopped');
        this.parentLogger.log(
          `[voice] speech_stopped callId=${this.meta.callId}`,
        );
        return;

      case 'error': {
        const code = String(evt?.error?.code || '');
        if (code === 'response_cancel_not_active') return;
        this.parentLogger.error(
          `[voice] OpenAI error callId=${this.meta.callId}: ${JSON.stringify(
            evt.error || evt,
          )}`,
        );
        return;
      }

      default:
        return;
    }
  }

  private async handleCompletedTranscript(rawTranscript: string) {
    const currentState = this.getCurrentVoiceBookingState();

    if (this.shouldDropTranscript(rawTranscript, currentState)) {
      this.parentLogger.warn(
        `[voice] dropped transcript callId=${this.meta.callId} state=${currentState || '-'} text="${rawTranscript}"`,
      );
      return;
    }

    const transcript = normalizeTranscriptForAgent(
      rawTranscript,
      this.lastBotReplyText,
    );
    if (!transcript) {
      this.parentLogger.warn(
        `[voice] normalized transcript empty after contamination filter callId=${this.meta.callId} raw="${rawTranscript}"`,
      );
      return;
    }

    const merged = mergeVoiceFragments(
      this.pendingTranscriptText,
      transcript,
      currentState,
    );

    if (shouldBufferShortVoiceTranscript(currentState, merged)) {
      this.pendingTranscriptText = merged;
      this.pendingTranscriptState = currentState;
      if (this.pendingTranscriptTimer)
        clearTimeout(this.pendingTranscriptTimer);
      this.pendingTranscriptTimer = setTimeout(() => {
        const buffered = this.pendingTranscriptText;
        const bufferedState = this.pendingTranscriptState;
        this.pendingTranscriptText = '';
        this.pendingTranscriptState = null;
        this.pendingTranscriptTimer = null;
        void this.enqueueOrProcessTranscript(buffered, bufferedState);
      }, 420);
      this.parentLogger.log(
        `[voice] transcript_buffered callId=${this.meta.callId} state=${currentState || '-'} text="${merged}"`,
      );
      return;
    }

    if (this.pendingTranscriptTimer) {
      clearTimeout(this.pendingTranscriptTimer);
      this.pendingTranscriptTimer = null;
    }
    this.pendingTranscriptText = '';
    this.pendingTranscriptState = null;
    await this.enqueueOrProcessTranscript(merged, currentState);
  }

  private async enqueueOrProcessTranscript(
    transcript: string,
    state: string | null,
  ) {
    if (this.agentTurnInFlight) {
      this.activeTurnId = this.turnSequence + 1;
      this.queuedTranscript = { text: transcript, state };
      this.parentLogger.log(
        `[voice] transcript_queued_latest callId=${this.meta.callId} state=${state || '-'} text="${transcript}"`,
      );
      return;
    }
    await this.processTranscriptTurn(transcript, state);
  }

  private async processTranscriptTurn(
    transcript: string,
    state: string | null,
  ) {
    const norm = normalizeTurkishForTime(transcript);
    if (!norm || norm === this.lastTranscriptNorm) {
      this.parentLogger.warn(
        `[voice] duplicate transcript callId=${this.meta.callId} text="${transcript}"`,
      );
      return;
    }

    this.lastTranscriptAt = Date.now();
    this.lastTranscriptText = transcript;
    this.lastTranscriptNorm = norm;
    const turnId = ++this.turnSequence;
    this.activeTurnId = turnId;
    this.agentTurnInFlight = true;
    this.captureRecentContextsFromText(transcript, turnId, 'user');
    this.markTiming('transcript_normalized', {
      turnId,
      state: state || '-',
      normalizedLength: transcript.length,
    });

    this.parentLogger.log(
      `[voice] transcript normalized callId=${this.meta.callId} turnId=${turnId} state=${state || '-'} normalized="${transcript}"`,
    );

    try {
      const reply = await this.callAgentBrain(transcript, turnId);
      if (!reply) return;
      if (!this.isTurnStillActive(turnId)) {
        this.parentLogger.warn(
          `[voice] stale_turn_discarded callId=${this.meta.callId} replyTurnId=${turnId} activeTurnId=${this.activeTurnId} stage=agent_reply`,
        );
        return;
      }

      await this.speakReply(reply, turnId);
    } finally {
      this.agentTurnInFlight = false;
      if (this.queuedTranscript) {
        const queued = this.queuedTranscript;
        this.queuedTranscript = null;
        await this.processTranscriptTurn(queued.text, queued.state);
      }
    }
  }

  private getCurrentVoiceBookingState(): string | null {
    const bookingCore = (this.agentService as any)?.bookingCore as any;
    const sessions = bookingCore?.sessions as Map<string, any> | undefined;
    if (!sessions?.get) return null;
    const customerPhone = normalizePhone(
      this.meta.from ||
        this.meta.streamSid ||
        this.meta.callId ||
        'voice-caller',
    );
    const session = sessions.get(`${this.meta.tenantId}:${customerPhone}`);
    return session?.state ? String(session.state) : null;
  }

  private shouldDropTranscript(text: string, state?: string | null) {
    const normalized = text.trim();
    const normalizedTranscript = normalizeVoiceComparisonText(normalized);

    if (!normalized) return true;
    if (normalized.length <= 1 && !isCriticalVoiceState(state)) return true;
    if (this.ghostRegex.test(normalized)) return true;

    const preservePartialBooking =
      this.isMeaningfulPartialBookingTranscript(normalized);
    if (preservePartialBooking) {
      this.parentLogger.log(
        `[voice] partial_booking_transcript_preserved callId=${this.meta.callId} text="${normalized}"`,
      );
    }

    const now = Date.now();
    const msSinceAssistantAudio = now - this.lastAssistantAudioAt;
    const msSinceBargeIn = now - this.lastBargeInAt;
    const msSinceSpeechStopped = now - this.lastSpeechStoppedAt;

    if (
      !preservePartialBooking &&
      !isCriticalVoiceState(state) &&
      msSinceBargeIn < 180 &&
      normalized.length < 18
    )
      return true;
    if (
      !preservePartialBooking &&
      !isCriticalVoiceState(state) &&
      msSinceSpeechStopped > 0 &&
      msSinceSpeechStopped < 120 &&
      normalized.length < 3
    )
      return true;

    if (
      !preservePartialBooking &&
      !isCriticalVoiceState(state) &&
      msSinceAssistantAudio < 280 &&
      normalized.length < 16
    ) {
      return true;
    }

    if (
      normalized.toLowerCase() === this.lastTranscriptText.toLowerCase() &&
      now - this.lastTranscriptAt < 1400
    ) {
      return true;
    }

    const assistantEchoSimilarity = Math.max(
      similarityScore(
        normalizedTranscript,
        normalizeVoiceComparisonText(this.lastBotReplyText),
      ),
      similarityScore(
        normalizedTranscript,
        normalizeVoiceComparisonText(RealtimeBridgeService.openingGreeting),
      ),
    );
    if (
      !preservePartialBooking &&
      assistantEchoSimilarity >= 0.92 &&
      normalizedTranscript.length >= 8
    ) {
      this.parentLogger.warn(
        `[voice] assistant_echo_suppressed callId=${this.meta.callId} similarity=${assistantEchoSimilarity.toFixed(2)} text="${normalized}"`,
      );
      return true;
    }

    return false;
  }

  private handlePossibleBargeIn(payloadB64: string) {
    if (!this.assistantSpeaking) {
      this.openingGreetingProtectionUntil = 0;
      this.assistantPlaybackProtectionUntil = 0;
      this.speechEnergyFrames = 0;
      this.lastObservedSpeechEnergy = 0;
      return;
    }

    const now = Date.now();
    if (now - this.assistantStartedAt < this.assistantGuardMs) {
      this.logBargeInSuppressed(
        'playback_guard',
        `elapsed=${now - this.assistantStartedAt}`,
      );
      this.speechEnergyFrames = 0;
      return;
    }

    const protectionRemaining = this.getAssistantProtectionMsRemaining();
    if (protectionRemaining > 0) {
      this.logBargeInSuppressed(
        'inside_protection_window',
        `protectionMsRemaining=${protectionRemaining}`,
      );
      this.speechEnergyFrames = 0;
      return;
    }

    const rms = pcmuBase64Rms(payloadB64);
    this.lastObservedSpeechEnergy = rms;

    if (rms >= this.speechEnergyThreshold) {
      this.speechEnergyFrames += 1;
    } else {
      if (rms > 0) {
        this.logBargeInSuppressed(
          'below_threshold',
          `rms=${rms.toFixed(0)} threshold=${this.speechEnergyThreshold}`,
        );
      }
      this.speechEnergyFrames = 0;
      return;
    }

    if (this.speechEnergyFrames < this.speechFramesForBargeIn) {
      this.logBargeInSuppressed(
        'too_short',
        `frames=${this.speechEnergyFrames}/${this.speechFramesForBargeIn} rms=${rms.toFixed(0)}`,
      );
      return;
    }

    if (now - this.lastAssistantAudioAt < 240) {
      this.logBargeInSuppressed(
        'probable_echo',
        `sinceAssistantAudio=${now - this.lastAssistantAudioAt} rms=${rms.toFixed(0)}`,
      );
      this.speechEnergyFrames = 0;
      return;
    }

    if (this.speechEnergyFrames >= this.speechFramesForBargeIn) {
      this.parentLogger.warn(
        `[voice] barge_in_detected callId=${this.meta.callId} rms=${rms.toFixed(0)} frames=${this.speechEnergyFrames}`,
      );
      this.lastBargeInAt = Date.now();
      this.cancelAssistantAudio('barge_in');
      this.speechEnergyFrames = 0;
    }
  }

  private shouldPassInboundDuringAssistant(payloadB64: string) {
    const protectionRemaining = this.getAssistantProtectionMsRemaining();
    if (protectionRemaining > 0) {
      this.logBargeInSuppressed(
        'inside_protection_window',
        `protectionMsRemaining=${protectionRemaining}`,
      );
      return false;
    }

    const rms = pcmuBase64Rms(payloadB64);
    this.lastObservedSpeechEnergy = rms;
    if (rms < this.speechEnergyThreshold) {
      this.logBargeInSuppressed(
        'below_threshold',
        `rms=${rms.toFixed(0)} threshold=${this.speechEnergyThreshold}`,
      );
      return false;
    }
    return rms >= this.speechEnergyThreshold;
  }

  private maybeStartOpeningGreeting() {
    if (!this.sessionReady || this.hasIntroducedSelf || this.greetingInFlight) {
      return;
    }

    this.greeted = true;
    this.hasIntroducedSelf = true;
    this.greetingInFlight = true;

    const openingGreeting = RealtimeBridgeService.openingGreeting;
    this.markTiming('first_greeting_started', {
      textLength: openingGreeting.length,
    });
    this.parentLogger.log(
      `[voice] opening_greeting_started callId=${this.meta.callId} text="${openingGreeting}"`,
    );

    void this.speakReply(openingGreeting).finally(() => {
      this.greetingInFlight = false;
    });
  }

  private markTiming(
    stage: VoiceTimingStage,
    extra: Record<string, unknown> = {},
  ) {
    const now = Date.now();
    const prev = this.timings[stage];
    this.timings[stage] = now;

    const sinceSessionStart = now - this.sessionStartedAt;
    const sincePrevSameStage = prev ? now - prev : 0;
    const sinceSpeechStopped = this.lastSpeechStoppedAt
      ? now - this.lastSpeechStoppedAt
      : undefined;

    this.parentLogger.log(
      `[voice][timing] stage=${stage} callId=${this.meta.callId} t=${sinceSessionStart}ms delta=${sincePrevSameStage}ms${sinceSpeechStopped != null ? ` sinceSpeechStopped=${sinceSpeechStopped}ms` : ''}${serializeTimingExtras(extra)}`,
    );
  }

  private isTurnStillActive(turnId?: number) {
    if (!turnId) return true;
    return turnId === this.activeTurnId;
  }

  private getAssistantProtectionMsRemaining() {
    const now = Date.now();
    const protectionUntil = Math.max(
      this.assistantPlaybackProtectionUntil,
      this.lastBotReplyText === RealtimeBridgeService.openingGreeting
        ? this.openingGreetingProtectionUntil
        : 0,
    );
    return protectionUntil > now ? protectionUntil - now : 0;
  }

  private logOpeningGreetingIgnore(protectionMsRemaining: number) {
    const now = Date.now();
    if (now - this.lastOpeningGreetingIgnoreLogAt < 1200) return;
    this.lastOpeningGreetingIgnoreLogAt = now;
    this.parentLogger.log(
      `[voice] opening_greeting_barge_in_ignored callId=${this.meta.callId} protectionMsRemaining=${protectionMsRemaining}`,
    );
  }

  private logBargeInSuppressed(reason: string, detail?: string) {
    const now = Date.now();
    if (
      reason === 'inside_protection_window' &&
      this.lastBotReplyText === RealtimeBridgeService.openingGreeting
    ) {
      this.logOpeningGreetingIgnore(this.getAssistantProtectionMsRemaining());
    }
    if (
      now - this.lastBargeInSuppressLogAt < 900 &&
      this.lastBargeInSuppressReason === reason
    ) {
      return;
    }
    this.lastBargeInSuppressLogAt = now;
    this.lastBargeInSuppressReason = reason;
    this.parentLogger.log(
      `[voice] barge_in_suppressed callId=${this.meta.callId} reason=${reason}${detail ? ` ${detail}` : ''}`,
    );
  }

  private isMeaningfulPartialBookingTranscript(text: string) {
    const t = normalizeTurkishForTime(text);
    if (!t) return false;
    const patterns = [
      /\byarin\b.*\b(saat|sabah|ogle|ogleden sonra|aksam|gece)\b/,
      /\bbugun\b.*\b(saat|sabah|ogle|ogleden sonra|aksam|gece)\b/,
      /\b\d{1,2}([:.]\d{2})?\b\s*(gibi|olur mu|uygun mu)?$/,
      /\b(uc|dort|bes|alti|yedi|sekiz|dokuz|on|on bir|on iki)\b\s*(gibi|bucuk|ceyrek|olur mu)?$/,
      /\b(randevu almak|rezervasyon icin|rezervasyon yapmak|gelebilir miyim)\b/,
      /\b(lazer epilasyon|protez tirnak|cilt bakimi|kas|kirpik|sac)\b.*\bicin\b/,
      /\b(ogleden sonra|aksam uzeri|sabah)\b/,
    ];
    return patterns.some((pattern) => pattern.test(t));
  }

  private async buildAgentInputWithVoiceContext(
    userText: string,
    turnId: number,
  ) {
    const explicitService = await this.detectServiceMention(userText);
    const explicitStaff = await this.detectStaffMention(userText);
    const hasBookingIntent = this.hasBookingIntentCue(userText);
    const hints: string[] = [];

    if (
      hasBookingIntent &&
      !explicitService &&
      this.isRecentServiceContextStrong(turnId) &&
      this.recentServiceContext
    ) {
      hints.push(
        `Az önce konuşulan hizmet: ${this.recentServiceContext.name}. Kullanıcı yeni hizmet belirtmediyse booking akışını bu hizmetle sürdür.`,
      );
      this.parentLogger.log(
        `[voice] recent_service_context_reused callId=${this.meta.callId} turnId=${turnId} service=${JSON.stringify(this.recentServiceContext.name)}`,
      );
    }

    if (
      !explicitStaff &&
      this.recentStaffContext &&
      this.isRecentEntityContextStrong(this.recentStaffContext, turnId) &&
      /(o olsun|onunla|kendisiyle|ayni kisi|aynı kişi|ayni personel|aynı personel)/i.test(
        userText,
      )
    ) {
      hints.push(
        `Az önce konuşulan personel: ${this.recentStaffContext.name}. Kullanıcı başka bir personel söylemediyse staff tercihi olarak bunu kullan.`,
      );
    }

    if (this.bookingDraftSnapshot && hasBookingIntent) {
      const snap = this.bookingDraftSnapshot;
      const parts = [
        snap.serviceName ? `service=${snap.serviceName}` : '',
        snap.staffName ? `staff=${snap.staffName}` : '',
        snap.startAt ? `startAt=${snap.startAt}` : '',
        snap.state ? `state=${snap.state}` : '',
      ].filter(Boolean);
      if (parts.length) {
        hints.push(
          `Mevcut booking taslağı: ${parts.join(', ')}. Alakasız kısa input gelirse akışı bozma, taslağı koru.`,
        );
      }
    }

    if (this.recentIntentContext && this.isRecentIntentContextStrong(turnId)) {
      hints.push(`Yakın intent bağlamı: ${this.recentIntentContext.intent}.`);
    }

    if (!hints.length) return userText;
    return `${userText}

[voice_context: ${hints.join(' ')}]`;
  }

  private isRecentServiceContextStrong(turnId: number) {
    return this.recentServiceContext
      ? this.isRecentEntityContextStrong(this.recentServiceContext, turnId)
      : false;
  }

  private isRecentEntityContextStrong(
    context: RecentEntityContext,
    turnId: number,
  ) {
    const withinTurns = turnId - context.turnId <= 6;
    const withinMs = Date.now() - context.timestamp <= 240000;
    return withinTurns && withinMs;
  }

  private isRecentIntentContextStrong(turnId: number) {
    if (!this.recentIntentContext) return false;
    const withinTurns = turnId - this.recentIntentContext.turnId <= 6;
    const withinMs = Date.now() - this.recentIntentContext.timestamp <= 240000;
    return withinTurns && withinMs;
  }

  private hasBookingIntentCue(text: string) {
    const t = normalizeTurkishForTime(text);
    return /(randevu|rezervasyon|gelebilir miyim|uygun musunuz|uygun mu|buna randevu|bunu yaptiralim|bunu yaptiralim|olur mu)/.test(
      t,
    );
  }

  private async detectServiceMention(text: string) {
    const services = await this.getServicesForVoiceContext();
    if (!services.length) return null;
    const bookingCore = (this.agentService as any)?.bookingCore as any;
    const detector = bookingCore?.detectServiceFromMessage;
    if (typeof detector === 'function') {
      try {
        return detector.call(bookingCore, text, services);
      } catch {}
    }

    const t = normalizeTurkishForTime(text);
    return (
      services.find((service: any) => {
        const name = normalizeTurkishForTime(String(service?.name || ''));
        return name && (t.includes(name) || name.includes(t));
      }) || null
    );
  }

  private async detectStaffMention(text: string) {
    const bookingCore = (this.agentService as any)?.bookingCore as any;
    const listStaff = bookingCore?.safeListStaff;
    if (typeof listStaff !== 'function') return null;
    try {
      const staff = await listStaff.call(bookingCore, this.meta.tenantId);
      const t = normalizeTurkishForTime(text);
      const exact = staff.find((item: any) => {
        const name = normalizeTurkishForTime(String(item?.name || ''));
        return name && (t === name || t.includes(name) || name.includes(t));
      });
      if (exact) return exact;
      const words = t.split(/\s+/).filter((word) => word.length >= 3);
      return (
        staff.find((item: any) => {
          const name = normalizeTurkishForTime(String(item?.name || ''));
          return words.some((word) => name.includes(word));
        }) || null
      );
    } catch {
      return null;
    }
  }

  private syncMemoryFromBookingSession(customerPhone: string) {
    const bookingCore = (this.agentService as any)?.bookingCore as any;
    const sessions = bookingCore?.sessions as Map<string, any> | undefined;
    if (!sessions || typeof sessions.get !== 'function') return;
    const key = `${this.meta.tenantId}:${customerPhone}`;
    const session = sessions.get(key);
    if (!session?.draft) return;

    this.bookingDraftSnapshot = {
      serviceId: session.draft.serviceId
        ? String(session.draft.serviceId)
        : undefined,
      serviceName:
        session.lastBookingContext?.serviceName ||
        this.recentServiceContext?.name,
      staffId: session.draft.staffId
        ? String(session.draft.staffId)
        : undefined,
      staffName:
        session.lastBookingContext?.staffName ||
        this.recentStaffContext?.name ||
        session.draft.requestedStaffName,
      customerName: session.draft.customerName
        ? String(session.draft.customerName)
        : undefined,
      startAt: session.draft.startAt
        ? String(session.draft.startAt)
        : undefined,
      state: session.state ? String(session.state) : undefined,
      updatedAt: Date.now(),
    };
  }

  private async getServicesForVoiceContext() {
    if (this.cachedServices) return this.cachedServices;
    const bookingCore = (this.agentService as any)?.bookingCore as any;
    const listServices = bookingCore?.safeListServices;
    if (typeof listServices !== 'function') return [];
    try {
      const services = await listServices.call(bookingCore, this.meta.tenantId);
      this.cachedServices = Array.isArray(services) ? services : [];
    } catch {
      this.cachedServices = [];
    }
    return this.cachedServices;
  }

  private captureRecentContextsFromText(
    text: string,
    turnId: number,
    source: 'user' | 'assistant',
  ) {
    this.captureRecentIntentContext(text, turnId, source);

    void this.detectServiceMention(text).then((service) => {
      if (!service?.name) return;
      this.recentServiceContext = {
        name: String(service.name),
        id: service?.id ? String(service.id) : undefined,
        source,
        turnId,
        timestamp: Date.now(),
      };
      this.parentLogger.log(
        `[voice] recent_service_context_set callId=${this.meta.callId} turnId=${turnId} source=${source} service=${JSON.stringify(this.recentServiceContext.name)}`,
      );
    });

    void this.detectStaffMention(text).then((staff) => {
      if (!staff?.name) return;
      this.recentStaffContext = {
        name: String(staff.name),
        id: staff?.id ? String(staff.id) : undefined,
        source,
        turnId,
        timestamp: Date.now(),
      };
      this.parentLogger.log(
        `[voice] recent_staff_context_set callId=${this.meta.callId} turnId=${turnId} source=${source} staff=${JSON.stringify(this.recentStaffContext.name)}`,
      );
    });
  }

  private captureRecentIntentContext(
    text: string,
    turnId: number,
    source: 'user' | 'assistant',
  ) {
    const intent = detectRecentIntent(text);
    if (!intent) return;
    this.recentIntentContext = {
      intent,
      source,
      turnId,
      timestamp: Date.now(),
    };
  }

  private cancelAssistantAudio(
    reason: 'barge_in' | 'new_reply' | 'close' = 'new_reply',
  ) {
    this.playbackToken += 1;

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    if (this.currentTtsAbort) {
      try {
        this.currentTtsAbort.abort();
      } catch {}
      this.currentTtsAbort = null;
    }

    this.sendBridge({ event: 'clear' });

    this.lastCancellationReason =
      reason === 'barge_in' ? 'real_barge_in' : reason;
    this.parentLogger.warn(
      `[voice] cancellation_applied callId=${this.meta.callId} reason=${this.lastCancellationReason}`,
    );

    if (this.activeResponse) {
      this.sendOpenAi({ type: 'response.cancel' });
      this.parentLogger.warn(
        `[voice] response cancelled callId=${this.meta.callId} reason=${reason}`,
      );
    }

    this.parentLogger.log(
      `[voice] assistant output cleared callId=${this.meta.callId} reason=${reason}`,
    );

    this.assistantSpeaking = false;
    this.activeResponse = false;
    this.currentPlaybackDurationMs = 0;
    this.currentPlaybackOffsetBytes = 0;
    this.assistantPlaybackProtectionUntil = 0;
    this.openingGreetingProtectionUntil = 0;
    this.lastObservedSpeechEnergy = 0;
  }

  private async callAgentBrain(
    userText: string,
    turnId?: number,
  ): Promise<string> {
    const effectiveTurnId = turnId ?? this.activeTurnId;
    const effectiveUserText = await this.buildAgentInputWithVoiceContext(
      userText,
      effectiveTurnId,
    );

    this.markTiming('agent_processing_start', {
      turnId: effectiveTurnId,
      inputLength: effectiveUserText.length,
    });

    const deterministicReply = this.buildDeterministicShortReply(userText);
    if (deterministicReply) {
      if (
        this.greeted &&
        (deterministicReply.key === 'greeting' ||
          deterministicReply.key === 'voice_check') &&
        Date.now() - this.lastGreetingSuppressedAt > 1200
      ) {
        this.lastGreetingSuppressedAt = Date.now();
        this.parentLogger.log(
          `[voice] greeting_repeat_suppressed callId=${this.meta.callId} key=${deterministicReply.key}`,
        );
      }
      this.parentLogger.log(
        `[voice] deterministic_bypass_triggered callId=${this.meta.callId} key=${JSON.stringify(deterministicReply.key)} text="${deterministicReply.reply}"`,
      );
      this.markTiming('deterministic_bypass', {
        turnId,
        key: deterministicReply.key,
        replyLength: deterministicReply.reply.length,
      });
      this.markTiming('agent_reply_ready', {
        turnId,
        source: 'deterministic_bypass',
        replyLength: deterministicReply.reply.length,
      });
      this.logTurnLatency('agent_reply_ready', turnId, {
        source: 'deterministic_bypass',
        replyLength: deterministicReply.reply.length,
      });
      return deterministicReply.reply;
    }

    const customerPhone = normalizePhone(
      this.meta.from ||
        this.meta.streamSid ||
        this.meta.callId ||
        'voice-caller',
    );

    const payload = {
      tenantId: this.meta.tenantId,
      customerPhone,
      text: effectiveUserText,
      channel: 'voice',
      from: this.meta.from,
      to: this.meta.to,
      callId: this.meta.callId,
      streamSid: this.meta.streamSid,
      source: 'voice',
    };

    try {
      const svc: any = this.agentService as any;

      let result: any = null;

      if (typeof svc.handleIncomingMessage === 'function') {
        result = await svc.handleIncomingMessage(payload);
      } else if (typeof svc.processIncomingMessage === 'function') {
        result = await svc.processIncomingMessage(payload);
      } else if (typeof svc.processMessage === 'function') {
        result = await svc.processMessage(payload);
      } else if (typeof svc.replyText === 'function') {
        result = await svc.replyText(payload);
      } else {
        throw new Error(
          'VoiceAgentService üzerinde kullanılabilir bir public entrypoint bulunamadı',
        );
      }

      const reply = extractReplyText(result);
      this.syncMemoryFromBookingSession(customerPhone);

      this.parentLogger.log(
        `[voice] agent reply callId=${this.meta.callId} customerPhone=${customerPhone} reply="${reply}"`,
      );
      this.markTiming('agent_reply_ready', {
        turnId,
        source: 'agent',
        replyLength: reply.length,
      });
      this.logTurnLatency('agent_reply_ready', turnId, {
        replyLength: reply.length,
      });

      return (
        reply ||
        'Üzgünüm, şu an uygun bir yanıt oluşturamadım. Tekrar söyler misiniz?'
      );
    } catch (err: any) {
      this.parentLogger.error(
        `[voice] VoiceAgentService error callId=${this.meta.callId}: ${
          err?.stack || err?.message || err
        }`,
      );
      this.markTiming('agent_reply_ready', {
        turnId,
        source: 'agent_error',
      });
      return 'Üzgünüm, kısa bir teknik aksaklık oldu. Tekrar söyler misiniz?';
    }
  }

  private async speakReply(replyText: string, turnId?: number) {
    const openingGreeting = RealtimeBridgeService.openingGreeting;
    const rewritten = rewriteAgentReplyForVoice(replyText);
    const spoken =
      rewritten === openingGreeting
        ? openingGreeting
        : shortenReplyForPhone(rewritten);
    if (rewritten !== replyText) {
      this.parentLogger.log(
        `[voice] rewrite_shortened callId=${this.meta.callId} stage=rewrite replyBefore=${JSON.stringify(replyText)} replyAfter=${JSON.stringify(rewritten)}`,
      );
    }
    if (spoken !== rewritten) {
      this.parentLogger.log(
        `[voice] rewrite_shortened callId=${this.meta.callId} stage=phone replyBefore=${JSON.stringify(rewritten)} replyAfter=${JSON.stringify(spoken)}`,
      );
    }
    const clean = sanitizeReplyForVoice(spoken);
    const effectiveTurnId = turnId ?? this.activeTurnId;
    if (!clean) {
      this.parentLogger.warn(
        `[voice] tts_skipped callId=${this.meta.callId} reason=empty_reply`,
      );
      return;
    }
    if (!this.sessionReady) {
      this.parentLogger.warn(
        `[voice] tts_skipped callId=${this.meta.callId} reason=session_not_ready`,
      );
      return;
    }
    if (!this.isTurnStillActive(effectiveTurnId)) {
      this.parentLogger.warn(
        `[voice] stale_turn_discarded callId=${this.meta.callId} replyTurnId=${effectiveTurnId} activeTurnId=${this.activeTurnId} stage=pre_tts`,
      );
      return;
    }

    if (this.assistantSpeaking || this.activeResponse) {
      this.cancelAssistantAudio('new_reply');
    }

    this.lastCancellationReason = null;

    this.lastBotReplyText = clean;
    this.currentReplyTurnId = effectiveTurnId;
    this.captureRecentContextsFromText(clean, effectiveTurnId, 'assistant');
    this.assistantSpeaking = true;
    this.assistantStartedAt = Date.now();

    this.parentLogger.log(
      `[voice] final_outgoing_text_before_elevenlabs callId=${this.meta.callId} text="${clean}"`,
    );

    if (clean === RealtimeBridgeService.openingGreeting) {
      this.parentLogger.log(
        `[voice] opening_greeting_tts_start callId=${this.meta.callId}`,
      );
    }

    try {
      const token = ++this.playbackToken;
      const ttsResult = await this.getOrCreateTtsAudio(
        clean,
        token,
        effectiveTurnId,
      );

      if (!this.isTurnStillActive(effectiveTurnId)) {
        this.parentLogger.warn(
          `[voice] stale_turn_discarded callId=${this.meta.callId} replyTurnId=${effectiveTurnId} activeTurnId=${this.activeTurnId} stage=tts_ready`,
        );
        return;
      }

      if (ttsResult?.audioBuffer && token === this.playbackToken) {
        this.parentLogger.log(
          `[voice] ElevenLabs success callId=${this.meta.callId} bytes=${ttsResult.audioBuffer.length} streamed=${ttsResult.streamed ? 'yes' : 'no'}`,
        );
        if (!ttsResult.streamed) {
          this.streamUlawBuffer(ttsResult.audioBuffer, token, effectiveTurnId);
        }
        return;
      }
    } catch (err) {
      this.parentLogger.error(
        `[voice] ElevenLabs failure callId=${this.meta.callId}: ${err}`,
      );
    }

    this.assistantSpeaking = false;
    this.activeResponse = false;
    this.parentLogger.warn(
      `[voice] tts_skipped callId=${this.meta.callId} reason=${this.lastCancellationReason ? `cancelled_${this.lastCancellationReason}` : 'elevenlabs_unavailable'}`,
    );
  }

  private async generateElevenLabsAudio(
    text: string,
    token?: number,
    turnId?: number,
  ): Promise<{ audioBuffer: Buffer | null; streamed: boolean }> {
    this.markTiming('elevenlabs_request_start', {
      textLength: text.length,
    });

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) {
      this.parentLogger.error('[voice] ElevenLabs API key or voice ID missing');
      return { audioBuffer: null, streamed: false };
    }

    const controller = new AbortController();
    this.currentTtsAbort = controller;

    try {
      const modelId =
        process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            language_code: 'tr',
            voice_settings: {
              stability: 0.35,
              similarity_boost: 0.8,
              speed: 0.96,
            },
          }),
          signal: controller.signal,
        },
      );

      this.markTiming('elevenlabs_first_byte', {
        status: response.status,
        ok: response.ok,
      });

      if (!response.ok) {
        const bodyText = await response.text();
        this.parentLogger.error(
          `[voice] ElevenLabs TTS error: ${response.status} ${bodyText}`,
        );
        return { audioBuffer: null, streamed: false };
      }

      const streamed =
        this.realtimeTtsStreamingEnabled &&
        !!response.body &&
        token != null &&
        turnId != null
          ? await this.streamElevenLabsResponse(response, token, turnId)
          : null;

      if (streamed?.audioBuffer) {
        this.markTiming('elevenlabs_success', {
          bytes: streamed.audioBuffer.length,
          streamed: true,
        });
        return { audioBuffer: streamed.audioBuffer, streamed: true };
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      this.markTiming('elevenlabs_success', {
        bytes: audioBuffer.length,
        streamed: false,
      });
      return { audioBuffer, streamed: false };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.parentLogger.warn(
          `[voice] ElevenLabs synthesis aborted callId=${this.meta.callId} reason=${this.lastCancellationReason || 'cancelled'}`,
        );
        return { audioBuffer: null, streamed: false };
      }
      this.parentLogger.error(`[voice] ElevenLabs TTS error: ${err}`);
      return { audioBuffer: null, streamed: false };
    } finally {
      if (this.currentTtsAbort === controller) {
        this.currentTtsAbort = null;
      }
    }
  }

  private buildDeterministicShortReply(
    userText: string,
  ): { key: string; reply: string } | null {
    const t = normalizeTurkishForTime(userText);
    if (!t) return null;

    const deterministicReplies: Array<{
      key: string;
      reply: string;
      patterns: RegExp[];
    }> = [
      {
        key: 'voice_check',
        reply: 'Evet, sizi duyuyorum.',
        patterns: [
          /^sesim geliyor mu[.!? ]*$/,
          /^beni duyuyor musunuz[.!? ]*$/,
          /^sesim duyuluyor mu[.!? ]*$/,
          /^ses geliyor mu[.!? ]*$/,
          /^beni duyabiliyor musunuz[.!? ]*$/,
        ],
      },
    ];

    for (const item of deterministicReplies) {
      if (item.patterns.some((pattern) => pattern.test(t))) {
        return { key: item.key, reply: item.reply };
      }
    }

    return null;
  }

  private async getOrCreateTtsAudio(
    text: string,
    token?: number,
    turnId?: number,
  ): Promise<{ audioBuffer: Buffer | null; streamed: boolean } | null> {
    const normalizedText = normalizeTtsCacheKey(text);
    const isOpeningGreeting =
      text === RealtimeBridgeService.openingGreeting ||
      normalizedText ===
        normalizeTtsCacheKey(RealtimeBridgeService.openingGreeting);

    if (isOpeningGreeting && RealtimeBridgeService.openingGreetingAudio) {
      this.parentLogger.log(
        `[voice] opening_greeting_cache_hit callId=${this.meta.callId} bytes=${RealtimeBridgeService.openingGreetingAudio.length}`,
      );
      this.markTiming('tts_cache_hit', {
        cache: 'opening_greeting',
        textLength: text.length,
      });
      return {
        audioBuffer: RealtimeBridgeService.openingGreetingAudio,
        streamed: false,
      };
    }

    const cached =
      RealtimeBridgeService.shortReplyAudioCache.get(normalizedText);
    if (cached) {
      this.parentLogger.log(
        `[voice] tts_cache_hit callId=${this.meta.callId} key=${JSON.stringify(normalizedText)} bytes=${cached.length}`,
      );
      this.markTiming('tts_cache_hit', {
        cache: isOpeningGreeting ? 'opening_greeting' : 'short_reply',
        textLength: text.length,
      });
      return { audioBuffer: cached, streamed: false };
    }

    if (isOpeningGreeting) {
      this.parentLogger.log(
        `[voice] opening_greeting_cache_miss callId=${this.meta.callId}`,
      );
    } else {
      this.parentLogger.log(
        `[voice] tts_cache_miss callId=${this.meta.callId} key=${JSON.stringify(normalizedText)}`,
      );
    }

    this.markTiming('tts_cache_miss', {
      cache: isOpeningGreeting ? 'opening_greeting' : 'short_reply',
      textLength: text.length,
    });

    if (isOpeningGreeting && RealtimeBridgeService.openingGreetingPromise) {
      return (
        RealtimeBridgeService.openingGreetingPromise?.then((audioBuffer) => ({
          audioBuffer,
          streamed: false,
        })) || null
      );
    }

    const synthesisPromise = this.generateElevenLabsAudio(text, token, turnId)
      .then((result) => {
        const audioBuffer = result?.audioBuffer || null;
        if (audioBuffer) {
          RealtimeBridgeService.shortReplyAudioCache.set(
            normalizedText,
            audioBuffer,
          );
          if (isOpeningGreeting) {
            RealtimeBridgeService.openingGreetingAudio = audioBuffer;
          }
        }
        return { audioBuffer, streamed: Boolean(result?.streamed) };
      })
      .finally(() => {
        if (isOpeningGreeting) {
          RealtimeBridgeService.openingGreetingPromise = null;
        }
      });

    if (isOpeningGreeting) {
      RealtimeBridgeService.openingGreetingPromise = synthesisPromise.then(
        (result) => result.audioBuffer,
      );
    }

    return synthesisPromise;
  }

  private async streamElevenLabsResponse(
    response: Response,
    token: number,
    turnId: number,
  ): Promise<{ audioBuffer: Buffer; streamed: boolean } | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Buffer[] = [];
    let pending = Buffer.alloc(0);
    let totalBytes = 0;
    let sentBytes = 0;
    let firstChunkSent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      const chunk = Buffer.from(value);
      chunks.push(chunk);
      totalBytes += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

      while (pending.length >= this.ulawFrameBytes) {
        if (
          this.closed ||
          token !== this.playbackToken ||
          !this.isTurnStillActive(turnId)
        ) {
          return {
            audioBuffer: Buffer.concat(chunks, totalBytes),
            streamed: false,
          };
        }

        const frame = pending.subarray(0, this.ulawFrameBytes);
        pending = pending.subarray(this.ulawFrameBytes);
        this.currentPlaybackOffsetBytes = sentBytes;
        this.lastAssistantAudioAt = Date.now();
        if (!firstChunkSent) {
          firstChunkSent = true;
          this.markTiming('final_audio_send_start', {
            bytes: totalBytes,
            streaming: true,
          });
          this.logTurnLatency('assistant_first_audio_streaming', turnId, {
            ttsBufferedBytes: totalBytes,
          });
          this.assistantPlaybackProtectionUntil =
            this.lastAssistantAudioAt + this.assistantGuardMs;
          if (this.lastBotReplyText === RealtimeBridgeService.openingGreeting) {
            this.openingGreetingProtectionUntil =
              this.lastAssistantAudioAt + this.openingGreetingBargeInGuardMs;
          }
        }
        this.sendAudioToTwilio(frame);
        sentBytes += frame.length;
      }
    }

    if (pending.length > 0) {
      const padded = Buffer.alloc(this.ulawFrameBytes, 0xff);
      pending.copy(padded);
      if (
        !this.closed &&
        token === this.playbackToken &&
        this.isTurnStillActive(turnId)
      ) {
        this.currentPlaybackOffsetBytes = sentBytes;
        this.lastAssistantAudioAt = Date.now();
        if (!firstChunkSent) {
          firstChunkSent = true;
          this.markTiming('final_audio_send_start', {
            bytes: totalBytes,
            streaming: true,
          });
          this.logTurnLatency('assistant_first_audio_streaming', turnId, {
            ttsBufferedBytes: totalBytes,
          });
          this.assistantPlaybackProtectionUntil =
            this.lastAssistantAudioAt + this.assistantGuardMs;
        }
        this.sendAudioToTwilio(padded);
        sentBytes += padded.length;
      }
    }

    this.currentPlaybackDurationMs =
      Math.ceil(sentBytes / this.ulawFrameBytes) * this.ulawFrameMs;
    this.currentPlaybackOffsetBytes = sentBytes;
    this.assistantSpeaking = false;
    this.activeResponse = false;
    return {
      audioBuffer: Buffer.concat(chunks, totalBytes),
      streamed: firstChunkSent,
    };
  }

  private logTurnLatency(
    label: string,
    turnId?: number,
    extra: Record<string, unknown> = {},
  ) {
    const now = Date.now();
    const parts = [
      `label=${label}`,
      `callId=${this.meta.callId}`,
      `turnId=${turnId ?? this.activeTurnId}`,
      this.lastSpeechStoppedAt
        ? `sinceSpeechStopped=${now - this.lastSpeechStoppedAt}ms`
        : '',
      this.timings.agent_processing_start
        ? `sinceAgentStart=${now - this.timings.agent_processing_start}ms`
        : '',
      this.timings.agent_reply_ready
        ? `sinceAgentReplyReady=${now - this.timings.agent_reply_ready}ms`
        : '',
      ...Object.entries(extra).map(([key, value]) => `${key}=${String(value)}`),
    ].filter(Boolean);
    this.parentLogger.log(`[voice][latency] ${parts.join(' ')}`);
  }

  private streamUlawBuffer(buf: Buffer, token: number, turnId: number) {
    if (!buf.length || token !== this.playbackToken) return;
    if (!this.isTurnStillActive(turnId)) {
      this.parentLogger.warn(
        `[voice] stale_turn_discarded callId=${this.meta.callId} replyTurnId=${turnId} activeTurnId=${this.activeTurnId} stage=audio_playback`,
      );
      return;
    }

    this.currentPlaybackDurationMs =
      Math.ceil(buf.length / this.ulawFrameBytes) * this.ulawFrameMs;
    this.currentPlaybackOffsetBytes = 0;
    let offset = 0;
    const tick = () => {
      if (this.closed) return;
      if (token !== this.playbackToken) return;
      if (!this.isTurnStillActive(turnId)) return;

      if (!this.assistantSpeaking) return;

      this.currentPlaybackOffsetBytes = offset;
      const chunk = buf.subarray(offset, offset + this.ulawFrameBytes);
      if (!chunk.length) {
        this.assistantSpeaking = false;
        this.playbackTimer = null;
        this.currentPlaybackDurationMs = 0;
        this.currentPlaybackOffsetBytes = 0;
        return;
      }

      this.lastAssistantAudioAt = Date.now();
      if (
        offset === 0 &&
        this.lastBotReplyText === RealtimeBridgeService.openingGreeting
      ) {
        this.openingGreetingProtectionUntil =
          this.lastAssistantAudioAt + this.openingGreetingBargeInGuardMs;
      }
      if (offset === 0) {
        this.assistantPlaybackProtectionUntil =
          this.lastAssistantAudioAt + this.assistantGuardMs;
        this.markTiming('final_audio_send_start', {
          bytes: buf.length,
          streaming: false,
        });
        this.logTurnLatency('assistant_first_audio_buffered', turnId, {
          totalBytes: buf.length,
        });
        if (this.lastBotReplyText === RealtimeBridgeService.openingGreeting) {
          this.parentLogger.log(
            `[voice] opening_greeting_audio_sent callId=${this.meta.callId} bytes=${buf.length}`,
          );
        }
      }

      this.sendAudioToTwilio(chunk);

      offset += this.ulawFrameBytes;
      this.playbackTimer = setTimeout(tick, this.ulawFrameMs);
    };

    tick();
  }

  private sendOpenAi(obj: any) {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
    this.openaiWs.send(JSON.stringify(obj));
  }

  private sendBridge(obj: any) {
    if (this.clientWs.readyState !== WebSocket.OPEN) return;
    this.clientWs.send(JSON.stringify(obj));
  }

  private sendAudioToTwilio(audioBuffer: Buffer) {
    console.log('[VOICE DEBUG] sending audio chunk size=', audioBuffer.length);
    this.sendBridge({
      event: 'media',
      media: { payload: audioBuffer.toString('base64') },
    });
  }

  private safeClose() {
    if (this.closed) return;
    this.closed = true;

    if (this.pendingTranscriptTimer) {
      clearTimeout(this.pendingTranscriptTimer);
      this.pendingTranscriptTimer = null;
    }
    this.pendingTranscriptText = '';
    this.pendingTranscriptState = null;
    this.queuedTranscript = null;

    this.cancelAssistantAudio('close');

    try {
      if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
        this.openaiWs.close();
      }
    } catch {}

    try {
      if (this.clientWs.readyState === WebSocket.OPEN) {
        this.clientWs.close();
      }
    } catch {}
  }
}

function extractReplyText(result: any): string {
  if (!result) return '';

  if (typeof result === 'string') return result.trim();

  const candidates = [
    result.text,
    result.reply,
    result.message,
    result.finalText,
    result.replyText,
    result.assistantText,
    result.outputText,
    result.content,
  ];

  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) {
      return item.trim();
    }
  }

  if (Array.isArray(result.messages) && result.messages.length) {
    const last = result.messages[result.messages.length - 1];
    if (typeof last === 'string' && last.trim()) return last.trim();
    if (typeof last?.text === 'string' && last.text.trim())
      return last.text.trim();
    if (typeof last?.content === 'string' && last.content.trim())
      return last.content.trim();
  }

  return '';
}

export function normalizeTranscriptForAgent(
  raw: string,
  lastBotReplyText: string,
): string {
  let text = stripTranscriptContamination(String(raw || '').trim());
  if (!text) return '';

  text = text
    .replace(/[“”"']/g, '')
    .replace(/[،,;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!isGreetingOnlyUtterance(text)) {
    text = text
      .replace(
        /^(merhaba|selam|iyi gunler|iyi aksamlar|gunaydin)[,!\s:-]+/i,
        '',
      )
      .trim();
  }

  const lastBot = String(lastBotReplyText || '').toLocaleLowerCase('tr-TR');

  if (
    /^evet[.!]*$/i.test(text) ||
    /^onayl[ıi]yorum[.!]*$/i.test(text) ||
    /^tamam[.!]*$/i.test(text)
  ) {
    return 'evet';
  }

  if (/^hay[ıi]r[.!]*$/i.test(text) || /^istemiyorum[.!]*$/i.test(text)) {
    return 'hayır';
  }

  if (/^\d{1,2}[.:]\d{2}[.]?$/.test(text)) {
    return text.replace(/\./g, ':').replace(/:+/g, ':').replace(/:$/, '');
  }

  const askedService =
    lastBot.includes('hangi hizmet') || lastBot.includes('hangi işlem');
  if (askedService) {
    if (/^lazer[.!]*$/i.test(text)) return 'Lazer epilasyon';
    return text;
  }

  const askedTime =
    lastBot.includes('uygun saati') ||
    lastBot.includes('saat kaç') ||
    lastBot.includes('saat alayım') ||
    lastBot.includes('gün ve saat') ||
    lastBot.includes('hangi gün/saat') ||
    lastBot.includes('hangi gün ve saatte');
  if (askedTime) {
    const normalizedTime = parseTurkishVoiceDateTime(text);
    if (normalizedTime) return normalizedTime;
  }

  const askedConfirmation =
    lastBot.includes('onaylıyor musunuz') ||
    lastBot.includes('randevu bilgileri doğruysa') ||
    lastBot.includes('doğru mu');
  if (askedConfirmation) {
    const lower = text.toLocaleLowerCase('tr-TR');
    if (lower.includes('evet') || lower.includes('onay')) return 'evet';
    if (lower.includes('hayır') || lower.includes('iptal')) return 'hayır';
  }

  return text;
}

function isCriticalVoiceState(state?: string | null) {
  return state === 'WAIT_NAME' || state === 'WAIT_DATETIME';
}

export function shouldBufferShortVoiceTranscript(
  state: string | null | undefined,
  transcript: string,
) {
  if (!isCriticalVoiceState(state)) return false;
  const normalized = normalizeTurkishForTime(transcript);
  if (!normalized) return false;
  if (state === 'WAIT_NAME') return normalized.length <= 12;
  if (state === 'WAIT_DATETIME') return normalized.length <= 20;
  return false;
}

export function mergeVoiceFragments(
  previous: string,
  incoming: string,
  state: string | null | undefined,
) {
  const prev = String(previous || '').trim();
  const next = String(incoming || '').trim();
  if (!prev) return next;
  if (!next) return prev;
  if (!isCriticalVoiceState(state)) return next;
  const prevNorm = normalizeTurkishForTime(prev);
  const nextNorm = normalizeTurkishForTime(next);
  if (!prevNorm || !nextNorm || prevNorm === nextNorm) return next;
  if (state === 'WAIT_NAME') return `${prev} ${next}`.trim();
  if (state === 'WAIT_DATETIME') return `${prev} ${next}`.trim();
  return next;
}

function normalizeTurkishForTime(s: string) {
  return String(s || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTtsCacheKey(text: string) {
  return sanitizeReplyForVoice(normalizeTurkishForTime(text));
}

function parseTurkishVoiceDateTime(text: string): string | null {
  const t = normalizeTurkishForTime(text)
    .replace(/\buygundur\b/g, '')
    .replace(/\bolsun\b/g, '')
    .replace(/\brandevu\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const explicit = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  let hh: number | null = null;
  let mm = 0;

  if (explicit) {
    hh = Number(explicit[1]);
    mm = Number(explicit[2]);
  } else {
    const numberWordMap: Record<string, number> = {
      oniki: 12,
      'on iki': 12,
      onbir: 11,
      'on bir': 11,
      on: 10,
      dokuz: 9,
      sekiz: 8,
      yedi: 7,
      alti: 6,
      bes: 5,
      dort: 4,
      uc: 3,
      iki: 2,
      bir: 1,
    };

    for (const [word, value] of Object.entries(numberWordMap)) {
      if (new RegExp(`\\b${word}\\b`).test(t)) {
        hh = value;
        break;
      }
    }

    if (hh == null) {
      const numeric = t.match(/\b(\d{1,2})\b/);
      if (numeric) hh = Number(numeric[1]);
    }

    if (t.includes('bucuk')) mm = 30;
    if (t.includes('ceyrek')) mm = 15;
  }

  if (hh == null) return null;

  const hasMorning = t.includes('sabah');
  const hasNoon = t.includes('ogle') || t.includes('oglen');
  const hasEvening = t.includes('aksam') || t.includes('gece');
  const hasTomorrow = t.includes('yarin');
  const hasToday = t.includes('bugun');

  if (hasEvening && hh >= 1 && hh <= 11) hh += 12;
  else if (hasNoon && hh >= 1 && hh <= 5) hh += 12;
  else if (!hasMorning && !hasNoon && !hasEvening && hh >= 1 && hh <= 7)
    hh += 12;

  const timeText = `${String(hh).padStart(2, '0')}:${String(mm).padStart(
    2,
    '0',
  )}`;

  if (hasTomorrow) return `yarın ${timeText}`;
  if (hasToday) return `bugün ${timeText}`;
  return timeText;
}

function sanitizeReplyForVoice(text: string) {
  const sanitized = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/[_`#]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[•·]/g, ' ')
    .replace(/[“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripRepeatedGreetingLead(sanitized);
}

function stripRepeatedGreetingLead(text: string) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (
    normalizeVoiceComparisonText(source) ===
    normalizeVoiceComparisonText(RealtimeBridgeService.openingGreeting)
  ) {
    return source;
  }

  return source
    .replace(/^(merhaba|selam|iyi gunler|iyi aksamlar|gunaydin)[,!\s:-]+/i, '')
    .replace(/^size nasil yardimci olabilirim\??/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isGreetingOnlyUtterance(text: string) {
  const normalized = normalizeVoiceComparisonText(text);
  return [
    'merhaba',
    'selam',
    'alo',
    'iyi gunler',
    'iyi aksamlar',
    'gunaydin',
  ].includes(normalized);
}

function normalizeVoiceComparisonText(text: string) {
  return String(text || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityScore(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));
  if (!aWords.size || !bWords.size) return 0;
  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersection += 1;
  }
  const union = new Set([...aWords, ...bWords]).size || 1;
  const jaccard = intersection / union;
  const lengthRatio =
    Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return jaccard * 0.7 + lengthRatio * 0.3;
}

function detectRecentIntent(
  text: string,
): RecentIntentContext['intent'] | null {
  const normalized = normalizeTurkishForTime(text);
  if (!normalized) return null;
  if (
    /(randevu|rezervasyon|uygun saat|müsait|musait|yarin|yarın|bugun|bugün)/.test(
      normalized,
    )
  ) {
    return 'booking';
  }
  if (/(personel|kimle|hangi uzman|hangi personel)/.test(normalized)) {
    return 'staff_preference';
  }
  if (
    /(fiyat|ucret|ücret|bilgi|adres|saat kac|kaçta acik|açik)/.test(normalized)
  ) {
    return 'info';
  }
  return 'general';
}

export function rewriteAgentReplyForVoice(replyText: string) {
  let text = sanitizeReplyForVoice(String(replyText || '').trim())
    .replace(/yazar mısınız/gi, 'söyler misiniz')
    .replace(/yazar misiniz/gi, 'söyler misiniz')
    .replace(/\(E\/H\)/gi, '')
    .replace(/\bE\/H\b/gi, '');
  const lower = text.toLocaleLowerCase('tr-TR');

  if (lower.startsWith('randevu özeti:')) {
    return 'Bilgiler doğruysa onaylayayım mı?';
  }

  if (lower.includes('o saat dolu') || lower.includes('şunlar uygun')) {
    const slots = [
      ...text.matchAll(/\b(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\b/g),
    ].slice(0, 3);

    if (slots.length) {
      const spoken = slots
        .map((m) => formatDateTimeForSpeech(`${m[1]} ${m[2]}`))
        .join(', ');
      return `O saat dolu. En yakın uygun saatler ${spoken}. İsterseniz başka bir saat de söyleyebilirsiniz.`;
    }

    return 'O saat dolu. Yakın bir saat söyleyebilir misiniz?';
  }

  if (
    lower.includes('randevu tamam') ||
    lower.includes('randevunuz oluşturuldu') ||
    lower.includes('kayıt:')
  ) {
    const m = text.match(/\b(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\b/);
    if (m) {
      return `Tamamdır, randevunuzu ${formatDateTimeForSpeech(`${m[1]} ${m[2]}`)} için oluşturdum.`;
    }
    return 'Tamamdır, randevunuzu oluşturdum.';
  }

  if (
    lower.includes('randevu oluştururken bir şey ters gitti') ||
    lower.includes('başka bir saat dener misin') ||
    lower.includes('bir hata oldu')
  ) {
    return 'Randevu oluşturulamadı. Başka bir saat deneyelim.';
  }

  text = text
    .replace(/[•]/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  text = humanizeBookingSummaryForSpeech(text);
  text = humanizeConfirmationForSpeech(text);
  text = formatDateTimeForSpeech(text);

  return text;
}

export function shortenReplyForPhone(text: string) {
  const original = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = original
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return out;

  const numberedItems = [...out.matchAll(/\b\d\)\s*[^\n]+/g)];
  if (numberedItems.length > 2) {
    return `Toplam ${numberedItems.length} seçenek var. İstersen ilk iki uygun olanı söyleyebilirim.`;
  }

  const sentenceParts = out
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentenceParts.length > 2) {
    out = sentenceParts.slice(0, 2).join(' ');
  }

  if (out.length > 220) {
    const shortened = out.slice(0, 220);
    const cutAt = Math.max(
      shortened.lastIndexOf('. '),
      shortened.lastIndexOf('? '),
      shortened.lastIndexOf('! '),
      shortened.lastIndexOf(', '),
    );
    out = (cutAt > 80 ? shortened.slice(0, cutAt + 1) : shortened).trim();
    out = out.replace(/[,:;\s]+$/g, '');
    if (!/[.!?]$/.test(out)) out += '.';
  }

  if (isUselessShortAck(out) && shouldPreserveMeaningfulReply(original)) {
    return preserveMeaningfulReply(original);
  }

  return out.replace(/\s{2,}/g, ' ').trim();
}

function stripTranscriptContamination(text: string) {
  let cleaned = String(text || '').trim();
  if (!cleaned) return '';

  const contaminationPatterns = [
    /\b(guzellik merkezi|güzellik merkezi),?\s*randevu,?\s*rezervasyon\b/gi,
    /\bben guzellik merkezinden ariyorum\b/gi,
    /\bben güzellik merkezinden arıyorum\b/gi,
    /\bsesli yapay zeka asistaniyim\b/gi,
    /\bsesli yapay zeka asistanıyım\b/gi,
    /\bsize nasil yardimci olabilirim\b/gi,
    /\bsize nasıl yardımcı olabilirim\b/gi,
    /\byou are the voice layer\b/gi,
    /\byalnizca uygulamanin verdigi yaniti oku\b/gi,
    /\byalnızca uygulamanın verdiği yanıtı oku\b/gi,
  ];

  for (const pattern of contaminationPatterns) {
    cleaned = cleaned.replace(pattern, ' ');
  }

  cleaned = cleaned
    .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) return '';

  const normalized = normalizeVoiceComparisonText(cleaned);
  const contaminationOnlyPatterns = [
    /^guzellik merkezi randevu rezervasyon(?: [a-zçğıöşü]+){0,6}$/i,
    /^ben guzellik merkezinden ariyorum(?: [a-zçğıöşü]+){0,6}$/i,
    /^sesli yapay zeka asistaniyim(?: [a-zçğıöşü]+){0,6}$/i,
  ];
  if (contaminationOnlyPatterns.some((pattern) => pattern.test(normalized))) {
    return '';
  }

  return cleaned;
}

function isUselessShortAck(text: string) {
  return /^(tamam|tamamdir|tamamdır|peki|tabii|tabi|olur|anladim|anladım)\.?$/i.test(
    String(text || '').trim(),
  );
}

function shouldPreserveMeaningfulReply(text: string) {
  const normalized = normalizeVoiceComparisonText(text);
  if (!normalized || isUselessShortAck(normalized)) return false;
  if (/\?$/.test(text)) return true;
  if (/\b(nasil|nasıl|hangi|ne zaman|neden|icin|için|fiyat|ucret|ücret|saat|adres|randevu|rezervasyon|yardimci|yardımcı)\b/i.test(text)) {
    return true;
  }
  return normalized.split(/\s+/).filter(Boolean).length >= 4;
}

function preserveMeaningfulReply(text: string) {
  const sentenceParts = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  let preserved = sentenceParts.slice(0, 2).join(' ').trim();
  if (preserved.length > 160) {
    preserved = preserved.slice(0, 160).trim();
    preserved = preserved.replace(/[,:;\s]+$/g, '');
    if (!/[.!?]$/.test(preserved)) preserved += '.';
  }
  return preserved || String(text || '').trim();
}

function formatDateForSpeech(dateText: string, now = new Date()) {
  const match = String(dateText || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return String(dateText || '').trim();

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const target = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(target.getTime())) return String(dateText || '').trim();

  const months = [
    'Ocak',
    'Şubat',
    'Mart',
    'Nisan',
    'Mayıs',
    'Haziran',
    'Temmuz',
    'Ağustos',
    'Eylül',
    'Ekim',
    'Kasım',
    'Aralık',
  ];
  const weekdays = [
    'pazar',
    'pazartesi',
    'salı',
    'çarşamba',
    'perşembe',
    'cuma',
    'cumartesi',
  ];

  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const targetUtc = Date.UTC(year, month - 1, day);
  const diffDays = Math.round((targetUtc - todayUtc) / 86400000);

  if (diffDays === 0) return 'bugün';
  if (diffDays === 1) return 'yarın';
  if (diffDays === -1) return 'dün';
  if (diffDays > 1 && diffDays <= 6) {
    return (
      weekdays[target.getUTCDay()] || `${day} ${months[month - 1]} ${year}`
    );
  }

  return `${day} ${months[month - 1]} ${year}`;
}

function formatTimeForSpeech(timeText: string) {
  const match = String(timeText || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return String(timeText || '').trim();

  const hh24 = Number(match[1]);
  const mm = Number(match[2]);
  if (Number.isNaN(hh24) || Number.isNaN(mm)) {
    return String(timeText || '').trim();
  }

  const hourWords = [
    'sıfır',
    'bir',
    'iki',
    'üç',
    'dört',
    'beş',
    'altı',
    'yedi',
    'sekiz',
    'dokuz',
    'on',
    'on bir',
    'on iki',
  ];

  let hh12 = hh24 % 12;
  if (hh12 === 0) hh12 = 12;

  const base = hourWords[hh12] || String(hh12);
  let prefix = 'saat';

  if (hh24 >= 5 && hh24 < 12) prefix = 'sabah';
  else if (hh24 >= 12 && hh24 < 18) prefix = 'öğleden sonra';
  else if (hh24 >= 18 && hh24 < 22) prefix = 'akşam';
  else prefix = 'gece';

  const spokenPrefix = prefix === 'öğleden sonra' ? 'saat' : prefix;

  if (mm === 0) return `${spokenPrefix} ${base}`;
  if (mm === 15) return `${spokenPrefix} ${base} on beş`;
  if (mm === 30) return `${spokenPrefix} ${base} buçuk`;
  if (mm === 45) return `${spokenPrefix} ${base} kırk beş`;

  return `${spokenPrefix} ${base} ${mm}`;
}

function formatDateTimeForSpeech(text: string, now = new Date()) {
  let out = String(text || '');

  out = out.replace(
    /\b(\d{1,2}\.\d{1,2}\.\d{4})\s+(\d{1,2}:\d{2})\b/g,
    (_match, datePart: string, timePart: string) =>
      `${formatDateForSpeech(datePart, now)} ${formatTimeForSpeech(timePart)}`,
  );

  out = out.replace(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/g, (_match, datePart) =>
    formatDateForSpeech(datePart, now),
  );
  out = out.replace(/\b(\d{1,2}:\d{2})\b/g, (_match, timePart) =>
    formatTimeForSpeech(timePart),
  );

  return out.replace(/\s+/g, ' ').trim();
}

function humanizeConfirmationForSpeech(text: string) {
  return String(text || '')
    .replace(
      /Randevu bilgileri doğruysa onaylıyor musunuz\?/gi,
      'Bilgiler doğruysa onaylayayım mı?',
    )
    .replace(
      /Randevuyu onaylıyor musunuz\?\s*Evet veya hayır diyebilirsiniz\.?/gi,
      'Bu şekilde oluşturalım mı?',
    )
    .replace(/Onaylıyor musunuz\?/gi, 'Uygunsa onaylayayım mı?')
    .replace(/Doğru mu\?/gi, 'Bu şekilde oluşturalım mı?')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeBookingSummaryForSpeech(text: string) {
  const source = String(text || '').trim();
  const lower = source.toLocaleLowerCase('tr-TR');
  const hasBookingSignal =
    lower.includes('randevu özeti') ||
    lower.includes('hizmet') ||
    lower.includes('tarih') ||
    lower.includes('saat') ||
    lower.includes('isim');

  if (!hasBookingSignal) {
    return source;
  }

  const service = source.match(/hizmet\s*[:\-]\s*([^,.\n]+)/i)?.[1]?.trim();
  const customer = source.match(/isim\s*[:\-]\s*([^,.\n]+)/i)?.[1]?.trim();
  const dateTime = source.match(/(\d{1,2}\.\d{1,2}\.\d{4})\s+(\d{1,2}:\d{2})/);

  const summaryParts: string[] = [];
  if (service) summaryParts.push(`${service} için`);
  if (dateTime) {
    summaryParts.push(formatDateTimeForSpeech(`${dateTime[1]} ${dateTime[2]}`));
  }
  if (customer && !lower.includes('adınızı') && !lower.includes('isminizi')) {
    summaryParts.push(`${customer} adına`);
  }

  if (!summaryParts.length) {
    return source;
  }

  const summary = `${summaryParts.join(', ')} uygun görünüyor.`;
  const questionMatch = source.match(/[^.?!]*\?/g);
  const question = questionMatch?.length
    ? humanizeConfirmationForSpeech(
        questionMatch[questionMatch.length - 1] || '',
      )
    : '';

  return `${summary}${!summary.endsWith('?') && question ? ` ${question}` : ''}`.trim();
}

function naturalTimeSpeech(hhmm: string) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;

  let hh = Number(m[1]);
  const mm = Number(m[2]);

  if (hh > 12) hh -= 12;
  if (hh === 0) hh = 12;

  const hourWords = [
    'sıfır',
    'bir',
    'iki',
    'üç',
    'dört',
    'beş',
    'altı',
    'yedi',
    'sekiz',
    'dokuz',
    'on',
    'on bir',
    'on iki',
  ];

  const base = hourWords[hh] || String(hh);

  if (mm === 0) return `saat ${base}`;
  if (mm === 15) return `saat ${base} on beş`;
  if (mm === 30) return `${base} buçuk`;

  return `saat ${base} ${String(mm).padStart(2, '0')}`;
}

function normalizePhone(input: string) {
  const raw = String(input || '').trim();
  if (!raw) return 'voice-caller';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return 'voice-caller';

  if (digits.startsWith('90')) return `+${digits}`;
  if (digits.startsWith('0')) return `+9${digits}`;
  return `+${digits}`;
}

function pcmuBase64Rms(payloadB64: string) {
  const buf = Buffer.from(payloadB64, 'base64');
  if (!buf.length) return 0;

  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const sample = ulawToLinear16(buf[i]);
    sumSq += sample * sample;
  }

  return Math.sqrt(sumSq / buf.length);
}

function ulawToLinear16(uVal: number) {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function serializeTimingExtras(extra: Record<string, unknown>) {
  const entries = Object.entries(extra).filter(
    ([, value]) => value !== undefined,
  );
  if (!entries.length) return '';

  return entries
    .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
    .join('');
}
