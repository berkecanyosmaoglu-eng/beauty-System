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
exports.WhatsappService = void 0;
var common_1 = require("@nestjs/common");
var WhatsappService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var WhatsappService = _classThis = /** @class */ (function () {
        function WhatsappService_1(prisma) {
            this.prisma = prisma;
            this.logger = new common_1.Logger(WhatsappService.name);
        }
        // --- TWILIO RESPONSE ---
        WhatsappService_1.prototype.toTwimlMessage = function (text) {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>".concat(this.escapeXml(text), "</Message>\n</Response>");
        };
        WhatsappService_1.prototype.escapeXml = function (s) {
            return (s || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
        };
        // --- TENANT ROUTING (TEMP) ---
        WhatsappService_1.prototype.resolveTenantIdByToNumber = function (_to) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, null];
                });
            });
        };
        // =========================
        // ✅ DB LOGGING (BotConversation + BotMessage)
        // =========================
        WhatsappService_1.prototype.normalizeFrom = function (from) {
            return String(from || '').replace('whatsapp:', '').trim();
        };
        WhatsappService_1.prototype.ensureConversation = function (tenantId, fromPhone) {
            return __awaiter(this, void 0, void 0, function () {
                var externalUserId, existing, created;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            externalUserId = fromPhone;
                            return [4 /*yield*/, this.prisma.botConversation.findFirst({
                                    where: { tenantId: tenantId, channel: 'WHATSAPP', externalUserId: externalUserId },
                                    select: { id: true },
                                })];
                        case 1:
                            existing = _a.sent();
                            if (existing)
                                return [2 /*return*/, existing.id];
                            return [4 /*yield*/, this.prisma.botConversation.create({
                                    data: {
                                        tenantId: tenantId,
                                        channel: 'WHATSAPP',
                                        externalUserId: externalUserId,
                                        isOpen: true,
                                    },
                                    select: { id: true },
                                })];
                        case 2:
                            created = _a.sent();
                            return [2 /*return*/, created.id];
                    }
                });
            });
        };
        WhatsappService_1.prototype.logMessage = function (args) {
            return __awaiter(this, void 0, void 0, function () {
                var text;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            text = String(args.text || '').trim();
                            if (!text)
                                return [2 /*return*/];
                            return [4 /*yield*/, this.prisma.botMessage.create({
                                    data: {
                                        tenantId: args.tenantId,
                                        conversationId: args.conversationId,
                                        role: args.role,
                                        text: text,
                                        rawJson: (_a = args.rawJson) !== null && _a !== void 0 ? _a : undefined,
                                    },
                                })];
                        case 1:
                            _b.sent();
                            return [2 /*return*/];
                    }
                });
            });
        };
        WhatsappService_1.prototype.replyAndLog = function (tenantId, conversationId, replyText, rawJson) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.logMessage({
                                tenantId: tenantId,
                                conversationId: conversationId,
                                role: 'BOT',
                                text: replyText,
                                rawJson: rawJson,
                            })];
                        case 1:
                            _a.sent();
                            return [2 /*return*/, replyText];
                    }
                });
            });
        };
        // --- MAIN FLOW ---
        WhatsappService_1.prototype.handleIncoming = function (input) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, text, lower, phone, conversationId, session, state, _a, service, staff, date, time, s2, date, requestedLabel, s3, st, service, customer, startAt, durationMin, endAt, okMsg, e_1;
                var _b, _c, _d, _e;
                return __generator(this, function (_f) {
                    switch (_f.label) {
                        case 0:
                            // Basic validation
                            if (!input.tenantId) {
                                return [2 /*return*/, 'Merhaba! (tenant bulunamadı) Test için webhook’a tenantId gönderelim.'];
                            }
                            if (!input.from || !input.text) {
                                return [2 /*return*/, 'Mesajınızı göremedim. Lütfen tekrar yazar mısınız?'];
                            }
                            tenantId = String(input.tenantId).trim();
                            text = String(input.text || '').trim();
                            lower = text.toLowerCase();
                            phone = this.normalizeFrom(input.from);
                            return [4 /*yield*/, this.ensureConversation(tenantId, phone)];
                        case 1:
                            conversationId = _f.sent();
                            return [4 /*yield*/, this.logMessage({
                                    tenantId: tenantId,
                                    conversationId: conversationId,
                                    role: 'USER',
                                    text: text,
                                    rawJson: { from: input.from, to: input.to, contentType: input.contentType, raw: input.raw },
                                })];
                        case 2:
                            _f.sent();
                            return [4 /*yield*/, this.upsertSession(tenantId, phone)];
                        case 3:
                            session = _f.sent();
                            state = (_b = (session.data || { step: 'START' })) !== null && _b !== void 0 ? _b : { step: 'START' };
                            if (!/(iptal|vazgeç|cancel|boşver)/i.test(lower)) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'START' })];
                        case 4:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Tamamdır. İstersen tekrar yaz, randevu için yardımcı olurum.')];
                        case 5:
                            _a = state.step;
                            switch (_a) {
                                case 'START': return [3 /*break*/, 6];
                                case 'ASK_NAME': return [3 /*break*/, 8];
                                case 'ASK_SERVICE': return [3 /*break*/, 10];
                                case 'ASK_STAFF': return [3 /*break*/, 13];
                                case 'ASK_DATE': return [3 /*break*/, 16];
                                case 'ASK_TIME': return [3 /*break*/, 18];
                                case 'CONFIRM': return [3 /*break*/, 21];
                            }
                            return [3 /*break*/, 39];
                        case 6: return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_NAME' })];
                        case 7:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Merhaba! Randevu için adınızı yazar mısınız?')];
                        case 8: return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_SERVICE', name: text.slice(0, 60) })];
                        case 9:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Hangi hizmeti almak istiyorsunuz? (ör: lazer, cilt, tırnak)')];
                        case 10: return [4 /*yield*/, this.prisma.service.findFirst({
                                where: { tenantId: tenantId, name: { contains: text, mode: 'insensitive' } },
                                select: { id: true, name: true, duration: true },
                            })];
                        case 11:
                            service = _f.sent();
                            if (!service) {
                                return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Bu hizmeti bulamadım. Daha kısa yazar mısın? (ör: lazer)')];
                            }
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_STAFF', serviceId: service.id })];
                        case 12:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Hangi personel/usta olsun? (bilmiyorsan "fark etmez" yaz)')];
                        case 13: return [4 /*yield*/, this.prisma.staff.findFirst({
                                where: { tenantId: tenantId },
                                select: { id: true },
                            })];
                        case 14:
                            staff = _f.sent();
                            if (!staff) {
                                return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Personel bulunamadı. Önce staff ekleyelim.')];
                            }
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_DATE', staffId: staff.id })];
                        case 15:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Hangi gün istiyorsunuz? (YYYY-AA-GG ör: 2026-02-07) veya "yarın"')];
                        case 16:
                            date = this.parseDateToISO(text);
                            if (!date) {
                                return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Tarihi anlayamadım. Örnek: 2026-02-07 ya da "yarın"')];
                            }
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_TIME', date: date })];
                        case 17:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Saat kaç olsun? (HH:mm ör: 15:30)')];
                        case 18:
                            time = this.parseTime(text);
                            if (!time) {
                                return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Saati anlayamadım. Örnek: 15:30')];
                            }
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'CONFIRM', time: time })];
                        case 19:
                            _f.sent();
                            return [4 /*yield*/, this.getSession(session.id)];
                        case 20:
                            s2 = _f.sent();
                            date = String(((_d = (_c = s2 === null || s2 === void 0 ? void 0 : s2.data) === null || _c === void 0 ? void 0 : _c.date) !== null && _d !== void 0 ? _d : '')).trim();
                            requestedLabel = "".concat(date, " ").concat(time).trim();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, "\u00D6zet: ".concat(requestedLabel, " i\u00E7in randevu olu\u015Ftural\u0131m m\u0131? (evet/hay\u0131r)"))];
                        case 21:
                            if (!!/(evet|ok|tamam|onay)/i.test(lower)) return [3 /*break*/, 23];
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_TIME' })];
                        case 22:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Tamam. O zaman farklı bir saat yaz (HH:mm).')];
                        case 23: return [4 /*yield*/, this.getSession(session.id)];
                        case 24:
                            s3 = _f.sent();
                            st = ((_e = s3 === null || s3 === void 0 ? void 0 : s3.data) !== null && _e !== void 0 ? _e : {}) || {};
                            if (!(!st.date || !st.time || !st.serviceId || !st.name)) return [3 /*break*/, 26];
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'START' })];
                        case 25:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Bir şey karıştı 🙈 Baştan alalım: adınızı yazar mısınız?')];
                        case 26:
                            _f.trys.push([26, 37, , 39]);
                            return [4 /*yield*/, this.prisma.service.findUnique({
                                    where: { id: st.serviceId },
                                    select: { duration: true, name: true },
                                })];
                        case 27:
                            service = _f.sent();
                            if (!!service) return [3 /*break*/, 29];
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'START' })];
                        case 28:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Hizmet bulunamadı. Baştan alalım.')];
                        case 29: return [4 /*yield*/, this.prisma.customer.findFirst({
                                where: { tenantId: tenantId, phone: phone },
                                select: { id: true },
                            })];
                        case 30:
                            customer = _f.sent();
                            if (!!customer) return [3 /*break*/, 32];
                            return [4 /*yield*/, this.prisma.customer.create({
                                    data: {
                                        tenantId: tenantId,
                                        fullName: st.name,
                                        phone: phone,
                                        whatsappPhone: phone,
                                    },
                                    select: { id: true },
                                })];
                        case 31:
                            customer = _f.sent();
                            _f.label = 32;
                        case 32:
                            startAt = new Date("".concat(st.date, "T").concat(st.time, ":00"));
                            if (!Number.isNaN(startAt.getTime())) return [3 /*break*/, 34];
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'ASK_DATE' })];
                        case 33:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Tarih/saat formatı hatalı. Tarihi tekrar yazar mısın?')];
                        case 34:
                            durationMin = Number(service.duration || 30);
                            endAt = new Date(startAt.getTime() + durationMin * 60000);
                            return [4 /*yield*/, this.prisma.appointment.create({
                                    data: {
                                        tenantId: tenantId,
                                        customerId: customer.id,
                                        serviceId: st.serviceId,
                                        staffId: st.staffId || null,
                                        startAt: startAt,
                                        endAt: endAt,
                                        channel: 'WHATSAPP',
                                        status: 'scheduled',
                                    },
                                })];
                        case 35:
                            _f.sent();
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'START' })];
                        case 36:
                            _f.sent();
                            okMsg = "\u2705 Randevu olu\u015Fturuldu: ".concat(st.date, " ").concat(st.time, " (").concat(service.name, ")");
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, okMsg)];
                        case 37:
                            e_1 = _f.sent();
                            this.logger.warn("appointment.create failed: ".concat((e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || e_1));
                            return [4 /*yield*/, this.updateSession(session.id, { step: 'START' })];
                        case 38:
                            _f.sent();
                            return [2 /*return*/, this.replyAndLog(tenantId, conversationId, 'Randevu kaydı şu an oluşturulamadı. (Sistemde küçük bir hata var) 1 dk içinde düzeltiyorum.', { error: (e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || String(e_1) })];
                        case 39: return [2 /*return*/];
                    }
                });
            });
        };
        // -------------------------
        // Session persistence (CallSession)
        // -------------------------
        WhatsappService_1.prototype.upsertSession = function (tenantId, phone) {
            return __awaiter(this, void 0, void 0, function () {
                var existing;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.callSession.findFirst({
                                where: { tenantId: tenantId, phone: phone },
                            })];
                        case 1:
                            existing = _a.sent();
                            if (existing)
                                return [2 /*return*/, existing];
                            return [2 /*return*/, this.prisma.callSession.create({
                                    data: {
                                        tenantId: tenantId,
                                        phone: phone,
                                        step: 'whatsapp',
                                        data: { step: 'START' },
                                    },
                                })];
                    }
                });
            });
        };
        WhatsappService_1.prototype.getSession = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, this.prisma.callSession.findUnique({ where: { id: id } })];
                });
            });
        };
        WhatsappService_1.prototype.updateSession = function (id, patch) {
            return __awaiter(this, void 0, void 0, function () {
                var s, current, next;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.callSession.findUnique({ where: { id: id } })];
                        case 1:
                            s = _a.sent();
                            current = ((s === null || s === void 0 ? void 0 : s.data) || { step: 'START' });
                            next = __assign(__assign({}, current), patch);
                            return [4 /*yield*/, this.prisma.callSession.update({
                                    where: { id: id },
                                    data: { data: next },
                                })];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        };
        // -------------------------
        // Parsing
        // -------------------------
        WhatsappService_1.prototype.parseDateToISO = function (input) {
            var s = input.trim().toLowerCase();
            var now = new Date();
            if (s === 'yarın' || s === 'yarin') {
                var d = new Date(now);
                d.setDate(d.getDate() + 1);
                return d.toISOString().slice(0, 10);
            }
            if (/^\d{4}-\d{2}-\d{2}$/.test(s))
                return s;
            return null;
        };
        WhatsappService_1.prototype.parseTime = function (input) {
            var s = input.trim();
            if (/^\d{1,2}:\d{2}$/.test(s)) {
                var _a = s.split(':').map(Number), hh = _a[0], mm = _a[1];
                if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
                    return "".concat(String(hh).padStart(2, '0'), ":").concat(String(mm).padStart(2, '0'));
                }
            }
            return null;
        };
        return WhatsappService_1;
    }());
    __setFunctionName(_classThis, "WhatsappService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        WhatsappService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return WhatsappService = _classThis;
}();
exports.WhatsappService = WhatsappService;
