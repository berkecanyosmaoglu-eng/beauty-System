"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentService = void 0;
var common_1 = require("@nestjs/common");
var openai_1 = require("openai");
var WaState;
(function (WaState) {
    WaState["IDLE"] = "IDLE";
    WaState["WAIT_SERVICE"] = "WAIT_SERVICE";
    WaState["WAIT_STAFF"] = "WAIT_STAFF";
    WaState["WAIT_NAME"] = "WAIT_NAME";
    WaState["WAIT_DATETIME"] = "WAIT_DATETIME";
    WaState["WAIT_CONFIRM"] = "WAIT_CONFIRM";
})(WaState || (WaState = {}));
var AgentService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var AgentService = _classThis = /** @class */ (function () {
        function AgentService_1(prisma) {
            this.prisma = prisma;
            this.logger = new common_1.Logger(AgentService.name);
            this.openai = process.env.OPENAI_API_KEY ? new openai_1.default({ apiKey: process.env.OPENAI_API_KEY }) : null;
            // WhatsApp için memory session (tenantId+phone)
            this.sessions = new Map();
        }
        AgentService_1.prototype.replyText = function (opts) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, from, raw, msg, key, session, prev, s, services_1, reply, business, services, staff, reply, svc, dt, reply, recent, likelyLaser, svc, name_1, price, dur, parts, end, nudge, list, addr, hours, parts, svc, out, base, alt, llmAnswer, alt, finalAnswer, e_1;
                var _a, _b, _c, _d;
                return __generator(this, function (_e) {
                    switch (_e.label) {
                        case 0:
                            tenantId = opts.tenantId, from = opts.from;
                            raw = ((_a = opts.text) !== null && _a !== void 0 ? _a : '').trim();
                            msg = normalizeTr(raw);
                            key = "".concat(tenantId, ":").concat(from);
                            session = this.getOrInitSession(key, tenantId, from);
                            // ✅ Best-effort dedup: aynı metin kısa sürede tekrar geldiyse (webhook retry)
                            if (this.isLikelyDuplicateInbound(session, raw)) {
                                prev = session.lastAssistantReply || session.lastAssistantText || 'Tamam 👍';
                                return [2 /*return*/, this.safeReply(session, prev)];
                            }
                            // ✅ user mesajını hafızaya yaz
                            this.recordHistory(session, 'user', raw);
                            _e.label = 1;
                        case 1:
                            _e.trys.push([1, 16, , 17]);
                            // Global: iptal / sıfırla
                            if (isCancel(msg)) {
                                this.resetSession(key, tenantId, from);
                                return [2 /*return*/, this.safeReply(session, 'Tamam 👍 İptal ettim. Yeni randevu için “randevu” yazabilirsin.')];
                            }
                            if (!isRestart(msg)) return [3 /*break*/, 3];
                            this.resetSession(key, tenantId, from);
                            s = this.getOrInitSession(key, tenantId, from);
                            s.state = WaState.WAIT_SERVICE;
                            this.saveSession(key, s);
                            return [4 /*yield*/, this.safeListServices(tenantId)];
                        case 2:
                            services_1 = _e.sent();
                            reply = this.askService(services_1, { gentle: true });
                            return [2 /*return*/, this.safeReply(s, reply)];
                        case 3: return [4 /*yield*/, ((_b = this.prisma.businessProfile) === null || _b === void 0 ? void 0 : _b.findUnique({ where: { tenantId: tenantId } }).catch(function () { return null; }))];
                        case 4:
                            business = _e.sent();
                            return [4 /*yield*/, this.safeListServices(tenantId)];
                        case 5:
                            services = _e.sent();
                            return [4 /*yield*/, this.safeListStaff(tenantId)];
                        case 6:
                            staff = _e.sent();
                            if (!(session.state !== WaState.IDLE)) return [3 /*break*/, 8];
                            return [4 /*yield*/, this.handleBookingFlow({
                                    key: key,
                                    session: session,
                                    tenantId: tenantId,
                                    from: from,
                                    msg: msg,
                                    raw: raw,
                                    services: services,
                                    staff: staff,
                                })];
                        case 7:
                            reply = _e.sent();
                            this.saveSession(key, session);
                            return [2 /*return*/, this.safeReply(session, reply)];
                        case 8:
                            // ✅ Booking intent: akıllı başlat (hizmet/tarih varsa otomatik yakala)
                            if (looksLikeBookingIntent(msg)) {
                                svc = this.detectServiceFromMessage(raw, services);
                                dt = parseDateTimeTR(raw);
                                if (dt)
                                    session.pendingStartAt = toIstanbulIso(clampToFuture(dt));
                                // hizmet bulunduysa draft'a bas
                                if (svc === null || svc === void 0 ? void 0 : svc.id)
                                    session.draft.serviceId = String(svc.id);
                                // state seçimi: hizmet biliniyorsa direkt uzman'a geç
                                if (session.draft.serviceId) {
                                    session.state = WaState.WAIT_STAFF;
                                    this.saveSession(key, session);
                                    // eğer staff yoksa direkt isim aşamasına geç
                                    if (!staff || staff.length === 0)
                                        session.state = WaState.WAIT_NAME;
                                    reply = !staff || staff.length === 0 ? 'Randevuyu kimin adına oluşturalım? (Ad Soyad yeterli)' : this.askStaff(staff);
                                    return [2 /*return*/, this.safeReply(session, reply)];
                                }
                                // hizmet yoksa: insan gibi tek soru sor (listeyi boca etme)
                                session.state = WaState.WAIT_SERVICE;
                                this.saveSession(key, session);
                                recent = this.getRecentHistory(session, 10).map(function (h) { return normalizeTr(h.text); }).join(' ');
                                likelyLaser = recent.includes('lazer') || recent.includes('epilasyon');
                                if (likelyLaser) {
                                    return [2 /*return*/, this.safeReply(session, 'Rezervasyon lazer epilasyon için miydi? İstersen “evet” deyip devam edelim ya da hangi hizmet olduğunu yazabilirsin. Diğer hizmetler hakkında da bilgi verebilirim 🙂')];
                                }
                                // genel durumda tek soru
                                return [2 /*return*/, this.safeReply(session, 'Rezervasyon hangi hizmet için olacaktı? (Örn: “lazer epilasyon”)')];
                            }
                            // ✅ Fiyat sorusu: SADECE ilgili hizmeti bulup kısa cevap ver
                            if (looksLikePriceQuestion(msg)) {
                                svc = this.detectServiceFromMessage(raw, services);
                                if (svc) {
                                    name_1 = String(svc.name || 'Hizmet');
                                    price = (_c = svc.price) !== null && _c !== void 0 ? _c : null;
                                    dur = (_d = svc.duration) !== null && _d !== void 0 ? _d : null;
                                    parts = [];
                                    if (price != null)
                                        parts.push("".concat(name_1, " fiyat\u0131: ").concat(price, "\u20BA"));
                                    else
                                        parts.push("".concat(name_1, " i\u00E7in fiyat bilgisi hen\u00FCz eklenmemi\u015F g\u00F6r\u00FCn\u00FCyor."));
                                    if (dur != null)
                                        parts.push("S\u00FCre: ".concat(dur, " dk"));
                                    end = parts.join(' • ');
                                    nudge = this.shouldNudgeBooking(session) ? '\nİstersen uygun gün/saat yaz, randevu da oluşturabilirim.' : '';
                                    return [2 /*return*/, this.safeReply(session, end + nudge)];
                                }
                                // Hizmet bulamadıysa listeyi dökme, soru sor
                                return [2 /*return*/, this.safeReply(session, 'Hangi hizmetin fiyatını soruyorsun? (Örn: “Lazer epilasyon fiyatı”)')];
                            }
                            // ✅ Hizmet listesi isteyen: kısa liste
                            if (looksLikeServiceListRequest(msg)) {
                                list = servicesToTextShort(services);
                                if (!list)
                                    return [2 /*return*/, this.safeReply(session, 'Şu an hizmet listem görünmüyor 😕 Birazdan tekrar dener misin?')];
                                return [2 /*return*/, this.safeReply(session, "Hizmetlerimiz:\n".concat(list))];
                            }
                            // ✅ Adres/saat
                            if (looksLikeAddressOrHours(msg)) {
                                addr = (business === null || business === void 0 ? void 0 : business.address) || (business === null || business === void 0 ? void 0 : business.fullAddress) || (business === null || business === void 0 ? void 0 : business.location) || null;
                                hours = (business === null || business === void 0 ? void 0 : business.workingHours) || (business === null || business === void 0 ? void 0 : business.hours) || (business === null || business === void 0 ? void 0 : business.openHours) || null;
                                parts = [];
                                if (addr)
                                    parts.push("\uD83D\uDCCD Adres: ".concat(String(addr)));
                                if (hours)
                                    parts.push("\u23F0 \u00C7al\u0131\u015Fma saatleri: ".concat(String(hours)));
                                return [2 /*return*/, this.safeReply(session, parts.length ? parts.join('\n') : 'Adres/çalışma saatleri bilgisi henüz eklenmemiş görünüyor.')];
                            }
                            if (!looksLikeProcedureQuestion(msg)) return [3 /*break*/, 12];
                            svc = this.detectServiceFromMessage(raw, services);
                            // Konuyu ve hizmeti hatırla
                            session.lastTopic = 'procedure';
                            session.lastServiceId = svc && svc.id ? String(svc.id) : undefined;
                            return [4 /*yield*/, this.answerWithLLM({
                                    raw: raw,
                                    business: business,
                                    services: services,
                                    staff: staff,
                                    history: this.getRecentHistory(session, 8),
                                    mode: 'procedure',
                                    focusService: svc ? { name: String(svc.name || ''), duration: svc.duration, price: svc.price } : null,
                                })];
                        case 9:
                            out = _e.sent();
                            // LLM boş dönerse template fallback
                            if (!out) {
                                base = svc
                                    ? this.procedureTemplateForService(String(svc.name || ''), svc.duration, svc.price)
                                    : 'Genel olarak süreç kişiye göre değişir. Hangi işlem için soruyorsun? (Örn: lazer, kaş, tırnak)';
                                return [2 /*return*/, this.safeReply(session, base)];
                            }
                            if (!(session.lastAssistantReply && normalizeTr(session.lastAssistantReply) === normalizeTr(out))) return [3 /*break*/, 11];
                            return [4 /*yield*/, this.answerWithLLM({
                                    raw: raw,
                                    business: business,
                                    services: services,
                                    staff: staff,
                                    history: this.getRecentHistory(session, 8),
                                    mode: 'procedure',
                                    focusService: svc ? { name: String(svc.name || ''), duration: svc.duration, price: svc.price } : null,
                                    avoidRepeat: true,
                                })];
                        case 10:
                            alt = _e.sent();
                            // Eğer yeni cevap farklı ise onu kullan; değilse kısa bir soru sorarak konuyu ilerlet
                            if (alt && normalizeTr(alt) !== normalizeTr(session.lastAssistantReply || '')) {
                                out = alt;
                            }
                            else {
                                out = 'Hangi bölge için düşünüyorsunuz?';
                            }
                            _e.label = 11;
                        case 11: return [2 /*return*/, this.safeReply(session, out)];
                        case 12:
                            // ✅ Genel soru: LLM fallback (booking’e sokmadan)
                            session.lastTopic = 'general';
                            session.lastServiceId = undefined;
                            return [4 /*yield*/, this.answerWithLLM({
                                    raw: raw,
                                    business: business,
                                    services: services,
                                    staff: staff,
                                    history: this.getRecentHistory(session, 8),
                                    mode: 'general',
                                    focusService: null,
                                })];
                        case 13:
                            llmAnswer = _e.sent();
                            if (!llmAnswer) {
                                llmAnswer = '';
                            }
                            if (!(llmAnswer && session.lastAssistantReply && normalizeTr(session.lastAssistantReply) === normalizeTr(llmAnswer))) return [3 /*break*/, 15];
                            return [4 /*yield*/, this.answerWithLLM({
                                    raw: raw,
                                    business: business,
                                    services: services,
                                    staff: staff,
                                    history: this.getRecentHistory(session, 8),
                                    mode: 'general',
                                    focusService: null,
                                    avoidRepeat: true,
                                })];
                        case 14:
                            alt = _e.sent();
                            if (alt && normalizeTr(alt) !== normalizeTr(session.lastAssistantReply || '')) {
                                llmAnswer = alt;
                            }
                            else {
                                // Genel modda farklı bir açıdan soru sorarak ilerlet
                                llmAnswer = 'Tam olarak ne öğrenmek istiyorsunuz?';
                            }
                            _e.label = 15;
                        case 15:
                            finalAnswer = llmAnswer || 'Anlayamadım 😕 İstersen ne yapmak istediğini kısaca yaz.';
                            return [2 /*return*/, this.safeReply(session, finalAnswer)];
                        case 16:
                            e_1 = _e.sent();
                            this.logger.error("[AgentService.replyText] ".concat((e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || e_1));
                            return [2 /*return*/, this.safeReply(session, 'Şu an bir hata oluştu 😕 Lütfen tekrar dener misin?')];
                        case 17: return [2 /*return*/];
                    }
                });
            });
        };
        // =========================
        // Booking State Machine
        // =========================
        AgentService_1.prototype.handleBookingFlow = function (opts) {
            return __awaiter(this, void 0, void 0, function () {
                var key, session, tenantId, from, msg, raw, services, staff, earlyDt, maybeName, startIso, dt, pre, sugText, dt, yes, no, maybeName, bookingKey, startAt, created, sugText;
                var _a, _b, _c, _d;
                return __generator(this, function (_e) {
                    switch (_e.label) {
                        case 0:
                            key = opts.key, session = opts.session, tenantId = opts.tenantId, from = opts.from, msg = opts.msg, raw = opts.raw, services = opts.services, staff = opts.staff;
                            // ✅ Kullanıcı booking akışındayken konu değiştirdiyse / vazgeçtiyse kitlenme olmasın
                            if (shouldExitBookingFlow(msg, raw)) {
                                session.state = WaState.IDLE;
                                session.pendingSummary = undefined;
                                session.draft = { tenantId: tenantId, customerPhone: from };
                                session.lastTopic = 'general';
                                session.lastServiceId = undefined;
                                return [2 /*return*/, 'Tamam 👍 Anladım. Nasıl yardımcı olayım?'];
                            }
                            earlyDt = parseDateTimeTR(raw);
                            if (earlyDt) {
                                session.pendingStartAt = toIstanbulIso(clampToFuture(earlyDt));
                            }
                            // ✅ Eğer pendingStartAt varsa ve draft.startAt boşsa doldur (ama CONFIRM'e geçmek için uygun state'i bekle)
                            if (!session.draft.startAt && session.pendingStartAt) {
                                session.draft.startAt = session.pendingStartAt;
                            }
                            // Autofill service/staff
                            this.tryAutofillService(session.draft, services, msg);
                            this.tryAutofillStaff(session.draft, staff, msg);
                            // Tek seçenek auto
                            if (!session.draft.serviceId && services.length === 1 && ((_a = services[0]) === null || _a === void 0 ? void 0 : _a.id)) {
                                session.draft.serviceId = String(services[0].id);
                            }
                            if (!session.draft.staffId && staff.length === 1 && ((_b = staff[0]) === null || _b === void 0 ? void 0 : _b.id)) {
                                session.draft.staffId = String(staff[0].id);
                            }
                            if (session.state === WaState.WAIT_SERVICE) {
                                if (!session.draft.serviceId)
                                    return [2 /*return*/, this.askService(services, { gentle: false })];
                                session.state = WaState.WAIT_STAFF;
                            }
                            if (session.state === WaState.WAIT_STAFF) {
                                // staff yoksa atla
                                if (!session.draft.staffId) {
                                    if (!staff || staff.length === 0) {
                                        session.state = WaState.WAIT_NAME;
                                    }
                                    else {
                                        return [2 /*return*/, this.askStaff(staff)];
                                    }
                                }
                                else {
                                    session.state = WaState.WAIT_NAME;
                                }
                            }
                            if (session.state === WaState.WAIT_NAME) {
                                maybeName = extractName(raw);
                                if (!session.draft.customerName && maybeName)
                                    session.draft.customerName = maybeName;
                                if (!session.draft.customerName)
                                    return [2 /*return*/, 'Randevuyu kimin adına oluşturalım? (Ad Soyad yeterli)'];
                                session.state = WaState.WAIT_DATETIME;
                            }
                            if (!(session.state === WaState.WAIT_DATETIME)) return [3 /*break*/, 2];
                            startIso = session.draft.startAt;
                            if (!startIso) {
                                dt = parseDateTimeTR(raw);
                                if (!dt)
                                    return [2 /*return*/, 'Hangi gün ve saat uygun? (Örn: “yarın 10:00” veya “3 Şubat 14:30”)'];
                                startIso = toIstanbulIso(clampToFuture(dt));
                                session.draft.startAt = startIso;
                            }
                            return [4 /*yield*/, this.precheckAndPrepareConfirm({ tenantId: tenantId, draft: session.draft })];
                        case 1:
                            pre = _e.sent();
                            if (!pre.ok) {
                                if (pre.code === 'SLOT_TAKEN' && ((_c = pre.suggestions) === null || _c === void 0 ? void 0 : _c.length)) {
                                    sugText = pre.suggestions
                                        .slice(0, 5)
                                        .map(function (s) { return "\u2022 ".concat(prettyIstanbul(s.startAt)); })
                                        .join('\n');
                                    return [2 /*return*/, "O saat dolu \uD83D\uDE15 \u015Eunlar uygun:\n".concat(sugText, "\nHangisi olsun?")];
                                }
                                return [2 /*return*/, 'Randevu kontrolünde bir sorun oldu 😕 Farklı bir saat dener misin?'];
                            }
                            session.pendingSummary = pre.summary;
                            session.state = WaState.WAIT_CONFIRM;
                            return [2 /*return*/, "".concat(pre.summary, "\nOnayl\u0131yor musunuz? (E/H)")];
                        case 2:
                            if (!(session.state === WaState.WAIT_CONFIRM)) return [3 /*break*/, 4];
                            dt = parseDateTimeTR(raw);
                            if (dt) {
                                session.state = WaState.WAIT_DATETIME;
                                return [2 /*return*/, this.handleBookingFlow(__assign(__assign({}, opts), { session: session }))];
                            }
                            yes = isYes(msg);
                            no = isNo(msg);
                            if (!yes && !no) {
                                maybeName = extractName(raw);
                                if (maybeName)
                                    session.draft.customerName = maybeName;
                                return [2 /*return*/, 'Onay için “E” (evet) ya da “H” (hayır) yazar mısın?'];
                            }
                            if (no) {
                                session.state = WaState.WAIT_DATETIME;
                                session.pendingSummary = undefined;
                                return [2 /*return*/, 'Tamam 👍 O zaman hangi gün/saat uygun? (Örn: “yarın 11:00”)'];
                            }
                            bookingKey = this.makeBookingKey(tenantId, from, session.draft);
                            if (bookingKey &&
                                session.lastCreatedBookingKey === bookingKey &&
                                session.lastCreatedAppointmentId &&
                                session.lastCreatedAt &&
                                Date.now() - session.lastCreatedAt < 10 * 60 * 1000) {
                                startAt = session.draft.startAt || new Date().toISOString();
                                this.resetSession(key, tenantId, from);
                                return [2 /*return*/, "Tamamd\u0131r \u2705\n\uD83D\uDCC5 ".concat(prettyIstanbul(startAt), "\n\uD83E\uDDFE No: ").concat(session.lastCreatedAppointmentId)];
                            }
                            return [4 /*yield*/, this.createAppointment({ tenantId: tenantId, draft: session.draft })];
                        case 3:
                            created = _e.sent();
                            if (!created.ok) {
                                if (created.code === 'SLOT_TAKEN' && ((_d = created.suggestions) === null || _d === void 0 ? void 0 : _d.length)) {
                                    session.state = WaState.WAIT_DATETIME;
                                    sugText = created.suggestions
                                        .slice(0, 5)
                                        .map(function (s) { return "\u2022 ".concat(prettyIstanbul(s.startAt)); })
                                        .join('\n');
                                    return [2 /*return*/, "O saat dolu \uD83D\uDE15 \u015Eunlar uygun:\n".concat(sugText, "\nHangisi olsun?")];
                                }
                                session.state = WaState.WAIT_DATETIME;
                                return [2 /*return*/, 'Randevu oluştururken sorun oldu 😕 Başka bir saat dener misin?'];
                            }
                            // success
                            this.resetSession(key, tenantId, from);
                            return [2 /*return*/, "Tamamd\u0131r \u2705\n\uD83D\uDCC5 ".concat(prettyIstanbul(created.data.startAt), "\n\uD83E\uDDFE No: ").concat(created.data.appointmentId)];
                        case 4:
                            // fallback
                            session.state = WaState.WAIT_SERVICE;
                            return [2 /*return*/, this.askService(services, { gentle: true })];
                    }
                });
            });
        };
        AgentService_1.prototype.askService = function (services, opts) {
            // ✅ Listeyi sadece gerektiğinde ve kısa ver
            var list = servicesToTextShort(services);
            if (!list)
                return 'Hangi hizmeti almak istersiniz? (Örn: “Lazer epilasyon”)';
            if (opts.gentle) {
                return "Hangi hizmet i\u00E7in yard\u0131mc\u0131 olay\u0131m?\n".concat(list);
            }
            return "Hangi hizmeti almak istersiniz?\n".concat(list);
        };
        AgentService_1.prototype.askStaff = function (staff) {
            var list = staffToTextShort(staff);
            return list ? "Hangi uzmanla olsun?\n".concat(list) : 'Hangi uzmanla olsun? (Örn: “Elif”)';
        };
        // =========================
        // Prisma helpers (enum-safe)
        // =========================
        AgentService_1.prototype.findClashSafe = function (whereBase) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.appointment.findFirst({
                                where: whereBase,
                                select: { id: true },
                            })];
                        case 1: 
                        // ✅ Status filtresi YOK (enum patlatmasın)
                        return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        AgentService_1.prototype.precheckAndPrepareConfirm = function (opts) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, draft, service, staffRec, _a, start, durationMinutes, end, whereBase, clash, suggestions, name, serviceName, staffName, lines;
                var _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            tenantId = opts.tenantId, draft = opts.draft;
                            if (!draft.serviceId || !draft.startAt || !draft.customerPhone)
                                return [2 /*return*/, { ok: false }];
                            return [4 /*yield*/, this.prisma.service.findFirst({
                                    where: { id: String(draft.serviceId), tenantId: tenantId },
                                    select: { id: true, name: true, duration: true, price: true },
                                })];
                        case 1:
                            service = _c.sent();
                            if (!service)
                                return [2 /*return*/, { ok: false }];
                            if (!draft.staffId) return [3 /*break*/, 3];
                            return [4 /*yield*/, ((_b = this.prisma.staff) === null || _b === void 0 ? void 0 : _b.findFirst({
                                    where: { id: String(draft.staffId), tenantId: tenantId },
                                    select: { id: true, fullName: true },
                                }).catch(function () { return null; }))];
                        case 2:
                            _a = _c.sent();
                            return [3 /*break*/, 4];
                        case 3:
                            _a = null;
                            _c.label = 4;
                        case 4:
                            staffRec = _a;
                            start = new Date(draft.startAt);
                            durationMinutes = Number(service.duration) || 30;
                            end = new Date(start.getTime() + durationMinutes * 60000);
                            whereBase = {
                                tenantId: tenantId,
                                startAt: { lt: end },
                                endAt: { gt: start },
                            };
                            if (draft.staffId)
                                whereBase.staffId = String(draft.staffId);
                            return [4 /*yield*/, this.findClashSafe(whereBase)];
                        case 5:
                            clash = _c.sent();
                            if (!clash) return [3 /*break*/, 7];
                            return [4 /*yield*/, this.suggestSlots({
                                    tenantId: tenantId,
                                    staffId: draft.staffId ? String(draft.staffId) : undefined,
                                    startFrom: start,
                                    durationMinutes: durationMinutes,
                                    stepMinutes: 15,
                                    maxSuggestions: 5,
                                    searchHours: 24,
                                })];
                        case 6:
                            suggestions = _c.sent();
                            return [2 /*return*/, { ok: false, code: 'SLOT_TAKEN', suggestions: suggestions }];
                        case 7:
                            name = (draft.customerName || '').trim();
                            serviceName = String(service.name || 'Hizmet');
                            staffName = (staffRec === null || staffRec === void 0 ? void 0 : staffRec.fullName) ? String(staffRec.fullName) : null;
                            lines = [];
                            lines.push('Randevu özeti:');
                            lines.push("\u2022 Hizmet: ".concat(serviceName).concat(service.price ? " \u2014 ".concat(service.price, "\u20BA") : ''));
                            if (staffName)
                                lines.push("\u2022 Uzman: ".concat(staffName));
                            lines.push("\u2022 Tarih/Saat: ".concat(prettyIstanbul(draft.startAt)));
                            if (name)
                                lines.push("\u2022 \u0130sim: ".concat(name));
                            return [2 /*return*/, { ok: true, summary: lines.join('\n') }];
                    }
                });
            });
        };
        AgentService_1.prototype.createAppointment = function (opts) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, draft, serviceId, staffId, startAt, customerPhone, customerName, service, fullName, customer, start, durationMinutes, end, whereBase, clash, suggestions, baseData, appt, e_2, e_3;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            tenantId = opts.tenantId, draft = opts.draft;
                            _a.label = 1;
                        case 1:
                            _a.trys.push([1, 12, , 13]);
                            serviceId = String(draft.serviceId || '');
                            staffId = draft.staffId ? String(draft.staffId) : '';
                            startAt = String(draft.startAt || '');
                            customerPhone = String(draft.customerPhone || '');
                            customerName = draft.customerName ? String(draft.customerName) : null;
                            if (!serviceId || !startAt || !customerPhone)
                                return [2 /*return*/, { ok: false }];
                            return [4 /*yield*/, this.prisma.service.findFirst({
                                    where: { id: serviceId, tenantId: tenantId },
                                    select: { id: true, name: true, duration: true },
                                })];
                        case 2:
                            service = _a.sent();
                            if (!service)
                                return [2 /*return*/, { ok: false }];
                            fullName = (customerName === null || customerName === void 0 ? void 0 : customerName.trim()) ? customerName.trim() : customerPhone;
                            return [4 /*yield*/, this.prisma.customer.upsert({
                                    where: { tenantId_phone: { tenantId: tenantId, phone: customerPhone } },
                                    update: { fullName: fullName },
                                    create: { tenantId: tenantId, phone: customerPhone, fullName: fullName },
                                    select: { id: true },
                                })];
                        case 3:
                            customer = _a.sent();
                            start = new Date(startAt);
                            durationMinutes = Number(service.duration) || 30;
                            end = new Date(start.getTime() + durationMinutes * 60000);
                            whereBase = {
                                tenantId: tenantId,
                                startAt: { lt: end },
                                endAt: { gt: start },
                            };
                            if (staffId)
                                whereBase.staffId = staffId;
                            return [4 /*yield*/, this.findClashSafe(whereBase)];
                        case 4:
                            clash = _a.sent();
                            if (!clash) return [3 /*break*/, 6];
                            return [4 /*yield*/, this.suggestSlots({
                                    tenantId: tenantId,
                                    staffId: staffId || undefined,
                                    startFrom: start,
                                    durationMinutes: durationMinutes,
                                    stepMinutes: 15,
                                    maxSuggestions: 5,
                                    searchHours: 24,
                                })];
                        case 5:
                            suggestions = _a.sent();
                            return [2 /*return*/, { ok: false, code: 'SLOT_TAKEN', suggestions: suggestions }];
                        case 6:
                            baseData = __assign({ tenant: { connect: { id: tenantId } }, startAt: start, endAt: end, customer: { connect: { id: customer.id } }, service: { connect: { id: service.id } } }, (staffId ? { staff: { connect: { id: staffId } } } : {}));
                            appt = void 0;
                            _a.label = 7;
                        case 7:
                            _a.trys.push([7, 9, , 11]);
                            return [4 /*yield*/, this.prisma.appointment.create({
                                    data: __assign(__assign({}, baseData), { status: 'SCHEDULED', channel: 'WHATSAPP' }),
                                    select: { id: true, startAt: true },
                                })];
                        case 8:
                            appt = _a.sent();
                            return [3 /*break*/, 11];
                        case 9:
                            e_2 = _a.sent();
                            this.logger.warn("[createAppointment] status/channel failed, retry without them. ".concat((e_2 === null || e_2 === void 0 ? void 0 : e_2.message) || ''));
                            return [4 /*yield*/, this.prisma.appointment.create({
                                    data: baseData,
                                    select: { id: true, startAt: true },
                                })];
                        case 10:
                            appt = _a.sent();
                            return [3 /*break*/, 11];
                        case 11: return [2 /*return*/, {
                                ok: true,
                                data: {
                                    appointmentId: appt.id,
                                    startAt: appt.startAt.toISOString(),
                                },
                            }];
                        case 12:
                            e_3 = _a.sent();
                            this.logger.error("[createAppointment] failed hard: ".concat((e_3 === null || e_3 === void 0 ? void 0 : e_3.message) || e_3));
                            return [2 /*return*/, { ok: false, code: 'ERROR' }];
                        case 13: return [2 /*return*/];
                    }
                });
            });
        }; // ✅ createAppointment burada biter
        AgentService_1.prototype.suggestSlots = function (opts) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, staffId, startFrom, durationMinutes, stepMinutes, maxSuggestions, searchHours, suggestions, startMs, endMs, t, s, e, whereBase, clash;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            tenantId = opts.tenantId, staffId = opts.staffId, startFrom = opts.startFrom, durationMinutes = opts.durationMinutes, stepMinutes = opts.stepMinutes, maxSuggestions = opts.maxSuggestions, searchHours = opts.searchHours;
                            suggestions = [];
                            startMs = startFrom.getTime();
                            endMs = startMs + searchHours * 60 * 60 * 1000;
                            t = startMs;
                            _a.label = 1;
                        case 1:
                            if (!(t < endMs && suggestions.length < maxSuggestions)) return [3 /*break*/, 4];
                            s = new Date(t);
                            e = new Date(t + durationMinutes * 60 * 1000);
                            whereBase = {
                                tenantId: tenantId,
                                startAt: { lt: e },
                                endAt: { gt: s },
                            };
                            if (staffId)
                                whereBase.staffId = staffId;
                            return [4 /*yield*/, this.findClashSafe(whereBase)];
                        case 2:
                            clash = _a.sent();
                            if (!clash)
                                suggestions.push({ startAt: toIstanbulIso(s), endAt: toIstanbulIso(e) });
                            _a.label = 3;
                        case 3:
                            t += stepMinutes * 60 * 1000;
                            return [3 /*break*/, 1];
                        case 4: return [2 /*return*/, suggestions];
                    }
                });
            });
        };
        // =========================
        // LLM (FAQ / procedure)
        // =========================
        AgentService_1.prototype.answerWithLLM = function (opts) {
            return __awaiter(this, void 0, void 0, function () {
                var raw, business, services, staff, history, mode, focusService, avoidRepeat, servicesText, staffText, historyText, system, user, resp, out, e_4;
                var _a, _b, _c;
                return __generator(this, function (_d) {
                    switch (_d.label) {
                        case 0:
                            if (!this.openai)
                                return [2 /*return*/, ''];
                            raw = opts.raw, business = opts.business, services = opts.services, staff = opts.staff, history = opts.history, mode = opts.mode, focusService = opts.focusService, avoidRepeat = opts.avoidRepeat;
                            servicesText = servicesToTextShort(services);
                            staffText = staffToTextShort(staff);
                            historyText = history && history.length
                                ? history
                                    .slice(-8)
                                    .map(function (h) { return "".concat(h.role === 'user' ? 'Müşteri' : 'Asistan', ": ").concat(h.text); })
                                    .join('\n')
                                : 'YOK';
                            system = "\nSen bir g\u00FCzellik merkezi WhatsApp asistan\u0131s\u0131n. T\u00FCrk\u00E7e konu\u015F.\nKurallar:\n- Cevaplar KISA olsun (maks 2-4 c\u00FCmle).\n- Durduk yere fiyat listesi / randevu y\u00F6nlendirmesi yapma.\n- Fiyat sadece m\u00FC\u015Fteri sorarsa ver; m\u00FCmk\u00FCnse ilgili hizmete \u00F6zel ver.\n- M\u00FC\u015Fteri randevu/rezervasyon demeden randevu ak\u0131\u015F\u0131na sokma.\n- Prosed\u00FCr sorular\u0131nda (ac\u0131t\u0131r m\u0131, ka\u00E7 seans, nas\u0131l yap\u0131l\u0131r, sonras\u0131 bak\u0131m, yan etki, kimlere uygun de\u011Fil) genel bilgi ver ama kesin t\u0131bbi iddia yapma.\n- Ayn\u0131 mesaj\u0131 tekrarlama. Gerekirse tek k\u0131sa soru sor.\n- \u0130nternete eri\u015Fimin yok; \"internetten bakt\u0131m\" gibi \u015Feyler s\u00F6yleme.\n".trim();
                            // Prosedür moduna özel ilave talimatlar
                            if (mode === 'procedure') {
                                system += "\n- Prosed\u00FCr modunda yumu\u015Fak ve samimi bir dille yan\u0131t ver; cevaplar\u0131n sonuna \"randevu ister misiniz?\" demeden, cevab\u0131n ak\u0131\u015F\u0131nda \"istersen yard\u0131mc\u0131 olurum\" gibi nazik ifadeler ekleyebilirsin.\n- Fiyat veya uzun liste verme; soruya 2-4 c\u00FCmlede genel bir a\u00E7\u0131klama yap.";
                            }
                            // Tekrar önleyici mod aktifse talimat ekle
                            if (avoidRepeat) {
                                system += "\n- Ayn\u0131 c\u00FCmleleri veya ifadeleri tekrar etme; cevab\u0131n\u0131 farkl\u0131 \u015Fekilde yaz ve m\u00FCmk\u00FCnse yeni bir bak\u0131\u015F a\u00E7\u0131s\u0131 ekle.";
                            }
                            user = "\nMod: ".concat(mode, "\nM\u00FC\u015Fteri mesaj\u0131: ").concat(raw, "\n\nOdak hizmet (varsa): ").concat(focusService ? JSON.stringify(focusService) : 'YOK', "\n\n\u0130\u015Fletme verisi: ").concat(business ? JSON.stringify(business) : 'YOK', "\n\nHizmetler (k\u0131sa):\n").concat(servicesText || 'YOK', "\n\nUzmanlar (k\u0131sa):\n").concat(staffText || 'YOK', "\n\nSon konu\u015Fma ge\u00E7mi\u015Fi:\n").concat(historyText, "\n").trim();
                            _d.label = 1;
                        case 1:
                            _d.trys.push([1, 3, , 4]);
                            return [4 /*yield*/, this.openai.chat.completions.create({
                                    model: 'gpt-4o-mini',
                                    // Temperature: orta seviye tut; tekrar için artabilir
                                    temperature: avoidRepeat ? 0.7 : 0.6,
                                    messages: [
                                        { role: 'system', content: system },
                                        { role: 'user', content: user },
                                    ],
                                })];
                        case 2:
                            resp = _d.sent();
                            out = (((_c = (_b = (_a = resp.choices) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.message) === null || _c === void 0 ? void 0 : _c.content) || '').trim();
                            return [2 /*return*/, out && out.length >= 2 ? out : ''];
                        case 3:
                            e_4 = _d.sent();
                            this.logger.warn("[LLM] ".concat((e_4 === null || e_4 === void 0 ? void 0 : e_4.message) || e_4));
                            return [2 /*return*/, ''];
                        case 4: return [2 /*return*/];
                    }
                });
            });
        };
        AgentService_1.prototype.procedureTemplateForService = function (serviceName, duration, price) {
            var parts = [];
            parts.push("".concat(serviceName, " i\u00E7in genel olarak s\u00FCre\u00E7 ki\u015Fiye g\u00F6re de\u011Fi\u015Febilir."));
            if (duration != null)
                parts.push("Seans s\u00FCresi genelde ".concat(duration, " dk civar\u0131d\u0131r."));
            parts.push('Kaç seans gerektiği; bölge, kıl tipi ve cilt yapısına göre değişir.');
            var base = parts.join(' ');
            var priceLine = price != null ? "\nFiyat: ".concat(price, "\u20BA") : '';
            // randevu nudgesi yok (spam olmasın)
            return base + priceLine;
        };
        // =========================
        // DB lists
        // =========================
        AgentService_1.prototype.safeListServices = function (tenantId) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.service
                                .findMany({
                                where: { tenantId: tenantId, isActive: true },
                                select: { id: true, name: true, price: true, duration: true },
                                take: 50,
                            })
                                .catch(function () { return []; })];
                        case 1: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        AgentService_1.prototype.safeListStaff = function (tenantId) {
            return __awaiter(this, void 0, void 0, function () {
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0: return [4 /*yield*/, ((_a = this.prisma.staff) === null || _a === void 0 ? void 0 : _a.findMany({
                                where: { tenantId: tenantId, isActive: true },
                                select: { id: true, fullName: true },
                                take: 50,
                            }).catch(function () { return []; }))];
                        case 1: return [2 /*return*/, _b.sent()];
                    }
                });
            });
        };
        // =========================
        // Session helpers
        // =========================
        AgentService_1.prototype.getOrInitSession = function (key, tenantId, phone) {
            var existing = this.sessions.get(key);
            if (existing) {
                // TTL 2 saat
                if (Date.now() - existing.updatedAt > 2 * 60 * 60 * 1000) {
                    var fresh = this.makeFreshSession(tenantId, phone);
                    this.sessions.set(key, fresh);
                    return fresh;
                }
                existing.updatedAt = Date.now();
                return existing;
            }
            var s = this.makeFreshSession(tenantId, phone);
            this.sessions.set(key, s);
            return s;
        };
        AgentService_1.prototype.makeFreshSession = function (tenantId, phone) {
            return {
                state: WaState.IDLE,
                draft: { tenantId: tenantId, customerPhone: phone },
                updatedAt: Date.now(),
                history: [],
                // yeni alanlar başlangıç değerleri
                lastAssistantText: undefined,
                lastAssistantReply: undefined,
                lastTopic: undefined,
                lastServiceId: undefined,
                repeatCount: 0,
                lastUserTextNorm: undefined,
                lastUserAt: undefined,
                lastCreatedBookingKey: undefined,
                lastCreatedAppointmentId: undefined,
                lastCreatedAt: undefined
            };
        };
        AgentService_1.prototype.saveSession = function (key, s) {
            s.updatedAt = Date.now();
            this.sessions.set(key, s);
        };
        AgentService_1.prototype.resetSession = function (key, tenantId, phone) {
            this.sessions.set(key, this.makeFreshSession(tenantId, phone));
        };
        // =========================
        // Memory / Anti-spam helpers
        // =========================
        AgentService_1.prototype.recordHistory = function (session, role, text) {
            var clean = (text || '').trim();
            if (!clean)
                return;
            session.history.push({ role: role, text: clean, ts: Date.now() });
            // son 20 turn kalsın
            if (session.history.length > 20)
                session.history = session.history.slice(-20);
        };
        AgentService_1.prototype.getRecentHistory = function (session, maxTurns) {
            var _a;
            if (!((_a = session.history) === null || _a === void 0 ? void 0 : _a.length))
                return [];
            return session.history.slice(-Math.max(1, maxTurns));
        };
        AgentService_1.prototype.isLikelyDuplicateInbound = function (session, raw) {
            var t = normalizeTr(raw);
            if (!t)
                return false;
            var now = Date.now();
            // 15 saniye içinde aynı mesaj tekrar geldiyse retry say
            if (session.lastUserTextNorm && session.lastUserAt) {
                if (session.lastUserTextNorm === t && now - session.lastUserAt < 15000) {
                    return true;
                }
            }
            session.lastUserTextNorm = t;
            session.lastUserAt = now;
            return false;
        };
        AgentService_1.prototype.makeBookingKey = function (tenantId, phone, draft) {
            if (!(draft === null || draft === void 0 ? void 0 : draft.serviceId) || !(draft === null || draft === void 0 ? void 0 : draft.startAt))
                return '';
            var staff = draft.staffId ? String(draft.staffId) : '-';
            return "".concat(tenantId, "|").concat(phone, "|").concat(String(draft.serviceId), "|").concat(staff, "|").concat(String(draft.startAt));
        };
        AgentService_1.prototype.safeReply = function (session, reply) {
            var out = (reply || '').trim();
            if (!out)
                out = 'Tamam 👍';
            var prev = session.lastAssistantReply || session.lastAssistantText || '';
            var same = prev && normalizeTr(prev) === normalizeTr(out);
            if (same) {
                session.repeatCount = (session.repeatCount || 0) + 1;
                if (session.repeatCount === 1) {
                    out = out + ' 🙂';
                }
                else {
                    out = 'Anladım 🙂 Hangi hizmet/bölge için düşünüyorsun?';
                    session.repeatCount = 0;
                }
            }
            else {
                session.repeatCount = 0;
            }
            session.lastAssistantReply = out;
            session.lastAssistantText = out; // legacy
            this.recordHistory(session, 'assistant', out);
            return out;
        };
        AgentService_1.prototype.shouldNudgeBooking = function (session) {
            // ✅ sadece bağlam uygunsa küçük nudgelar
            var recent = this.getRecentHistory(session, 6).map(function (h) { return normalizeTr(h.text); }).join(' ');
            return recent.includes('randevu') || recent.includes('rezervasyon') || recent.includes('uygun') || recent.includes('yarin') || recent.includes('bugun');
        };
        // =========================
        // Matching
        // =========================
        AgentService_1.prototype.tryAutofillService = function (draft, services, msg) {
            if (draft.serviceId)
                return;
            var hit = this.detectServiceFromMessage(msg, services);
            if (hit === null || hit === void 0 ? void 0 : hit.id)
                draft.serviceId = String(hit.id);
        };
        AgentService_1.prototype.tryAutofillStaff = function (draft, staff, msg) {
            if (draft.staffId)
                return;
            var t = normalizeTr(msg);
            var words = t.split(/\s+/).filter(Boolean);
            var hit = staff.find(function (p) { return normalizeTr(String((p === null || p === void 0 ? void 0 : p.fullName) || '')).includes(t); }) ||
                staff.find(function (p) {
                    var name = normalizeTr(String((p === null || p === void 0 ? void 0 : p.fullName) || ''));
                    return words.some(function (w) { return w.length >= 3 && name.includes(w); });
                });
            if (hit === null || hit === void 0 ? void 0 : hit.id)
                draft.staffId = String(hit.id);
        };
        AgentService_1.prototype.detectServiceFromMessage = function (raw, services) {
            if (!services || services.length === 0)
                return null;
            var t = normalizeTr(raw);
            var words = t.split(/\s+/).filter(Boolean);
            // önce tam içerme
            var direct = services.find(function (s) { return normalizeTr(String((s === null || s === void 0 ? void 0 : s.name) || '')).includes(t); });
            if (direct)
                return direct;
            // sonra kelime eşleşmesi
            var best = services.find(function (s) {
                var name = normalizeTr(String((s === null || s === void 0 ? void 0 : s.name) || ''));
                return words.some(function (w) { return w.length >= 3 && name.includes(w); });
            });
            return best || null;
        };
        return AgentService_1;
    }());
    __setFunctionName(_classThis, "AgentService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        AgentService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return AgentService = _classThis;
}();
exports.AgentService = AgentService;
// =========================
// Helpers
// =========================
function normalizeTr(s) {
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
// ✅ Booking intent artık SADECE net tetikleyiciler
function looksLikeBookingIntent(msg) {
    var t = normalizeTr(msg);
    // sadece “randevu/rezervasyon” gibi NET ifadeler
    return (t === 'randevu' ||
        t.includes('randevu al') ||
        t.includes('randevu istiyorum') ||
        t.includes('randevu almak') ||
        t.includes('rezervasyon') ||
        t.includes('rezervasyon yap') ||
        t.includes('randevu yap'));
}
function looksLikeServiceListRequest(msg) {
    var t = normalizeTr(msg);
    return (t.includes('hizmetler') ||
        t.includes('hizmet list') ||
        t.includes('listeyi at') ||
        t.includes('neler var') ||
        t.includes('servisler'));
}
function looksLikePriceQuestion(msg) {
    var t = normalizeTr(msg);
    return t.includes('fiyat') || t.includes('ucret') || t.includes('ücret') || t.includes('kac tl') || t.includes('kaç tl');
}
function looksLikeAddressOrHours(msg) {
    var t = normalizeTr(msg);
    return t.includes('adres') || t.includes('konum') || t.includes('nerde') || t.includes('nerede') || t.includes('calisma saati') || t.includes('çalışma saati') || t.includes('kacda') || t.includes('kaçta');
}
// ✅ booking akışında konu değişimi / vazgeçme algısı
function shouldExitBookingFlow(msgNorm, raw) {
    // onay beklerken evet/hayır normal; exit sayma
    if (isYes(msgNorm) || isNo(msgNorm))
        return false;
    var t = normalizeTr(raw);
    if (!t)
        return false;
    return (t.includes('selam') ||
        t.includes('aleykum') ||
        t.includes('aleyk') ||
        t.includes('merhaba') ||
        t.includes('naber') ||
        t.includes('tesekkur') ||
        t.includes('teşekkür') ||
        t.includes('bilgi') ||
        t.includes('soru') ||
        t.includes('istemiyorum') ||
        t.includes('vazgec') ||
        t.includes('vazgeç') ||
        t === 'hayir' ||
        t === 'hayır');
}
function looksLikeProcedureQuestion(msg) {
    var t = normalizeTr(msg);
    return (t.includes('nasil') ||
        t.includes('nasıl') ||
        t.includes('surec') ||
        t.includes('süreç') ||
        t.includes('kac seans') ||
        t.includes('kaç seans') ||
        t.includes('seans') ||
        t.includes('acitir') ||
        t.includes('acıtır') ||
        t.includes('can yakar') ||
        t.includes('zararli') ||
        t.includes('zararlı') ||
        t.includes('yan etk') ||
        t.includes('risk') ||
        // eklenen tetikleyiciler: sonrası bakım ve kimlere uygun değil gibi ifadeler
        t.includes('sonrasi') ||
        t.includes('sonrası') ||
        t.includes('bakim') ||
        t.includes('bakım') ||
        t.includes('kimlere uygun degil') ||
        t.includes('kimlere uygun değil') ||
        t.includes('kimler icin uygun degil') ||
        t.includes('kimler için uygun değil'));
}
function isCancel(msg) {
    var t = normalizeTr(msg);
    return t === 'iptal' || t.includes('iptal et') || t.includes('vazgectim') || t.includes('vazgec') || t.includes('vazgeç');
}
function isRestart(msg) {
    var t = normalizeTr(msg);
    return t === 'bastan' || t === 'baştan' || t.includes('yeniden') || t.includes('sifirla') || t.includes('sıfırla');
}
function isYes(msg) {
    var t = normalizeTr(msg);
    return t === 'e' || t === 'evet' || t.includes('onay') || t.includes('tamam');
}
function isNo(msg) {
    var t = normalizeTr(msg);
    return t === 'h' || t === 'hayir' || t === 'hayır' || t.includes('istemiyorum') || t.includes('iptal') || t.includes('degil') || t.includes('değil');
}
function servicesToTextShort(services) {
    if (!services || services.length === 0)
        return '';
    return services
        .slice(0, 6)
        .map(function (s) {
        var name = String((s === null || s === void 0 ? void 0 : s.name) || 'Hizmet');
        var price = (s === null || s === void 0 ? void 0 : s.price) != null ? "".concat(s.price, "\u20BA") : '-';
        var dur = (s === null || s === void 0 ? void 0 : s.duration) != null ? "".concat(s.duration, " dk") : '-';
        return "\u2022 ".concat(name, " (").concat(price, ", ").concat(dur, ")");
    })
        .join('\n');
}
function staffToTextShort(staff) {
    if (!staff || staff.length === 0)
        return '';
    return staff
        .slice(0, 6)
        .map(function (p) { return "\u2022 ".concat(String((p === null || p === void 0 ? void 0 : p.fullName) || 'Uzman')); })
        .join('\n');
}
function extractName(raw) {
    var s = (raw || '').trim();
    if (!s)
        return null;
    if (s.length < 2)
        return null;
    if (/^\+?\d[\d\s-]+$/.test(s))
        return null;
    var m = s.match(/^(ben\s+)?([a-zA-ZÇĞİÖŞÜçğıöşü\s]{2,})$/);
    if (!m)
        return null;
    return m[2].trim();
}
/**
 * ✅ TR datetime parse
 */
function parseDateTimeTR(raw) {
    var s = (raw || '').trim();
    if (!s)
        return null;
    var t = normalizeTr(s);
    var now = new Date();
    var hasTomorrow = t.includes('yarin');
    var hasToday = t.includes('bugun') || t.includes('bugün');
    var mNumeric = t.match(/\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b/);
    var mMonth = t.match(/\b(\d{1,2})\s+(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/);
    var timeOnly = parseTimeBest(t);
    var base = new Date(now.getTime());
    if (hasTomorrow)
        base = addDays(base, 1);
    var year = base.getFullYear();
    var month = base.getMonth();
    var day = base.getDate();
    if (mNumeric) {
        day = Number(mNumeric[1]);
        month = Number(mNumeric[2]) - 1;
        if (mNumeric[3]) {
            var y = Number(mNumeric[3]);
            year = y < 100 ? 2000 + y : y;
        }
    }
    else if (mMonth) {
        day = Number(mMonth[1]);
        month = monthNameToIndex(mMonth[2]);
    }
    else if (!hasTomorrow && !hasToday && !timeOnly) {
        return null;
    }
    var hh = 10;
    var mm = 0;
    if (timeOnly) {
        hh = timeOnly.hh;
        mm = timeOnly.mm;
    }
    var d = new Date(year, month, day, hh, mm, 0, 0);
    if (isNaN(d.getTime()))
        return null;
    var hasExplicitDate = Boolean(mNumeric || mMonth || hasTomorrow || hasToday);
    if (!hasExplicitDate && timeOnly && d.getTime() <= now.getTime())
        return addDays(d, 1);
    return d;
}
function parseTimeBest(t) {
    var matches = [];
    var reStrong = /(\d{1,2})\s*[:.]\s*(\d{2})/g;
    var m;
    while ((m = reStrong.exec(t))) {
        var hh = Number(m[1]);
        var mm = Number(m[2]);
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)
            matches.push({ hh: hh, mm: mm, idx: m.index });
    }
    if (matches.length === 0 && t.includes('saat')) {
        var reWeak = /saat\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?/g;
        while ((m = reWeak.exec(t))) {
            var hh = Number(m[1]);
            var mm = m[2] ? Number(m[2]) : 0;
            if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)
                matches.push({ hh: hh, mm: mm, idx: m.index });
        }
    }
    if (matches.length === 0)
        return null;
    var last = matches[matches.length - 1];
    return { hh: last.hh, mm: last.mm };
}
function monthNameToIndex(m) {
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
function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
}
// ✅ geçmişe düşerse ileri al
function clampToFuture(d) {
    var now = new Date();
    if (d.getTime() > now.getTime())
        return d;
    var x = new Date(d.getTime());
    for (var i = 0; i < 366; i++) {
        x = addDays(x, 1);
        if (x.getTime() > now.getTime())
            return x;
    }
    return addDays(now, 1);
}
// ISO with +03:00
function toIstanbulIso(d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var year = d.getFullYear();
    var month = pad(d.getMonth() + 1);
    var day = pad(d.getDate());
    var hh = pad(d.getHours());
    var mm = pad(d.getMinutes());
    var ss = pad(d.getSeconds());
    return "".concat(year, "-").concat(month, "-").concat(day, "T").concat(hh, ":").concat(mm, ":").concat(ss, "+03:00");
}
function prettyIstanbul(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime()))
        return iso;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return "".concat(pad(d.getDate()), ".").concat(pad(d.getMonth() + 1), ".").concat(d.getFullYear(), " ").concat(pad(d.getHours()), ":").concat(pad(d.getMinutes()));
}
