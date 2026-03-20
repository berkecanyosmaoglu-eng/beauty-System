import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { VoiceAgentService } from '../agent/voice-agent.service';
import { rewriteAgentReplyForVoice } from '../agent/shared/voice-response-policy';

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
  | 'final_audio_send_start'
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
    return;
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
      `[voice] compat handleTwilioWebSocket tenantId=${tenantId} callId=${callId} from=${from || '-'} to=${to || '-'}`,
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
  private sessionCreated = false;
  private pendingInputAudio: string[] = [];
  private pendingInputAudioBytes = 0;
  private pendingInputAudioDropped = 0;
  private lastPendingInputAudioLogAt = 0;
  private responseCreatePending = false;
  private readonly maxPendingInputAudioChunks = 25;
  private readonly maxPendingInputAudioMs = 500;
  private readonly maxPendingInputAudioBytes = 4000;
  private greeted = false;
  private bridgeReady = false;
  private greetingInFlight = false;
  private turnSequence = 0;
  private activeTurnId = 0;

  private lastAssistantAudioAt = 0;
  private assistantSpeaking = false;
  private assistantStartedAt = 0;
  private lastAssistantMessage = '';

  private speechEnergyFrames = 0;
  private lastObservedSpeechEnergy = 0;
  private ambientNoiseRms = 0;
  private readonly minSpeechEnergyThreshold = 220;
  private readonly maxSpeechEnergyThreshold = 1200;
  private readonly speechEnergyThreshold = 600;
  private readonly speechFramesForBargeIn = 8;
  private readonly assistantGuardMs = 1800;
  private readonly openingGreetingBargeInGuardMs = 2200;
  private readonly minPlaybackBargeInMs = 1000;

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
  private speechFailsafeTimer: NodeJS.Timeout | null = null;
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
  private lastChunkSummaryLogAt = 0;
  private outboundAudioQueue: Buffer[] = [];
  private outboundAudioPumpRunning = false;
  private openAiAudioDonePending = false;

  private outboundAudioChunkCount = 0;
  private outboundAudioByteCount = 0;
  private readonly debugVoice = process.env.DEBUG_VOICE === '1';
  private lastCancellationReason:
    | 'real_barge_in'
    | 'new_reply'
    | 'close'
    | null = null;

  // 20ms @ 8kHz μ-law = 160 bytes
  private readonly ulawFrameBytes = 160;
  private readonly ulawFrameMs = 20;
  private readonly minBufferedAudioChunkBytes = 640;
  private readonly realtimeTtsStreamingEnabled = false;

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
    const model = process.env.JARVIS_REALTIME_MODEL || 'gpt-realtime';
    this.openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  }

  start() {
    this.markTiming('websocket_connected');
    this.ensureBridgeReady('session_start');

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

  private getPreferredRealtimeVoice() {
    return (
      process.env.JARVIS_REALTIME_VOICE ||
      process.env.OPENAI_TTS_VOICE ||
      'alloy'
    );
  }

  private configureOpenAiSession() {
    const eventId = `session_update_${this.meta.callId}_${Date.now()}`;
    this.sendOpenAi({
      type: 'session.update',
      event_id: eventId,
      session: {
        type: 'realtime',
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
      this.ensureBridgeReady('bridge_start');
      this.parentLogger.log(
        `[voice] bridge start callId=${this.meta.callId} tenantId=${this.meta.tenantId}`,
      );
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

      if (!this.sessionReady) {
        this.bufferInboundAudio(payload);
        return;
      }

      this.appendInputAudio(payload);
      return;
    }
  }

  private async onOpenAiEvent(evt: OpenAiEvent) {
    switch (evt.type) {
      case 'session.created':
        this.sessionCreated = true;
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
        this.flushPendingInputAudio('session.updated');
        this.maybeStartOpeningGreeting();
        return;

      case 'response.created':
        this.responseCreatePending = false;
        this.parentLogger.log(
          `[voice] response.created callId=${this.meta.callId}`,
        );
        return;

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (!evt.delta) return;

        this.markAssistantPlaybackStarted('openai_realtime');
        if (!this.currentPlaybackDurationMs) {
          this.markTiming('final_audio_send_start', {
            source: 'openai_realtime',
          });
          this.logTurnLatency(
            'assistant_first_audio_openai',
            this.currentReplyTurnId || this.activeTurnId,
            {
              source: 'openai_realtime',
            },
          );
        }

        {
          const audioBuf = Buffer.from(evt.delta, 'base64');
          const frameCount = Math.ceil(audioBuf.length / 160);
          this.currentPlaybackDurationMs += frameCount * this.ulawFrameMs;
          this.enqueueAudioBuffer(audioBuf);
        }
        return;

      case 'response.output_audio.done':
      case 'response.audio.done':
        this.openAiAudioDonePending = true;
        if (
          !this.outboundAudioPumpRunning &&
          this.outboundAudioQueue.length === 0
        ) {
          this.openAiAudioDonePending = false;
          this.completeAssistantPlayback(`openai_${evt.type}`);
        }
        this.parentLogger.log(`[voice] ${evt.type} callId=${this.meta.callId}`);
        return;

      case 'response.done':
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
        this.refreshSpeechFailsafe();
        this.parentLogger.log(
          `[voice] speech_started callId=${this.meta.callId}`,
        );
        if (this.agentTurnInFlight) {
          this.parentLogger.debug(
            `[voice] speech_ignored_during_assistant callId=${this.meta.callId}`,
          );
          return;
        }
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
            `event=speech_started speechFrames=${this.speechEnergyFrames} rms=${this.formatEnergy(this.lastObservedSpeechEnergy)}`,
          );
        }
        return;

      case 'input_audio_buffer.speech_stopped':
        this.lastSpeechStoppedAt = Date.now();
        this.markTiming('speech_stopped');
        this.refreshSpeechFailsafe();
        this.parentLogger.log(
          `[voice] speech_stopped callId=${this.meta.callId}`,
        );
        return;

      case 'error': {
        const code = String(evt?.error?.code || '');
        if (code === 'response_cancel_not_active') return;
        this.parentLogger.error(
          `[voice] OpenAI error callId=${this.meta.callId} eventId=${String(
            evt?.event_id || evt?.error?.event_id || '',
          )} param=${String(evt?.error?.param || '')} code=${code}: ${JSON.stringify(
            evt.error || evt,
          )}`,
        );
        if (code === 'server_error') {
          this.handleOpenAiServerError(code);
        }
        return;
      }

      default:
        return;
    }
  }

  private async sendAudioBufferRealtime(
    audioBuf: Buffer,
    source: 'streaming' | 'buffered' = 'buffered',
  ) {
    for (let i = 0; i < audioBuf.length; i += 160) {
      const chunk = audioBuf.subarray(i, i + 160);
      if (!chunk.length) continue;

      this.currentPlaybackDurationMs += this.ulawFrameMs;
      this.sendAudioChunk(chunk, source);

      await new Promise((resolve) => setTimeout(resolve, this.ulawFrameMs));
    }
  }

  private async handleCompletedTranscript(rawTranscript: string) {
    const currentState = this.getCurrentVoiceBookingState();

    if (this.agentTurnInFlight || this.assistantSpeaking) {
      this.parentLogger.debug(
        `[voice] transcript_ignored_during_assistant callId=${this.meta.callId}`,
      );
      return;
    }

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
    if (this.agentTurnInFlight || this.assistantSpeaking) {
      this.parentLogger.debug(
        `[voice] transcript_ignored_during_assistant callId=${this.meta.callId} state=${state || '-'} text="${transcript}"`,
      );
      return;
    }

    setTimeout(() => {
      if (this.agentTurnInFlight || this.assistantSpeaking) {
        this.parentLogger.debug(
          `[voice] transcript_ignored_during_assistant callId=${this.meta.callId} state=${state || '-'} text="${transcript}" stage=debounce`,
        );
        return;
      }

      void this.processTranscriptTurn(transcript, state);
    }, 300);
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
      if (!this.canPlaybackStaleTurn(turnId, 'agent_reply')) {
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

    const rawCaller =
      String(this.meta.from || '').trim() ||
      String(this.meta.callId || '').trim() ||
      'unknown-voice-caller';

    const customerPhone = normalizePhone(rawCaller);

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

  private formatEnergy(value: number | null | undefined) {
    return (value ?? 0).toFixed(0);
  }

  private ensureBridgeReady(reason: string) {
    const writable = this.clientWs.readyState === WebSocket.OPEN;
    if (writable && !this.bridgeReady) {
      this.bridgeReady = true;
      this.parentLogger.log(
        `[voice] bridge_ready_changed callId=${this.meta.callId} bridgeReady=true reason=${reason}`,
      );
    }

    if (!writable && this.debugVoice) {
      this.parentLogger.debug(
        `[voice] bridge_not_writable callId=${this.meta.callId} reason=${reason} readyState=${this.clientWs.readyState}`,
      );
    }

    return writable;
  }

  private getAdaptiveSpeechThreshold() {
    const adaptive = this.ambientNoiseRms
      ? Math.round(this.ambientNoiseRms * 3)
      : this.speechEnergyThreshold;
    const threshold = Math.max(adaptive, 600);
    return Math.max(
      this.minSpeechEnergyThreshold,
      Math.min(this.maxSpeechEnergyThreshold, threshold),
    );
  }

  private updateAmbientNoise(rms: number) {
    if (!Number.isFinite(rms) || rms <= 0) return;
    if (this.assistantSpeaking || this.speechEnergyFrames > 0) return;
    this.ambientNoiseRms = this.ambientNoiseRms
      ? this.ambientNoiseRms * 0.95 + rms * 0.05
      : rms;
  }

  private refreshSpeechFailsafe() {
    if (this.speechFailsafeTimer) {
      clearTimeout(this.speechFailsafeTimer);
    }
    this.speechFailsafeTimer = setTimeout(() => {
      this.speechFailsafeTimer = null;
      void this.forceResponseAfterSilence();
    }, 2000);
  }

  private async forceResponseAfterSilence() {
    if (this.closed || this.agentTurnInFlight || this.assistantSpeaking) return;

    const buffered = this.pendingTranscriptText.trim();
    const bufferedState = this.pendingTranscriptState;
    if (buffered) {
      this.pendingTranscriptText = '';
      this.pendingTranscriptState = null;
      if (this.pendingTranscriptTimer) {
        clearTimeout(this.pendingTranscriptTimer);
        this.pendingTranscriptTimer = null;
      }
      this.parentLogger.warn(
        `[voice] speech_failsafe_flush callId=${this.meta.callId} text="${buffered}"`,
      );
      await this.enqueueOrProcessTranscript(buffered, bufferedState);
      return;
    }

    const sinceSpeechStopped = this.lastSpeechStoppedAt
      ? Date.now() - this.lastSpeechStoppedAt
      : Number.POSITIVE_INFINITY;
    if (sinceSpeechStopped < 1900 || sinceSpeechStopped > 2600) return;

    this.parentLogger.warn(
      `[voice] speech_failsafe_no_transcript callId=${this.meta.callId} sinceSpeechStopped=${sinceSpeechStopped}`,
    );
    await this.speakReply('Buyurun, sizi dinliyorum.');
  }

  private sendAudioChunk(
    chunk: Buffer,
    source: 'streaming' | 'buffered' = 'buffered',
  ) {
    if (!chunk.length) return;
    this.outboundAudioChunkCount += 1;
    this.outboundAudioByteCount += chunk.length;

    const now = Date.now();
    const shouldLogChunk =
      this.outboundAudioChunkCount === 1 ||
      now - this.lastChunkSummaryLogAt >= 4000;
    if (shouldLogChunk) {
      this.lastChunkSummaryLogAt = now;
      this.parentLogger.log(
        `[voice-test] sendAudioChunk callId=${this.meta.callId} source=${source} chunkIndex=${this.outboundAudioChunkCount} bytes=${chunk.length} totalBytes=${this.outboundAudioByteCount}`,
      );
    }

    const sent = this.sendBridge({
      event: 'media',
      media: { payload: chunk.toString('base64') },
    });

    if (sent !== true) {
      this.parentLogger.warn(
        `[voice] playback_skipped callId=${this.meta.callId} reason=bridge_send_failed source=${source} chunkSize=${chunk.length}`,
      );
      return;
    }
  }

  private enqueueAudioBuffer(audioBuf: Buffer) {
    for (let i = 0; i < audioBuf.length; i += 160) {
      const chunk = audioBuf.subarray(i, i + 160);
      if (!chunk.length) continue;
      this.outboundAudioQueue.push(Buffer.from(chunk));
    }

    void this.pumpOutboundAudioQueue();
  }

  private async pumpOutboundAudioQueue() {
    if (this.outboundAudioPumpRunning) return;
    this.outboundAudioPumpRunning = true;

    try {
      while (this.outboundAudioQueue.length > 0) {
        const chunk = this.outboundAudioQueue.shift();
        if (!chunk) continue;

        this.sendAudioChunk(chunk, 'buffered');
        await new Promise((resolve) => setTimeout(resolve, this.ulawFrameMs));
      }
    } finally {
      this.outboundAudioPumpRunning = false;

      if (this.openAiAudioDonePending && this.outboundAudioQueue.length === 0) {
        this.openAiAudioDonePending = false;
        this.completeAssistantPlayback('openai_response.audio.done');
      }
    }
  }

  private handlePossibleBargeIn(payloadB64: string) {
    // TEMP HOTFIX:
    // Echo yüzünden bot kendi sesini müşteri konuşması sanıp cevabı yarıda kesiyor.
    // Önce akışı stabil hale getirelim; sonra barge-in'i düzgün geri açarız.
    return;

    const rms = pcmuBase64Rms(payloadB64);
    this.lastObservedSpeechEnergy = rms;
    this.updateAmbientNoise(rms);

    if (this.assistantSpeaking) {
      const now = Date.now();
      const playbackElapsedMs = this.assistantStartedAt
        ? now - this.assistantStartedAt
        : 0;
      const protectionRemaining = this.getAssistantProtectionMsRemaining();
      if (
        protectionRemaining > 0 ||
        playbackElapsedMs < this.minPlaybackBargeInMs
      ) {
        this.logBargeInSuppressed(
          protectionRemaining > 0
            ? 'inside_protection_window'
            : 'early_playback_guard',
          `playbackElapsedMs=${playbackElapsedMs} protectionMsRemaining=${protectionRemaining} rms=${this.formatEnergy(rms)}`,
        );
        return;
      }

      this.cancelAssistantAudio('barge_in');
      this.resetAssistantPlaybackState('force_barge_in');
      this.lastBargeInAt = now;
    }

    this.openingGreetingProtectionUntil = 0;
    this.assistantPlaybackProtectionUntil = 0;
    this.speechEnergyFrames = 0;
  }

  private maybeStartOpeningGreeting() {
    const canStart =
      !this.closed &&
      this.sessionReady &&
      this.bridgeReady &&
      !this.hasIntroducedSelf &&
      !this.greetingInFlight &&
      !this.agentTurnInFlight &&
      !this.pendingTranscriptText.trim() &&
      !this.queuedTranscript;

    if (!canStart) {
      if (this.debugVoice || (this.sessionReady && !this.bridgeReady)) {
        this.parentLogger.debug(
          `[voice] opening_greeting_waiting callId=${this.meta.callId} sessionReady=${this.sessionReady} bridgeReady=${this.bridgeReady} greetingInFlight=${this.greetingInFlight} introduced=${this.hasIntroducedSelf} agentTurnInFlight=${this.agentTurnInFlight} pendingTranscript=${this.pendingTranscriptText ? 'yes' : 'no'} queuedTranscript=${this.queuedTranscript ? 'yes' : 'no'}`,
        );
      }
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

  private canPlaybackStaleTurn(turnId: number | undefined, stage: string) {
    if (!turnId || this.isTurnStillActive(turnId)) {
      return true;
    }

    if (this.assistantSpeaking || this.agentTurnInFlight) {
      this.parentLogger.warn(
        `[voice] stale_turn_allowed callId=${this.meta.callId} replyTurnId=${turnId} activeTurnId=${this.activeTurnId} stage=${stage}`,
      );
      return true;
    }

    this.parentLogger.warn(
      `[voice] stale_turn_discarded callId=${this.meta.callId} replyTurnId=${turnId} activeTurnId=${this.activeTurnId} stage=${stage}`,
    );
    return false;
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

    const throttleMs = reason === this.lastBargeInSuppressReason ? 2500 : 1200;
    if (now - this.lastBargeInSuppressLogAt < throttleMs) {
      if (this.debugVoice) {
        this.parentLogger.debug(
          `[voice] barge_in_suppressed callId=${this.meta.callId} reason=${reason}${detail ? ` ${detail}` : ''}`,
        );
      }
      return;
    }

    this.lastBargeInSuppressLogAt = now;
    this.lastBargeInSuppressReason = reason;
    const message = `[voice] barge_in_suppressed callId=${this.meta.callId} reason=${reason}${detail ? ` ${detail}` : ''}`;
    if (this.debugVoice) {
      this.parentLogger.debug(message);
      return;
    }
    this.parentLogger.log(message);
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

    this.sendOpenAi({
      type: 'response.cancel',
    });

    this.parentLogger.log(
      `[voice] assistant output cleared callId=${this.meta.callId} reason=${reason}`,
    );
  }

  private resetAssistantPlaybackState(reason: string) {
    this.outboundAudioQueue = [];
    this.outboundAudioPumpRunning = false;
    this.openAiAudioDonePending = false;

    const hadPlayback =
      this.assistantSpeaking ||
      this.currentPlaybackDurationMs > 0 ||
      this.currentPlaybackOffsetBytes > 0 ||
      this.outboundAudioChunkCount > 0;

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

    this.assistantSpeaking = false;
    this.assistantStartedAt = 0;
    this.currentPlaybackDurationMs = 0;
    this.currentPlaybackOffsetBytes = 0;
    this.currentReplyTurnId = 0;
    this.assistantPlaybackProtectionUntil = 0;
    this.openingGreetingProtectionUntil = 0;
    this.lastObservedSpeechEnergy = 0;
    this.speechEnergyFrames = 0;

    if (hadPlayback) {
      this.parentLogger.log(
        `[voice] playback_state_reset callId=${this.meta.callId} reason=${reason} chunks=${this.outboundAudioChunkCount} bytes=${this.outboundAudioByteCount}`,
      );
    }

    this.outboundAudioChunkCount = 0;
    this.outboundAudioByteCount = 0;
    this.lastChunkSummaryLogAt = 0;
  }

  private markAssistantPlaybackStarted(source: 'openai_realtime') {
    if (this.assistantSpeaking) {
      return;
    }

    this.assistantSpeaking = true;
    this.assistantStartedAt = Date.now();
    this.lastAssistantAudioAt = this.assistantStartedAt;
    this.lastAssistantMessage = normalizeVoiceComparisonText(
      this.lastBotReplyText,
    );

    this.assistantPlaybackProtectionUntil =
      this.assistantStartedAt + this.assistantGuardMs;

    if (this.lastBotReplyText === RealtimeBridgeService.openingGreeting) {
      this.openingGreetingProtectionUntil =
        this.assistantStartedAt + this.openingGreetingBargeInGuardMs;
    }

    this.parentLogger.log(
      `[voice] assistant_playback_started callId=${this.meta.callId} source=${source} turnId=${this.currentReplyTurnId || this.activeTurnId}`,
    );
  }

  private completeAssistantPlayback(reason: string) {
    this.parentLogger.log(
      `[voice] playback_completed callId=${this.meta.callId} reason=${reason} durationMs=${this.currentPlaybackDurationMs} bytesSent=${this.outboundAudioByteCount} chunksSent=${this.outboundAudioChunkCount}`,
    );
    this.lastAssistantAudioAt = Date.now();
    this.resetAssistantPlaybackState(reason);
  }

  private async callAgentBrain(
    userText: string,
    turnId?: number,
  ): Promise<string> {
    const effectiveTurnId = turnId ?? this.activeTurnId;
    // TEMP MVP: pass the normalized transcript directly to the active voice agent path.
    const effectiveUserText = userText;

    this.markTiming('agent_processing_start', {
      turnId: effectiveTurnId,
      inputLength: effectiveUserText.length,
    });

    const rawCaller =
      String(this.meta.from || '').trim() ||
      String(this.meta.callId || '').trim() ||
      'unknown-voice-caller';

    const customerPhone = normalizePhone(rawCaller);

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
      const reply = String(await this.agentService.replyText(payload)).trim();

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
    // TEMP MVP: send the agent reply to OpenAI realtime with only minimal sanitization.
    const clean = sanitizeReplyForVoice(replyText);
    const effectiveTurnId = turnId ?? this.activeTurnId;
    if (!clean || !this.sessionReady) {
      return;
    }
    if (!this.canPlaybackStaleTurn(effectiveTurnId, 'pre_tts')) {
      return;
    }

    if (this.assistantSpeaking) {
      this.cancelAssistantAudio('new_reply');
      this.resetAssistantPlaybackState('cancel_new_reply');
    }

    if (!this.ensureBridgeReady('speak_reply')) {
      this.parentLogger.warn(
        `[voice] playback_skipped callId=${this.meta.callId} reason=bridge_not_ready turnId=${effectiveTurnId}`,
      );
      return;
    }

    this.lastCancellationReason = null;

    const normalizedAssistantMessage = normalizeVoiceComparisonText(clean);
    if (
      normalizedAssistantMessage &&
      normalizedAssistantMessage === this.lastAssistantMessage
    ) {
      this.parentLogger.warn(
        `[voice] duplicate_assistant_message_skipped callId=${this.meta.callId} turnId=${effectiveTurnId} text=${JSON.stringify(clean)}`,
      );
    }

    this.lastBotReplyText = clean;
    this.currentReplyTurnId = effectiveTurnId;
    this.captureRecentContextsFromText(clean, effectiveTurnId, 'assistant');
    this.outboundAudioChunkCount = 0;
    this.outboundAudioByteCount = 0;
    this.lastChunkSummaryLogAt = 0;
    this.currentPlaybackDurationMs = 0;
    this.currentPlaybackOffsetBytes = 0;

    this.parentLogger.log(
      `[voice] final_outgoing_text_before_openai callId=${this.meta.callId} text="${clean}"`,
    );

    if (clean === RealtimeBridgeService.openingGreeting) {
      this.parentLogger.log(
        `[voice] opening_greeting_tts_start callId=${this.meta.callId}`,
      );
    }

    this.responseCreatePending = true;
    this.sendOpenAi({
      type: 'response.create',
      response: {
        audio: {
          output: {
            format: {
              type: 'audio/pcmu',
            },
          },
        },
        instructions: clean,
      },
    });
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

  private sendOpenAi(obj: any) {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
    this.parentLogger.log(
      `[voice][openai_out] callId=${this.meta.callId} payload=${JSON.stringify(obj)}`,
    );
    this.openaiWs.send(JSON.stringify(obj));
  }

  private sendBridge(obj: any) {
    if (this.clientWs.readyState !== WebSocket.OPEN) {
      this.parentLogger.warn(
        `[voice] bridge_send_skipped callId=${this.meta.callId} readyState=${this.clientWs.readyState} event=${String(obj?.event || '-')}`,
      );
      return false;
    }

    this.ensureBridgeReady(`send_${String(obj?.event || 'unknown')}`);
    this.clientWs.send(JSON.stringify(obj));
    return true;
  }

  private bufferInboundAudio(payload: string) {
    const chunkBytes = Math.floor((payload.length * 3) / 4);

    if (this.pendingInputAudio.length >= this.maxPendingInputAudioChunks) {
      const removed = this.pendingInputAudio.shift();
      if (removed) {
        this.pendingInputAudioBytes = Math.max(
          0,
          this.pendingInputAudioBytes - Math.floor((removed.length * 3) / 4),
        );
      }
      this.pendingInputAudioDropped += 1;
    }

    this.pendingInputAudio.push(payload);
    this.pendingInputAudioBytes += chunkBytes;

    while (
      this.pendingInputAudioBytes > this.maxPendingInputAudioBytes &&
      this.pendingInputAudio.length > 0
    ) {
      const removed = this.pendingInputAudio.shift();
      if (!removed) break;
      this.pendingInputAudioBytes = Math.max(
        0,
        this.pendingInputAudioBytes - Math.floor((removed.length * 3) / 4),
      );
      this.pendingInputAudioDropped += 1;
    }

    const now = Date.now();
    if (now - this.lastPendingInputAudioLogAt >= 2000) {
      this.lastPendingInputAudioLogAt = now;
      this.parentLogger.warn(
        `[voice] media_buffering_before_session_ready callId=${this.meta.callId} queued=${this.pendingInputAudio.length} dropped=${this.pendingInputAudioDropped} sessionCreated=${this.sessionCreated}`,
      );
    }
  }

  private appendInputAudio(payload: string) {
    this.handlePossibleBargeIn(payload);
    this.refreshSpeechFailsafe();
    this.sendOpenAi({
      type: 'input_audio_buffer.append',
      audio: payload,
    });
  }

  private flushPendingInputAudio(reason: string) {
    if (!this.pendingInputAudio.length) return;

    const buffered = [...this.pendingInputAudio];
    const bufferedBytes = this.pendingInputAudioBytes;
    const dropped = this.pendingInputAudioDropped;

    this.pendingInputAudio = [];
    this.pendingInputAudioBytes = 0;
    this.pendingInputAudioDropped = 0;

    this.parentLogger.log(
      `[voice] media_buffer_flush callId=${this.meta.callId} reason=${reason} chunks=${buffered.length} bytes=${bufferedBytes} dropped=${dropped}`,
    );

    for (const chunk of buffered) {
      this.appendInputAudio(chunk);
    }
  }

  private resetSessionState(reason: string) {
    this.sessionReady = false;
    this.sessionCreated = false;
    this.responseCreatePending = false;
    this.pendingInputAudio = [];
    this.pendingInputAudioBytes = 0;
    this.pendingInputAudioDropped = 0;
    this.lastPendingInputAudioLogAt = 0;
    this.bridgeReady = false;
    this.greetingInFlight = false;
    this.greeted = false;
    this.agentTurnInFlight = false;
    this.pendingTranscriptText = '';
    this.pendingTranscriptState = null;
    this.queuedTranscript = null;
    if (this.pendingTranscriptTimer) {
      clearTimeout(this.pendingTranscriptTimer);
      this.pendingTranscriptTimer = null;
    }
    if (this.speechFailsafeTimer) {
      clearTimeout(this.speechFailsafeTimer);
      this.speechFailsafeTimer = null;
    }
    this.cancelAssistantAudio('close');
    this.resetAssistantPlaybackState(reason);
  }

  private handleOpenAiServerError(code: string) {
    this.parentLogger.warn(
      `[voice] session_reset_after_openai_error callId=${this.meta.callId} code=${code}`,
    );
    this.resetSessionState(`openai_${code}`);

    try {
      if (this.openaiWs) {
        this.openaiWs.removeAllListeners();
        if (this.openaiWs.readyState === WebSocket.OPEN) {
          this.openaiWs.close();
        } else if (this.openaiWs.readyState === WebSocket.CONNECTING) {
          this.openaiWs.terminate();
        }
      }
    } catch {}
    this.openaiWs = null;
    this.safeClose();
  }

  private safeClose() {
    if (this.closed) return;
    this.closed = true;

    this.resetSessionState('cancel_close');

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

export function shortenReplyForPhone(text: string) {
  const original = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = original.replace(/\s+/g, ' ').trim();
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
  if (
    /\b(nasil|nasıl|hangi|ne zaman|neden|icin|için|fiyat|ucret|ücret|saat|adres|randevu|rezervasyon|yardimci|yardımcı)\b/i.test(
      text,
    )
  ) {
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
