"use strict";
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeBridgeService = void 0;
var common_1 = require("@nestjs/common");
var ws_1 = require("ws");
var RealtimeBridgeService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var RealtimeBridgeService = _classThis = /** @class */ (function () {
        function RealtimeBridgeService_1() {
            this.logger = new common_1.Logger(RealtimeBridgeService.name);
            this.sessions = new Map();
            // OpenAI realtime endpoint + model query param
            this.openaiUrl = process.env.OPENAI_REALTIME_URL ||
                'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
            this.apiKey = process.env.OPENAI_API_KEY || '';
        }
        /**
         * main.ts içindeki raw WS upgrade handler burayı çağırıyor.
         * - ws: Twilio Media Stream WebSocket
         * - requestUrl: örn "/bot/stream?tenantId=xxx"
         */
        RealtimeBridgeService_1.prototype.handleTwilioWebSocket = function (ws, requestUrl) {
            var _this = this;
            var tenantIdFromQuery = this.getQueryParam(requestUrl, 'tenantId') || '';
            var tenantId = tenantIdFromQuery || 'default';
            // IMPORTANT: do NOT key sessions only by tenantId (parallel calls collide)
            var tempKey = "tmp:".concat(tenantId, ":").concat(Date.now(), ":").concat(Math.random().toString(16).slice(2));
            var state = {
                key: tempKey,
                tenantId: tenantId,
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
            this.logger.log("WS CONNECT url=".concat(requestUrl, " tenantId(query)=").concat(tenantIdFromQuery || '-'));
            ws.on('message', function (raw) {
                var _a, _b, _c, _d;
                try {
                    var msg = JSON.parse(String(raw));
                    if (msg.event === 'start') {
                        var streamSid = (_a = msg.start) === null || _a === void 0 ? void 0 : _a.streamSid;
                        var tenantIdFromStart = ((_c = (_b = msg.start) === null || _b === void 0 ? void 0 : _b.customParameters) === null || _c === void 0 ? void 0 : _c.tenantId) || '';
                        var finalTenantId = tenantIdFromStart || tenantId;
                        state.tenantId = finalTenantId;
                        state.streamSid = streamSid;
                        // Move session key to stable streamSid-based key
                        var newKey = "sid:".concat(finalTenantId, ":").concat(streamSid);
                        _this.sessions.delete(state.key);
                        state.key = newKey;
                        _this.sessions.set(newKey, state);
                        _this.logger.log("Twilio start tenantId=".concat(state.tenantId, " streamSid=").concat(streamSid, " customTenant=").concat(tenantIdFromStart || '-'));
                        // OpenAI socket’i hazırla
                        _this.ensureOpenAI(state.key);
                        return;
                    }
                    if (msg.event === 'media') {
                        state.twilioFrames++;
                        // Calculate the duration of this audio chunk. Twilio media
                        // messages carry base64 encoded μ-law at 8 kHz with 1 byte per sample.
                        try {
                            var payload = ((_d = msg.media) === null || _d === void 0 ? void 0 : _d.payload) || '';
                            var byteLen = Buffer.from(payload, 'base64').length;
                            // Convert samples to milliseconds. 8k samples per second.
                            var ms = Math.round((byteLen / 8000) * 1000);
                            state.appendedMsSinceCommit += ms;
                        }
                        catch (err) {
                            // ignore errors when computing duration
                        }
                        // OpenAI hazır olunca audio append et
                        if (state.openai && state.openaiReady) {
                            state.openai.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: msg.media.payload, // base64 g711_ulaw
                            }));
                            state.openaiAppends++;
                        }
                        if (state.twilioFrames === 1 || state.twilioFrames % 200 === 0) {
                            _this.logger.log("Twilio media tenantId=".concat(state.tenantId, " frames=").concat(state.twilioFrames, " openaiReady=").concat(state.openaiReady, " appends=").concat(state.openaiAppends));
                        }
                        return;
                    }
                    if (msg.event === 'stop') {
                        _this.detach(state.key, 'twilio-stop');
                        return;
                    }
                }
                catch (e) {
                    _this.logger.error("twilio message parse error: ".concat((e === null || e === void 0 ? void 0 : e.message) || e));
                }
            });
            ws.on('close', function () { return _this.detach(state.key, 'twilio-close'); });
            ws.on('error', function (e) { return _this.detach(state.key, "twilio-error:".concat((e === null || e === void 0 ? void 0 : e.message) || e)); });
        };
        // --------------------------
        // OpenAI realtime
        // --------------------------
        RealtimeBridgeService_1.prototype.ensureOpenAI = function (sessionKey) {
            var _this = this;
            var state = this.sessions.get(sessionKey);
            if (!state || state.closed)
                return;
            if (!this.apiKey) {
                state.openaiLastError = 'OPENAI_API_KEY missing';
                this.logger.error("OpenAI key missing. sessionKey=".concat(sessionKey));
                return;
            }
            if (state.openai &&
                (state.openai.readyState === ws_1.default.OPEN || state.openai.readyState === ws_1.default.CONNECTING)) {
                return;
            }
            var ws = new ws_1.default(this.openaiUrl, {
                headers: {
                    Authorization: "Bearer ".concat(this.apiKey),
                    'OpenAI-Beta': 'realtime=v1',
                },
            });
            state.openai = ws;
            state.openaiReady = false;
            ws.on('open', function () {
                state.openaiReady = true;
                _this.logger.log("OpenAI WS connected tenantId=".concat(state.tenantId, " sessionKey=").concat(sessionKey));
                // ===============================
                // 🔥 VOICE AYARI
                // ===============================
                var VOICE = 'cedar';
                // VAD tuning: less trigger-happy
                var sessionUpdate = {
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
                        instructions: 'Sen sadece bir güzellik merkezi randevu asistanısın. Türkçe konuş. ' +
                            'Konuşmaya "Merhaba, Güzellik Merkezi’ne hoş geldiniz. Size nasıl yardımcı olabilirim?" diye başla. ' +
                            'Sadece hizmetler, fiyat bilgisi (genel), uygunluk, randevu alma, saat-tarih, şube, adres ve iletişim konularında konuş. ' +
                            'Konu güzellik merkezi dışına çıkarsa kısa şekilde tekrar randevu konusuna yönlendir: ' +
                            '"Bu hatta sadece randevu ve hizmet bilgisi verebilirim. Hangi işlem için randevu istiyorsunuz?" ' +
                            'Cevaplar 1-2 cümle, net ve premium tonda olsun.',
                    },
                };
                _this.logger.log("[RealtimeBridgeService] session.update tenantId=".concat(state.tenantId, " voice=").concat(VOICE));
                ws.send(JSON.stringify(sessionUpdate));
                // ✅ Greeting: DO NOT commit empty audio buffer.
                // Instead: create a conversation item and ask for audio response.
                if (!state.greeted) {
                    state.greeted = true;
                    state.responseInProgress = true;
                    state.lastResponseCreateAt = Date.now();
                    ws.send(JSON.stringify({
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
                    }));
                    ws.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                            modalities: ['audio', 'text'],
                            instructions: 'Görüşmeyi sen başlat. Tek cümle: "Merhaba, Güzellik Merkezi’ne hoş geldiniz. Size nasıl yardımcı olabilirim?"',
                        },
                    }));
                    _this.logger.log("response.create (greeting) tenantId=".concat(state.tenantId));
                }
            });
            ws.on('message', function (raw) {
                var _a, _b, _c, _d, _e;
                var msg;
                try {
                    msg = JSON.parse(String(raw));
                }
                catch (_f) {
                    return;
                }
                var t = msg === null || msg === void 0 ? void 0 : msg.type;
                if (t === 'error' ||
                    t === 'session.created' ||
                    t === 'session.updated' ||
                    t === 'input_audio_buffer.speech_started' ||
                    t === 'input_audio_buffer.speech_stopped') {
                    _this.logger.log("OpenAI event tenantId=".concat((state === null || state === void 0 ? void 0 : state.tenantId) || '-', " type=").concat(t));
                }
                if (t === 'error') {
                    var em = ((_a = msg === null || msg === void 0 ? void 0 : msg.error) === null || _a === void 0 ? void 0 : _a.message) || JSON.stringify(msg);
                    _this.logger.error("OpenAI error tenantId=".concat((state === null || state === void 0 ? void 0 : state.tenantId) || '-', ": ").concat(em));
                    var s_1 = _this.sessions.get(sessionKey);
                    if (s_1) {
                        s_1.openaiLastError = em;
                        // If buffer too small, clear to avoid repeated failures
                        (_b = s_1.openai) === null || _b === void 0 ? void 0 : _b.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
                        // Reset counters because the buffer has been cleared due to an error
                        s_1.appendedMsSinceCommit = 0;
                        s_1.lastCommittedAppends = s_1.openaiAppends;
                        s_1.responseInProgress = false;
                        s_1.aiSpeaking = false;
                        s_1.aiHasActiveResponse = false;
                    }
                    return;
                }
                var s = _this.sessions.get(sessionKey);
                if (!s || s.closed)
                    return;
                // BARGE-IN: user started speaking while AI speaking -> cancel + clear
                if (t === 'input_audio_buffer.speech_started') {
                    var s_2 = _this.sessions.get(sessionKey);
                    if (!s_2 || s_2.closed)
                        return;
                    // 🔥 KRİTİK: yeni konuşma başlarken referansları sıfırla
                    s_2.lastCommittedAppends = s_2.openaiAppends;
                    // Reset accumulated ms since commit because the buffer will be cleared
                    s_2.appendedMsSinceCommit = 0;
                    if (s_2.aiSpeaking && s_2.aiHasActiveResponse) {
                        _this.logger.log("[BARGE-IN] speech_started -> cancel+clear tenantId=".concat(s_2.tenantId));
                        (_c = s_2.openai) === null || _c === void 0 ? void 0 : _c.send(JSON.stringify({ type: 'response.cancel' }));
                    }
                    else {
                        _this.logger.log("[BARGE-IN] speech_started -> clear-only (no active response) tenantId=".concat(s_2.tenantId));
                    }
                    (_d = s_2.openai) === null || _d === void 0 ? void 0 : _d.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
                    if (s_2.twilio && s_2.streamSid) {
                        s_2.twilio.send(JSON.stringify({ event: 'clear', streamSid: s_2.streamSid }));
                    }
                    s_2.aiSpeaking = false;
                    s_2.responseInProgress = false;
                    s_2.aiHasActiveResponse = false;
                    return;
                }
                // User stopped speaking -> create response ONLY if we have enough audio
                if (t === 'input_audio_buffer.speech_stopped') {
                    // If the OpenAI socket isn't ready, do nothing.
                    if (!s.openai || !s.openaiReady)
                        return;
                    // Avoid overlapping responses
                    if (s.responseInProgress) {
                        _this.logger.log("response.create skipped (already in progress) tenantId=".concat(s.tenantId));
                        return;
                    }
                    var now = Date.now();
                    // Debounce successive response.create calls
                    if (now - s.lastResponseCreateAt < 900)
                        return;
                    // Attempt to commit the buffer. This will clear the buffer and skip
                    // committing if there isn't enough audio accumulated (see
                    // tryCommitInput for details). When it returns false we abort.
                    var committed = _this.tryCommitInput(s, 'speech_stopped');
                    if (!committed) {
                        return;
                    }
                    // We have successfully committed the buffer; begin generating a response.
                    s.responseInProgress = true;
                    s.lastResponseCreateAt = now;
                    (_e = s.openai) === null || _e === void 0 ? void 0 : _e.send(JSON.stringify({ type: 'response.create' }));
                    _this.logger.log("response.create tenantId=".concat(s.tenantId));
                    return;
                }
                // Response done -> reset flags
                if (t === 'response.done' ||
                    t === 'response.audio.done' ||
                    t === 'response.output_audio.done' ||
                    t === 'response.end') {
                    s.aiSpeaking = false;
                    s.responseInProgress = false;
                    s.aiHasActiveResponse = false;
                    return;
                }
                // OpenAI audio delta -> forward to Twilio
                if (t === 'response.audio.delta' || t === 'response.output_audio.delta') {
                    var delta = msg === null || msg === void 0 ? void 0 : msg.delta;
                    s.aiHasActiveResponse = true;
                    s.aiSpeaking = true;
                    if (typeof delta === 'string' && s.twilio && s.streamSid) {
                        s.openaiDeltas++;
                        s.twilio.send(JSON.stringify({
                            event: 'media',
                            streamSid: s.streamSid,
                            media: { payload: delta },
                        }));
                        if (s.openaiDeltas === 1 || s.openaiDeltas % 50 === 0) {
                            _this.logger.log("OpenAI audio.delta tenantId=".concat(s.tenantId, " deltas=").concat(s.openaiDeltas, " twilioFrames=").concat(s.twilioFrames));
                        }
                    }
                    return;
                }
            });
            ws.on('close', function () { return _this.detach(sessionKey, 'openai-close'); });
            ws.on('error', function (e) { return _this.detach(sessionKey, "openai-error:".concat((e === null || e === void 0 ? void 0 : e.message) || e)); });
        };
        // --------------------------
        // Helpers / cleanup
        // --------------------------
        RealtimeBridgeService_1.prototype.detach = function (sessionKey, reason) {
            var _a, _b;
            var state = this.sessions.get(sessionKey);
            if (!state || state.closed)
                return;
            state.closed = true;
            this.logger.warn("Bridge close tenantId=".concat(state.tenantId, " sessionKey=").concat(sessionKey, " reason=").concat(reason, " twilioFrames=").concat(state.twilioFrames, " openaiAppends=").concat(state.openaiAppends, " openaiDeltas=").concat(state.openaiDeltas, " openaiErr=").concat(state.openaiLastError || '-'));
            try {
                (_a = state.openai) === null || _a === void 0 ? void 0 : _a.close();
            }
            catch (_c) { }
            try {
                (_b = state.twilio) === null || _b === void 0 ? void 0 : _b.close();
            }
            catch (_d) { }
            this.sessions.delete(sessionKey);
        };
        RealtimeBridgeService_1.prototype.getQueryParam = function (url, key) {
            var idx = url.indexOf('?');
            if (idx === -1)
                return null;
            var qs = url.slice(idx + 1);
            for (var _i = 0, _a = qs.split('&'); _i < _a.length; _i++) {
                var part = _a[_i];
                var _b = part.split('='), k = _b[0], v = _b[1];
                if (k === key)
                    return decodeURIComponent(v || '');
            }
            return null;
        };
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
        RealtimeBridgeService_1.prototype.tryCommitInput = function (session, reason) {
            var _a;
            var ms = session.appendedMsSinceCommit || 0;
            if (ms < 100) {
                this.logger.warn("[RealtimeBridgeService] skip create_response (<100ms) why=".concat(reason, " ms=").concat(ms, " tenantId=").concat(session.tenantId));
                // Short blips -> reset local counters; also clear to avoid stuck VAD
                (_a = session.openai) === null || _a === void 0 ? void 0 : _a.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
                session.appendedMsSinceCommit = 0;
                session.lastCommittedAppends = session.openaiAppends;
                return false;
            }
            // IMPORTANT: server_vad already segments internally. DO NOT commit here.
            session.appendedMsSinceCommit = 0;
            session.lastCommittedAppends = session.openaiAppends;
            this.logger.log("[RealtimeBridgeService] ok for response.create why=".concat(reason, " ms=").concat(ms, " tenantId=").concat(session.tenantId));
            return true;
        };
        return RealtimeBridgeService_1;
    }());
    __setFunctionName(_classThis, "RealtimeBridgeService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        RealtimeBridgeService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return RealtimeBridgeService = _classThis;
}();
exports.RealtimeBridgeService = RealtimeBridgeService;
