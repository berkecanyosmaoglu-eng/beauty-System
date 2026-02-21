import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';

/**
 * Twilio message payload type. Media events carry base64 encoded μ-law audio
 * while start/stop notify the stream SID.
 */
type TwilioMsg =
  | { event: 'connected' }
  | {
      event: 'start';
      start: {
        streamSid: string;
        callSid?: string;
        customParameters?: Record<string, string>;
      };
    }
  | { event: 'media'; streamSid: string; media: { payload: string } }
  | { event: 'stop'; streamSid: string };

type SessionState = {
  key: string; // internal map key
  tenantId: string;
  closed: boolean;
  aiHasActiveResponse: boolean;

  // Twilio WS
  twilio?: WebSocket;
  streamSid?: string;
  twilioFrames: number;

  // OpenAI WS
  openai?: WebSocket;
  openaiReady: boolean;
  openaiAppends: number;
  openaiDeltas: number;
  openaiLastError?: string;

  // "How much audio since last commit?"
  lastCommittedAppends: number;

  /**
   * Accumulates the total duration (in milliseconds) of audio appended
   * since the last time we successfully committed the buffer. This is
   * calculated from the size of incoming Twilio media frames. OpenAI
   * requires at least ~100 ms of audio to commit; tracking ms directly
   * avoids committing an empty buffer when openaiAppends has advanced
   * but the buffer has been cleared.
   */
  appendedMsSinceCommit: number;

  // Barge-in flags
  aiSpeaking: boolean;
  responseInProgress: boolean;

  // Debounce
  lastResponseCreateAt: number;

  // Greet once
  greeted: boolean;
};

@Injectable()
export class RealtimeBridgeService {
  private readonly logger = new Logger(RealtimeBridgeService.name);
  private readonly sessions = new Map<string, SessionState>();

  // OpenAI realtime endpoint + model query param
  private readonly openaiUrl =
    process.env.OPENAI_REALTIME_URL ||
    'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';

  private readonly apiKey = process.env.OPENAI_API_KEY || '';

