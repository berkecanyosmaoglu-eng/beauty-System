import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { AgentService } from '../agent/agent.service';

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

@Injectable()
export class RealtimeBridgeService {
  private readonly logger = new Logger(RealtimeBridgeService.name);

  constructor(private readonly agentService: AgentService) {}

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

  private lastAssistantAudioAt = 0;
  private assistantSpeaking = false;
  private assistantStartedAt = 0;
  private activeResponse = false;

  private speechEnergyFrames = 0;
  private readonly speechEnergyThreshold = 1700;
  private readonly speechFramesForBargeIn = 3;
  private readonly assistantGuardMs = 120;

  private lastTranscriptAt = 0;
  private lastTranscriptText = '';
  private lastTranscriptNorm = '';
  private lastBotReplyText = '';
  private lastBargeInAt = 0;
  private lastSpeechStoppedAt = 0;

  private playbackToken = 0;
  private playbackTimer: NodeJS.Timeout | null = null;
  private currentTtsAbort: AbortController | null = null;

  // 20ms @ 8kHz μ-law = 160 bytes
  private readonly ulawFrameBytes = 160;
  private readonly ulawFrameMs = 20;

  private readonly ghostRegex =
    /^(ad[ií]os|bye|bye-bye|thank you|thank you very much|all y['’]all|hallo|hello|alo)\.?$/i;

  constructor(
    private readonly agentService: AgentService,
    private readonly parentLogger: Logger,
    private readonly clientWs: WebSocket,
    private readonly meta: BridgeMeta,
  ) {
    const model =
      process.env.JARVIS_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    this.openaiUrl =
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  }

  start() {
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
          threshold: 0.62,
          prefix_padding_ms: 140,
          silence_duration_ms: 180,
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
        this.parentLogger.log(
          `[voice] session.created callId=${this.meta.callId}`,
        );
        return;

      case 'session.updated':
        this.sessionReady = true;
        this.parentLogger.log(
          `[voice] session.updated callId=${this.meta.callId}`,
        );

        if (!this.greeted) {
          this.greeted = true;
          const openingGreeting =
            'Merhaba, ben işletmenin sesli asistanıyım. Size nasıl yardımcı olabilirim?';
          this.parentLogger.log(
            `[voice] opening_greeting callId=${this.meta.callId} text="${openingGreeting}"`,
          );
          await this.speakReply(openingGreeting);
        }
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
        this.parentLogger.log(
          `[voice] ${evt.type} callId=${this.meta.callId}`,
        );
        return;

      case 'conversation.item.input_audio_transcription.completed': {
        const rawTranscript = String(evt.transcript || '').trim();
        if (!rawTranscript) return;

        if (this.shouldDropTranscript(rawTranscript)) {
          this.parentLogger.warn(
            `[voice] dropped transcript callId=${this.meta.callId} text="${rawTranscript}"`,
          );
          return;
        }

        const transcript = normalizeTranscriptForAgent(
          rawTranscript,
          this.lastBotReplyText,
        );

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

        this.parentLogger.log(
          `[voice] transcript normalized callId=${this.meta.callId} raw="${rawTranscript}" normalized="${transcript}"`,
        );

        const reply = await this.callAgentBrain(transcript);
        if (!reply) return;

        await this.speakReply(reply);
        return;
      }

      case 'input_audio_buffer.speech_started':
        this.parentLogger.log(
          `[voice] speech_started callId=${this.meta.callId}`,
        );
        this.lastBargeInAt = Date.now();
        // Aggressive barge-in: stop any queued playback immediately.
        this.cancelAssistantAudio('speech_started');
        return;

      case 'input_audio_buffer.speech_stopped':
        this.lastSpeechStoppedAt = Date.now();
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

  private shouldDropTranscript(text: string) {
    const normalized = text.trim();

    if (!normalized) return true;
    if (normalized.length <= 1) return true;
    if (this.ghostRegex.test(normalized)) return true;

    const now = Date.now();
    const msSinceAssistantAudio = now - this.lastAssistantAudioAt;
    const msSinceBargeIn = now - this.lastBargeInAt;
    const msSinceSpeechStopped = now - this.lastSpeechStoppedAt;

    if (msSinceBargeIn < 180 && normalized.length < 18) return true;
    if (msSinceSpeechStopped > 0 && msSinceSpeechStopped < 120 && normalized.length < 3) return true;

    if (msSinceAssistantAudio < 280 && normalized.length < 16) {
      return true;
    }

    if (
      normalized.toLowerCase() === this.lastTranscriptText.toLowerCase() &&
      now - this.lastTranscriptAt < 1400
    ) {
      return true;
    }

    return false;
  }

  private handlePossibleBargeIn(payloadB64: string) {
    if (!this.assistantSpeaking) {
      this.speechEnergyFrames = 0;
      return;
    }

    const now = Date.now();
    if (now - this.assistantStartedAt < this.assistantGuardMs) {
      this.speechEnergyFrames = 0;
      return;
    }

    const rms = pcmuBase64Rms(payloadB64);

    if (rms >= this.speechEnergyThreshold) {
      this.speechEnergyFrames += 1;
    } else {
      this.speechEnergyFrames = 0;
    }

    if (this.speechEnergyFrames >= this.speechFramesForBargeIn) {
      this.parentLogger.warn(
        `[voice] barge-in detected callId=${this.meta.callId} rms=${rms.toFixed(0)}`,
      );
      this.lastBargeInAt = Date.now();
      this.cancelAssistantAudio('barge_in');
      this.speechEnergyFrames = 0;
    }
  }

  private shouldPassInboundDuringAssistant(payloadB64: string) {
    const rms = pcmuBase64Rms(payloadB64);
    return rms >= this.speechEnergyThreshold;
  }

  private cancelAssistantAudio(
    reason: 'barge_in' | 'speech_started' | 'new_reply' | 'close' = 'new_reply',
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
  }

  private async callAgentBrain(userText: string): Promise<string> {
    const greeting = this.buildDeterministicGreetingReply(userText);
    if (greeting) {
      this.parentLogger.log(
        `[voice] deterministic_greeting callId=${this.meta.callId} text="${greeting}"`,
      );
      return greeting;
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
      text: userText,
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
          'AgentService üzerinde kullanılabilir bir public entrypoint bulunamadı',
        );
      }

      const reply = extractReplyText(result);

      this.parentLogger.log(
        `[voice] agent reply callId=${this.meta.callId} customerPhone=${customerPhone} reply="${reply}"`,
      );

      return (
        reply ||
        'Üzgünüm, şu an uygun bir yanıt oluşturamadım. Tekrar söyler misiniz?'
      );
    } catch (err: any) {
      this.parentLogger.error(
        `[voice] AgentService error callId=${this.meta.callId}: ${
          err?.stack || err?.message || err
        }`,
      );
      return 'Üzgünüm, kısa bir teknik aksaklık oldu. Tekrar söyler misiniz?';
    }
  }

  private async speakReply(replyText: string) {
    const openingGreeting =
      'Merhaba, ben işletmenin sesli asistanıyım. Size nasıl yardımcı olabilirim?';
    const rewritten = rewriteAgentReplyForVoice(replyText);
    const spoken =
      rewritten === openingGreeting ? openingGreeting : shortenReplyForPhone(rewritten);
    const clean = sanitizeReplyForVoice(spoken);
    if (!clean || !this.sessionReady) return;

    // Interrupt any previous playback before starting the next answer.
    if (this.assistantSpeaking || this.activeResponse) {
      this.cancelAssistantAudio('new_reply');
    }

    this.lastBotReplyText = clean;
    this.assistantSpeaking = true;
    this.assistantStartedAt = Date.now();

    this.parentLogger.log(
      `[voice] final_outgoing_text_before_elevenlabs callId=${this.meta.callId} text="${clean}"`,
    );

    try {
      const token = ++this.playbackToken;
      const audioBuffer = await this.generateElevenLabsAudio(clean);

      if (audioBuffer && token === this.playbackToken) {
        this.parentLogger.log(
          `[voice] ElevenLabs success callId=${this.meta.callId} bytes=${audioBuffer.length}`,
        );
        this.streamUlawBuffer(audioBuffer, token);
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
      `[voice] elevenlabs_unavailable_skip_tts callId=${this.meta.callId}`,
    );
  }

  private async generateElevenLabsAudio(
    text: string,
  ): Promise<Buffer | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) {
      this.parentLogger.error(
        '[voice] ElevenLabs API key or voice ID missing',
      );
      return null;
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
              speed: 1.08,
            },
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const bodyText = await response.text();
        this.parentLogger.error(
          `[voice] ElevenLabs TTS error: ${response.status} ${bodyText}`,
        );
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.parentLogger.warn(
          `[voice] ElevenLabs synthesis aborted callId=${this.meta.callId} reason=barge_in_or_cancel`,
        );
        return null;
      }
      this.parentLogger.error(`[voice] ElevenLabs TTS error: ${err}`);
      return null;
    } finally {
      if (this.currentTtsAbort === controller) {
        this.currentTtsAbort = null;
      }
    }
  }

  private buildDeterministicGreetingReply(userText: string): string | null {
    const t = normalizeTurkishForTime(userText);
    if (!t) return null;
    if (/^(merhaba|selam|iyi gunler|iyi aksamlar|gunaydin|alo)[.!? ]*$/.test(t)) {
      return 'Merhaba, nasıl yardımcı olabilirim?';
    }
    return null;
  }

  private streamUlawBuffer(buf: Buffer, token: number) {
    if (!buf.length || token !== this.playbackToken) return;

    let offset = 0;
    const tick = () => {
      if (this.closed) return;
      if (token !== this.playbackToken) return;

      if (!this.assistantSpeaking) return;

      const chunk = buf.subarray(offset, offset + this.ulawFrameBytes);
      if (!chunk.length) {
        this.assistantSpeaking = false;
        this.playbackTimer = null;
        return;
      }

      this.lastAssistantAudioAt = Date.now();

      this.sendBridge({
        event: 'media',
        media: { payload: chunk.toString('base64') },
      });

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

  private safeClose() {
    if (this.closed) return;
    this.closed = true;

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

function normalizeTranscriptForAgent(
  raw: string,
  lastBotReplyText: string,
): string {
  let text = String(raw || '').trim();

  text = text
    .replace(/[“”"']/g, '')
    .replace(/[،,;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const lastBot = String(lastBotReplyText || '').toLocaleLowerCase('tr-TR');

  if (
    /^evet[.!]*$/i.test(text) ||
    /^onayl[ıi]yorum[.!]*$/i.test(text) ||
    /^tamam[.!]*$/i.test(text)
  ) {
    return 'evet';
  }

  if (
    /^hay[ıi]r[.!]*$/i.test(text) ||
    /^istemiyorum[.!]*$/i.test(text)
  ) {
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

  const askedStaff =
    lastBot.includes('hangi personel') ||
    lastBot.includes('kiminle olsun') ||
    lastBot.includes('isim söyleyebilirsiniz');
  if (askedStaff) {
    return text
      .replace(/\bhan[ıi]m\b/gi, '')
      .replace(/\bbey\b/gi, '')
      .replace(/[.!?]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/[_`#]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[•·]/g, ' ')
    .replace(/[“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function rewriteAgentReplyForVoice(replyText: string) {
  let text = String(replyText || '').trim();
  const lower = text.toLocaleLowerCase('tr-TR');

  text = text
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\*\*/g, '')
    .replace(/[_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  text = text.replace(/yazar mısınız/gi, 'söyler misiniz');
  text = text.replace(/yazar misiniz/gi, 'söyler misiniz');
  text = text.replace(/\(E\/H\)/gi, '');
  text = text.replace(/\bE\/H\b/gi, '');

  if (lower.startsWith('randevu özeti:')) {
    return 'Randevu bilgileri doğruysa onaylıyor musunuz?';
  }

  if (
    lower.includes('kiminle olsun') ||
    lower.includes('hangi personeli')
  ) {
    return 'Hangi personeli tercih edersiniz? İsim söyleyebilirsiniz ya da fark etmez diyebilirsiniz.';
  }

  if (lower.includes('o saat dolu') || lower.includes('şunlar uygun')) {
    const slots = [
      ...text.matchAll(/\b(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\b/g),
    ].slice(0, 3);

    if (slots.length) {
      const spoken = slots.map((m) => naturalTimeSpeech(m[2])).join(', ');
      return `O saat dolu. En yakın uygun saatler ${spoken}. Başka bir saat de söyleyebilirsiniz.`;
    }

    return 'O saat dolu. Yakın bir saat söyleyebilir misiniz?';
  }

  if (
    lower.includes('randevu tamam') ||
    lower.includes('randevunuz oluşturuldu') ||
    lower.includes('kayıt:')
  ) {
    const m = text.match(/\b(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\b/);
    if (m) return `Randevunuz onaylandı. ${m[1]} ${naturalTimeSpeech(m[2])}.`;
    return 'Randevunuz onaylandı.';
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

  return text;
}

function shortenReplyForPhone(text: string) {
  let out = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return out;

  const numberedItems = [...out.matchAll(/\b\d\)\s*[^\n]+/g)];
  if (numberedItems.length > 2) {
    return `Toplam ${numberedItems.length} seçenek var. İstersen ilk iki uygun olanı söyleyebilirim.`;
  }

  if (out.length > 220) {
    const short = out.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
    out = short || out.slice(0, 220);
  }

  return out.replace(/\s{2,}/g, ' ').trim();
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
