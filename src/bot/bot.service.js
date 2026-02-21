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
exports.BotService = void 0;
var common_1 = require("@nestjs/common");
var openai_1 = require("openai");
var BotService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var BotService = _classThis = /** @class */ (function () {
        function BotService_1(prisma, appointmentsService) {
            this.prisma = prisma;
            this.appointmentsService = appointmentsService;
            this.logger = new common_1.Logger(BotService.name);
            this.openai = new openai_1.default({
                apiKey: process.env.OPENAI_API_KEY,
            });
        }
        /**
         * ALWAYS return TwiML (XML).
         */
        BotService_1.prototype.handleVoice = function (params) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, callSid, from, actionUrl, session, sdata, saidRaw, servicesRaw, staffRaw, services, staff, decision, created, say;
                var _this = this;
                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
                return __generator(this, function (_p) {
                    switch (_p.label) {
                        case 0:
                            tenantId = params.tenantId, callSid = params.callSid, from = params.from, actionUrl = params.actionUrl;
                            return [4 /*yield*/, this.getOrCreateCallSession({ tenantId: tenantId, callSid: callSid, from: from })];
                        case 1:
                            session = _p.sent();
                            sdata = (session === null || session === void 0 ? void 0 : session.data) || {};
                            if (!!sdata.greeted) return [3 /*break*/, 3];
                            sdata.greeted = true;
                            sdata.noInputCount = 0;
                            return [4 /*yield*/, this.updateSessionData(session.id, sdata)];
                        case 2:
                            _p.sent();
                            return [2 /*return*/, this.twimlGather('Merhaba, hoş geldiniz. Hangi işlem için arıyordunuz?', actionUrl)];
                        case 3:
                            saidRaw = (params.input || '').trim();
                            if (!!saidRaw) return [3 /*break*/, 5];
                            sdata.noInputCount = ((_a = sdata.noInputCount) !== null && _a !== void 0 ? _a : 0) + 1;
                            return [4 /*yield*/, this.updateSessionData(session.id, sdata)];
                        case 4:
                            _p.sent();
                            if (sdata.noInputCount >= 2) {
                                return [2 /*return*/, this.twimlGather('Sizi duyamadım. Sadece hangi işlemi istediğinizi söyleyin: örneğin lazer, cilt bakımı, manikür gibi.', actionUrl)];
                            }
                            return [2 /*return*/, this.twimlGather('Size nasıl yardımcı olabilirim?', actionUrl)];
                        case 5:
                            if (!sdata.noInputCount) return [3 /*break*/, 7];
                            sdata.noInputCount = 0;
                            return [4 /*yield*/, this.updateSessionData(session.id, sdata)];
                        case 6:
                            _p.sent();
                            _p.label = 7;
                        case 7: return [4 /*yield*/, this.safeFindMany('service', function () {
                                return _this.prisma.service.findMany({
                                    where: { tenantId: tenantId },
                                    select: { id: true, name: true },
                                });
                            })];
                        case 8:
                            servicesRaw = _p.sent();
                            return [4 /*yield*/, this.safeFindMany('staff', function () {
                                    return _this.prisma.staff.findMany({
                                        where: { tenantId: tenantId },
                                        select: { id: true, fullName: true },
                                    });
                                })];
                        case 9:
                            staffRaw = _p.sent();
                            services = servicesRaw.map(function (s) { return ({ id: s.id, name: s.name }); });
                            staff = staffRaw.map(function (p) { return ({ id: p.id, name: p.fullName }); });
                            return [4 /*yield*/, this.aiBrain({
                                    said: saidRaw,
                                    services: services,
                                    staff: staff,
                                    sessionData: sdata,
                                })];
                        case 10:
                            decision = _p.sent();
                            if (!(decision.action === 'BOOK')) return [3 /*break*/, 13];
                            // Write to session (for debugging)
                            sdata.serviceId = (_c = (_b = decision.data.serviceId) !== null && _b !== void 0 ? _b : sdata.serviceId) !== null && _c !== void 0 ? _c : null;
                            sdata.staffId = (_e = (_d = decision.data.staffId) !== null && _d !== void 0 ? _d : sdata.staffId) !== null && _e !== void 0 ? _e : null;
                            sdata.dateISO = (_g = (_f = decision.data.dateISO) !== null && _f !== void 0 ? _f : sdata.dateISO) !== null && _g !== void 0 ? _g : null;
                            sdata.timeHHmm = (_j = (_h = decision.data.timeHHmm) !== null && _h !== void 0 ? _h : sdata.timeHHmm) !== null && _j !== void 0 ? _j : null;
                            sdata.customerName = (_l = (_k = decision.data.customerName) !== null && _k !== void 0 ? _k : sdata.customerName) !== null && _l !== void 0 ? _l : null;
                            return [4 /*yield*/, this.updateSessionData(session.id, sdata)];
                        case 11:
                            _p.sent();
                            return [4 /*yield*/, this.tryCreateAppointment({
                                    tenantId: tenantId,
                                    from: from,
                                    serviceId: decision.data.serviceId,
                                    staffId: (_m = decision.data.staffId) !== null && _m !== void 0 ? _m : null,
                                    dateISO: decision.data.dateISO,
                                    timeHHmm: decision.data.timeHHmm,
                                    customerName: (_o = decision.data.customerName) !== null && _o !== void 0 ? _o : null,
                                })];
                        case 12:
                            created = _p.sent();
                            if (!created.ok) {
                                return [2 /*return*/, this.twimlGather('Kusura bakmayın, randevuyu kaydederken kısa bir sorun yaşadım. Tekrar dener misiniz: hangi gün ve saat uygun?', actionUrl)];
                            }
                            say = (decision.say || '').trim() || 'Tamamdır.';
                            return [2 /*return*/, this.twimlGather("".concat(say, " Randevunuzu olu\u015Fturdum. Ba\u015Fka bir iste\u011Finiz var m\u0131?"), actionUrl)];
                        case 13: 
                        // Default: ASK / ANSWER
                        return [2 /*return*/, this.twimlGather(decision.say, actionUrl)];
                    }
                });
            });
        };
        // --------------------
        // Appointment create (logs and passes fromPhone to AppointmentsService)
        // --------------------
        BotService_1.prototype.tryCreateAppointment = function (args) {
            return __awaiter(this, void 0, void 0, function () {
                var phone, dt, prismaAny, customer, created, e_1;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            _b.trys.push([0, 5, , 6]);
                            phone = String(args.from || '').trim();
                            if (!phone)
                                return [2 /*return*/, { ok: false, error: 'missing_phone' }];
                            dt = new Date("".concat(args.dateISO, "T").concat(args.timeHHmm, ":00.000Z"));
                            if (Number.isNaN(dt.getTime()))
                                return [2 /*return*/, { ok: false, error: 'invalid_datetime' }];
                            prismaAny = this.prisma;
                            return [4 /*yield*/, prismaAny.customer.findFirst({
                                    where: { tenantId: args.tenantId, phone: phone },
                                    select: { id: true },
                                })];
                        case 1:
                            customer = _b.sent();
                            if (!!(customer === null || customer === void 0 ? void 0 : customer.id)) return [3 /*break*/, 3];
                            return [4 /*yield*/, prismaAny.customer.create({
                                    data: {
                                        tenantId: args.tenantId,
                                        fullName: ((_a = args.customerName) === null || _a === void 0 ? void 0 : _a.trim()) || phone,
                                        phone: phone,
                                        isActive: true,
                                    },
                                    select: { id: true },
                                })];
                        case 2:
                            customer = _b.sent();
                            _b.label = 3;
                        case 3:
                            // Log before booking
                            this.logger.log("[BOOKING] creating appointment tenantId=".concat(args.tenantId, " from=").concat(phone, " customerId=").concat(customer.id, " serviceId=").concat(args.serviceId, " staffId=").concat(args.staffId, " startAt=").concat(dt.toISOString()));
                            return [4 /*yield*/, this.appointmentsService.create({
                                    tenantId: args.tenantId,
                                    customerId: customer.id,
                                    serviceId: args.serviceId,
                                    staffId: args.staffId,
                                    startAt: dt.toISOString(),
                                    status: 'scheduled',
                                    // Pass caller number so AppointmentsService/NotificationsService can choose the correct phone
                                    fromPhone: args.from,
                                })];
                        case 4:
                            created = _b.sent();
                            // Log after booking
                            this.logger.log("[BOOKING] appointment created id=".concat(created.id, " from=").concat(phone));
                            return [2 /*return*/, { ok: true, id: created.id }];
                        case 5:
                            e_1 = _b.sent();
                            this.logger.error("tryCreateAppointment failed: ".concat((e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || e_1));
                            return [2 /*return*/, { ok: false, error: 'db_error' }];
                        case 6: return [2 /*return*/];
                    }
                });
            });
        };
        // --------------------
        // AI Brain
        // --------------------
        BotService_1.prototype.aiBrain = function (args) {
            return __awaiter(this, void 0, void 0, function () {
                var servicesText, staffText, system, r, raw, obj, d, e_2;
                var _a, _b, _c, _d, _e, _f;
                return __generator(this, function (_g) {
                    switch (_g.label) {
                        case 0:
                            servicesText = ((_a = args.services) === null || _a === void 0 ? void 0 : _a.length) > 0 ? args.services.map(function (s) { return "".concat(s.id, ":").concat(s.name); }).join(' | ') : 'YOK';
                            staffText = ((_b = args.staff) === null || _b === void 0 ? void 0 : _b.length) > 0 ? args.staff.map(function (s) { return "".concat(s.id, ":").concat(s.name); }).join(' | ') : 'YOK';
                            system = "\nSen T\u00FCrkiye'de \u00E7al\u0131\u015Fan, g\u00FCler y\u00FCzl\u00FC bir g\u00FCzellik merkezi dan\u0131\u015Fman\u0131s\u0131n.\nKonu\u015Fman do\u011Fal, ak\u0131c\u0131 ve k\u0131sa olsun.\n\n\u00C7OK \u00D6NEML\u0130 KURALLAR:\n- Her cevap 1 veya 2 c\u00FCmle olsun.\n- Asla liste, madde i\u015Fareti, numara veya markdown kullanma.\n- Her seferinde en fazla 1 soru sor.\n- Ayn\u0131 c\u00FCmleyi iki kez kurma.\n- Gereksiz bilgi verme.\n\nAMA\u00C7:\n- Kullan\u0131c\u0131n\u0131n istedi\u011Fi hizmeti anlay\u0131p do\u011Fru y\u00F6nlendirmek.\n- Genel sorular\u0131 cevaplamak.\n- Randevu olu\u015Fturmak istiyorsa BOOK aksiyonuna gitmek.\n\nSEN B\u0130R KARAR MOTORUSUN.\nSADECE JSON d\u00F6nd\u00FCr.\nJSON \u015Femas\u0131:\n- {\"action\":\"ASK\",\"say\":\"...\"}\n- {\"action\":\"ANSWER\",\"say\":\"...\"}\n- {\"action\":\"BOOK\",\"say\":\"...\",\"data\":{\"serviceId\":\"...\",\"dateISO\":\"YYYY-MM-DD\",\"timeHHmm\":\"HH:MM\",\"staffId\":null,\"customerName\":null}}\n\nBOOK i\u00E7in ZORUNLU alanlar:\n- serviceId\n- dateISO\n- timeHHmm\n\nserviceId ve staffId se\u00E7erken sadece a\u015Fa\u011F\u0131daki listelerdeki id'leri kullan.\n\nMevcut hizmetler (id:name): ".concat(servicesText, "\nMevcut personel (id:name): ").concat(staffText, "\n\nMevcut session (referans): ").concat(JSON.stringify(args.sessionData || {}), "\n").trim();
                            _g.label = 1;
                        case 1:
                            _g.trys.push([1, 3, , 4]);
                            return [4 /*yield*/, this.openai.chat.completions.create({
                                    model: 'gpt-4o-mini',
                                    temperature: 0.3,
                                    max_tokens: 220,
                                    response_format: { type: 'json_object' },
                                    messages: [
                                        { role: 'system', content: system },
                                        { role: 'user', content: args.said || '' },
                                    ],
                                })];
                        case 2:
                            r = _g.sent();
                            raw = ((_f = (_e = (_d = (_c = r.choices) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.content) === null || _f === void 0 ? void 0 : _f.trim()) || '{}';
                            obj = JSON.parse(raw);
                            if (!(obj === null || obj === void 0 ? void 0 : obj.action) || typeof obj.say !== 'string') {
                                return [2 /*return*/, {
                                        action: 'ASK',
                                        say: 'Kusura bakmayın, tekrar eder misiniz? Hangi işlem için arıyordunuz?',
                                    }];
                            }
                            obj.say = this.cleanSpeak(obj.say);
                            if (obj.action === 'BOOK') {
                                d = obj.data || {};
                                if (!d.serviceId || !d.dateISO || !d.timeHHmm) {
                                    return [2 /*return*/, {
                                            action: 'ASK',
                                            say: 'Tabii, randevu oluşturalım. Hangi işlem için randevu almak istiyorsunuz?',
                                        }];
                                }
                            }
                            return [2 /*return*/, obj];
                        case 3:
                            e_2 = _g.sent();
                            this.logger.warn("aiBrain failed: ".concat((e_2 === null || e_2 === void 0 ? void 0 : e_2.message) || e_2));
                            return [2 /*return*/, {
                                    action: 'ASK',
                                    say: 'Kusura bakmayın, tekrar eder misiniz? Hangi işlem için arıyordunuz?',
                                }];
                        case 4: return [2 /*return*/];
                    }
                });
            });
        };
        // --------------------
        // TwiML helpers
        // --------------------
        BotService_1.prototype.twimlGather = function (prompt, actionUrl) {
            var safe = this.cleanSpeak(prompt);
            var safeAction = this.escapeXmlAttr(actionUrl);
            // NOT: Twilio’da “en ufak sesi bile algılıyor” konusu genelde Realtime tarafında.
            // Burada Gather için biraz daha sıkı ayar verdim: speechTimeout=1 ve timeout=5
            return "\n<Response>\n  <Gather input=\"speech dtmf\"\n          action=\"".concat(safeAction, "\"\n          method=\"POST\"\n          language=\"tr-TR\"\n          speechTimeout=\"1\"\n          timeout=\"5\"\n          bargeIn=\"true\">\n    <Say voice=\"alice\" language=\"tr-TR\">").concat(safe, "</Say>\n  </Gather>\n\n  <Redirect method=\"POST\">").concat(safeAction, "</Redirect>\n</Response>\n").trim();
        };
        BotService_1.prototype.cleanSpeak = function (text) {
            return this.escapeXml(text || '').replace(/\s+/g, ' ').trim();
        };
        BotService_1.prototype.escapeXml = function (text) {
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
        };
        BotService_1.prototype.escapeXmlAttr = function (text) {
            return this.escapeXml(text);
        };
        // --------------------
        // Prisma helpers
        // --------------------
        BotService_1.prototype.getOrCreateCallSession = function (args) {
            return __awaiter(this, void 0, void 0, function () {
                var prismaAny, existing;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            prismaAny = this.prisma;
                            return [4 /*yield*/, prismaAny.callSession.findFirst({
                                    where: { tenantId: args.tenantId, callSid: args.callSid },
                                })];
                        case 1:
                            existing = _a.sent();
                            if (existing)
                                return [2 /*return*/, existing];
                            return [2 /*return*/, prismaAny.callSession.create({
                                    data: {
                                        tenantId: args.tenantId,
                                        callSid: args.callSid,
                                        from: args.from,
                                        data: { greeted: false, noInputCount: 0 },
                                    },
                                })];
                    }
                });
            });
        };
        BotService_1.prototype.updateSessionData = function (sessionId, data) {
            return __awaiter(this, void 0, void 0, function () {
                var prismaAny;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            prismaAny = this.prisma;
                            return [4 /*yield*/, prismaAny.callSession.update({
                                    where: { id: sessionId },
                                    data: { data: data },
                                })];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        };
        BotService_1.prototype.safeFindMany = function (label, fn) {
            return __awaiter(this, void 0, void 0, function () {
                var e_3;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, fn()];
                        case 1: return [2 /*return*/, _a.sent()];
                        case 2:
                            e_3 = _a.sent();
                            this.logger.warn("safeFindMany(".concat(label, ") failed: ").concat((e_3 === null || e_3 === void 0 ? void 0 : e_3.message) || e_3));
                            return [2 /*return*/, []];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        };
        return BotService_1;
    }());
    __setFunctionName(_classThis, "BotService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        BotService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return BotService = _classThis;
}();
exports.BotService = BotService;