  /**
   * main.ts içindeki raw WS upgrade handler burayı çağırıyor.
   * - ws: Twilio Media Stream WebSocket
   * - requestUrl: örn "/bot/stream?tenantId=xxx"
   */
  handleTwilioWebSocket(ws: WebSocket, requestUrl: string) {
    const tenantIdFromQuery = this.getQueryParam(requestUrl, 'tenantId') || '';
    const tenantId = tenantIdFromQuery || 'default';

    // IMPORTANT: do NOT key sessions only by tenantId (parallel calls collide)
    const tempKey = `tmp:${tenantId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

    const state: SessionState = {
      key: tempKey,
      tenantId,
      closed: false,
      twilio: ws,
      twilioFrames: 0,

      openaiReady: false,
      openaiAppends: 0,
      openaiDeltas: 0,
      lastCommittedAppends: 0,
      appendedMsSinceCommit: 0,

      // Initialize barge-in tracking flag. This flag is true only while an audio delta is in-flight
      // and ensures we call response.cancel only when there is an active response.
      aiHasActiveResponse: false,

      aiSpeaking: false,
      responseInProgress: false,
      lastResponseCreateAt: 0,

      greeted: false,
    };

    this.sessions.set(tempKey, state);

    this.logger.log(`WS CONNECT url=${requestUrl} tenantId(query)=${tenantIdFromQuery || '-'}`);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as TwilioMsg;

        if (msg.event === 'start') {
          const streamSid = msg.start?.streamSid;
          const tenantIdFromStart = msg.start?.customParameters?.tenantId || '';
          const finalTenantId = tenantIdFromStart || tenantId;

          state.tenantId = finalTenantId;
          state.streamSid = streamSid;

          // Move session key to stable streamSid-based key
          const newKey = `sid:${finalTenantId}:${streamSid}`;
          this.sessions.delete(state.key);
          state.key = newKey;
          this.sessions.set(newKey, state);

          this.logger.log(
            `Twilio start tenantId=${state.tenantId} streamSid=${streamSid} customTenant=${tenantIdFromStart || '-'}`
          );

          // OpenAI socket’i hazırla
          this.ensureOpenAI(state.key);
          return;
        }

        if (msg.event === 'media') {
          state.twilioFrames++;

          // Calculate the duration of this audio chunk. Twilio media
          // messages carry base64 encoded μ-law at 8 kHz with 1 byte per sample.
          try {
            const payload = msg.media?.payload || '';
            const byteLen = Buffer.from(payload, 'base64').length;
            // Convert samples to milliseconds. 8k samples per second.
            const ms = Math.round((byteLen / 8000) * 1000);
            state.appendedMsSinceCommit += ms;
          } catch (err) {
            // ignore errors when computing duration
          }

          // OpenAI hazır olunca audio append et
          if (state.openai && state.openaiReady) {
            state.openai.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload, // base64 g711_ulaw
              })
            );
            state.openaiAppends++;
          }

          if (state.twilioFrames === 1 || state.twilioFrames % 200 === 0) {
            this.logger.log(
              `Twilio media tenantId=${state.tenantId} frames=${state.twilioFrames} openaiReady=${state.openaiReady} appends=${state.openaiAppends}`
            );
          }

          return;
        }

        if (msg.event === 'stop') {
          this.detach(state.key, 'twilio-stop');
          return;
        }
      } catch (e: any) {
        this.logger.error(`twilio message parse error: ${e?.message || e}`);
      }
    });

    ws.on('close', () => this.detach(state.key, 'twilio-close'));
    ws.on('error', (e) => this.detach(state.key, `twilio-error:${(e as any)?.message || e}`));
  }

  // --------------------------
  // OpenAI realtime
  // --------------------------

  private ensureOpenAI(sessionKey: string) {
    const state = this.sessions.get(sessionKey);
    if (!state || state.closed) return;

    if (!this.apiKey) {
      state.openaiLastError = 'OPENAI_API_KEY missing';
      this.logger.error(`OpenAI key missing. sessionKey=${sessionKey}`);
      return;
    }

    if (
      state.openai &&
      (state.openai.readyState === WebSocket.OPEN || state.openai.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(this.openaiUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    state.openai = ws;
    state.openaiReady = false;

    ws.on('open', () => {
      state.openaiReady = true;
      this.logger.log(`OpenAI WS connected tenantId=${state.tenantId} sessionKey=${sessionKey}`);

      // ===============================
      // 🔥 VOICE AYARI
      // ===============================
      const VOICE = 'cedar';

      // VAD tuning: less trigger-happy
      const sessionUpdate = {
        type: 'session.update',
        session: {
          model: 'gpt-realtime-mini',
          modalities: ['audio', 'text'],
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,

          // VAD + barge-in
          turn_detection: {
            type: 'server_vad',
            prefix_padding_ms: 250,
            silence_duration_ms: 450,
            create_response: false, // we trigger manually
            interrupt_response: true,
          },

          instructions:
            'Sen sadece bir güzellik merkezi randevu asistanısın. Türkçe konuş. ' +
            'Konuşmaya "Merhaba, Güzellik Merkezi’ne hoş geldiniz. Size nasıl yardımcı olabilirim?" diye başla. ' +
            'Sadece hizmetler, fiyat bilgisi (genel), uygunluk, randevu alma, saat-tarih, şube, adres ve iletişim konularında konuş. ' +
            'Konu güzellik merkezi dışına çıkarsa kısa şekilde tekrar randevu konusuna yönlendir: ' +
            '"Bu hatta sadece randevu ve hizmet bilgisi verebilirim. Hangi işlem için randevu istiyorsunuz?" ' +
            'Cevaplar 1-2 cümle, net ve premium tonda olsun.',
        },
      };

      this.logger.log(`[RealtimeBridgeService] session.update tenantId=${state.tenantId} voice=${VOICE}`);
      ws.send(JSON.stringify(sessionUpdate));

      // ✅ Greeting: DO NOT commit empty audio buffer.
      // Instead: create a conversation item and ask for audio response.
      if (!state.greeted) {
        state.greeted = true;
        state.responseInProgress = true;
        state.lastResponseCreateAt = Date.now();

        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Merhaba.',
                },
              ],
            },
          })
        );

        ws.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions:
                'Görüşmeyi sen başlat. Tek cümle: "Merhaba, Güzellik Merkezi’ne hoş geldiniz. Size nasıl yardımcı olabilirim?"',
            },
          })
        );

        this.logger.log(`response.create (greeting) tenantId=${state.tenantId}`);
      }
    });

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const t = msg?.type;

      if (
        t === 'error' ||
        t === 'session.created' ||
        t === 'session.updated' ||
        t === 'input_audio_buffer.speech_started' ||
        t === 'input_audio_buffer.speech_stopped'
      ) {
        this.logger.log(`OpenAI event tenantId=${state?.tenantId || '-'} type=${t}`);
      }

      if (t === 'error') {
        const em = msg?.error?.message || JSON.stringify(msg);
        this.logger.error(`OpenAI error tenantId=${state?.tenantId || '-'}: ${em}`);
        const s = this.sessions.get(sessionKey);
        if (s) {
          s.openaiLastError = em;
          // If buffer too small, clear to avoid repeated failures
          s.openai?.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          // Reset counters because the buffer has been cleared due to an error
          s.appendedMsSinceCommit = 0;
          s.lastCommittedAppends = s.openaiAppends;
          s.responseInProgress = false;
          s.aiSpeaking = false;
          s.aiHasActiveResponse = false;
        }
        return;
      }

      const s = this.sessions.get(sessionKey);
      if (!s || s.closed) return;

      // BARGE-IN: user started speaking while AI speaking -> cancel + clear
if (t === 'input_audio_buffer.speech_started') {
  const s = this.sessions.get(sessionKey);
  if (!s || s.closed) return;

  // 🔥 KRİTİK: yeni konuşma başlarken referansları sıfırla
  s.lastCommittedAppends = s.openaiAppends;
  // Reset accumulated ms since commit because the buffer will be cleared
  s.appendedMsSinceCommit = 0;

if (s.aiSpeaking && s.aiHasActiveResponse) {
  this.logger.log(`[BARGE-IN] speech_started -> cancel+clear tenantId=${s.tenantId}`);
  s.openai?.send(JSON.stringify({ type: 'response.cancel' }));
} else {
  this.logger.log(`[BARGE-IN] speech_started -> clear-only (no active response) tenantId=${s.tenantId}`);
}
s.openai?.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
if (s.twilio && s.streamSid) {
  s.twilio.send(JSON.stringify({ event: 'clear', streamSid: s.streamSid }));
}
s.aiSpeaking = false;
s.responseInProgress = false;
s.aiHasActiveResponse = false;
return;
}

      // User stopped speaking -> create response ONLY if we have enough audio
      if (t === 'input_audio_buffer.speech_stopped') {
        // If the OpenAI socket isn't ready, do nothing.
        if (!s.openai || !s.openaiReady) return;
        // Avoid overlapping responses
        if (s.responseInProgress) {
          this.logger.log(`response.create skipped (already in progress) tenantId=${s.tenantId}`);
          return;
        }

        const now = Date.now();
        // Debounce successive response.create calls
        if (now - s.lastResponseCreateAt < 900) return;

        // Attempt to commit the buffer. This will clear the buffer and skip
        // committing if there isn't enough audio accumulated (see
        // tryCommitInput for details). When it returns false we abort.
        const committed = this.tryCommitInput(s, 'speech_stopped');
        if (!committed) {
          return;
        }

        // We have successfully committed the buffer; begin generating a response.
        s.responseInProgress = true;
        s.lastResponseCreateAt = now;
        s.openai?.send(JSON.stringify({ type: 'response.create' }));
        this.logger.log(`response.create tenantId=${s.tenantId}`);
        return;
      }

      // Response done -> reset flags
      if (
        t === 'response.done' ||
        t === 'response.audio.done' ||
        t === 'response.output_audio.done' ||
        t === 'response.end'
      ) {
s.aiSpeaking = false;
s.responseInProgress = false;
s.aiHasActiveResponse = false;
      return;
      }

      // OpenAI audio delta -> forward to Twilio
      if (t === 'response.audio.delta' || t === 'response.output_audio.delta') {
        const delta = msg?.delta;
             
       s.aiHasActiveResponse = true;
s.aiSpeaking = true;

        if (typeof delta === 'string' && s.twilio && s.streamSid) {
          s.openaiDeltas++;

          s.twilio.send(
            JSON.stringify({
              event: 'media',
              streamSid: s.streamSid,
              media: { payload: delta },
            })
          );

          if (s.openaiDeltas === 1 || s.openaiDeltas % 50 === 0) {
            this.logger.log(
              `OpenAI audio.delta tenantId=${s.tenantId} deltas=${s.openaiDeltas} twilioFrames=${s.twilioFrames}`
            );
          }
        }
        return;
      }
    });

    ws.on('close', () => this.detach(sessionKey, 'openai-close'));
    ws.on('error', (e) => this.detach(sessionKey, `openai-error:${(e as any)?.message || e}`));
  }

  // --------------------------
  // Helpers / cleanup
  // --------------------------

  private detach(sessionKey: string, reason: string) {
    const state = this.sessions.get(sessionKey);
    if (!state || state.closed) return;

    state.closed = true;

    this.logger.warn(
      `Bridge close tenantId=${state.tenantId} sessionKey=${sessionKey} reason=${reason} twilioFrames=${state.twilioFrames} openaiAppends=${state.openaiAppends} openaiDeltas=${state.openaiDeltas} openaiErr=${state.openaiLastError || '-'}`
    );

    try {
      state.openai?.close();
    } catch {}
    try {
      state.twilio?.close();
    } catch {}

    this.sessions.delete(sessionKey);
  }

  private getQueryParam(url: string, key: string): string | null {
    const idx = url.indexOf('?');
    if (idx === -1) return null;
    const qs = url.slice(idx + 1);
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (k === key) return decodeURIComponent(v || '');
    }
    return null;
  }

  /**
   * Try to commit the current OpenAI input audio buffer. OpenAI requires
   * at least ~100 ms of audio to be present; committing less will return
   * a `buffer too small` error. This helper checks the accumulated
   * appendedMsSinceCommit on the session state and either commits and
   * resets counters, or clears the buffer and skips committing if there
   * isn't enough audio. The caller can decide whether to proceed with
   * creating a response based on the return value.
   *
   * @param session Session state for which the commit should run.
   * @param reason  Human-readable reason used in logs.
   * @returns `true` if a commit was performed; otherwise `false`.
   */
private tryCommitInput(session: SessionState, reason: string): boolean {
  const ms = session.appendedMsSinceCommit || 0;

  if (ms < 100) {
    this.logger.warn(
      `[RealtimeBridgeService] skip create_response (<100ms) why=${reason} ms=${ms} tenantId=${session.tenantId}`,
    );
    // Short blips -> reset local counters; also clear to avoid stuck VAD
    session.openai?.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
    session.appendedMsSinceCommit = 0;
    session.lastCommittedAppends = session.openaiAppends;
    return false;
  }

  // IMPORTANT: server_vad already segments internally. DO NOT commit here.
  session.appendedMsSinceCommit = 0;
  session.lastCommittedAppends = session.openaiAppends;

  this.logger.log(
    `[RealtimeBridgeService] ok for response.create why=${reason} ms=${ms} tenantId=${session.tenantId}`,
  );
  return true;
}
}
