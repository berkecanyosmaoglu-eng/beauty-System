"use strict";
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
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
exports.WhatsappController = void 0;
var common_1 = require("@nestjs/common");
var WhatsappController = function () {
    var _classDecorators = [(0, common_1.Controller)('whatsapp')];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var _instanceExtraInitializers = [];
    var _webhook_decorators;
    var WhatsappController = _classThis = /** @class */ (function () {
        function WhatsappController_1(whatsapp, prisma) {
            this.whatsapp = (__runInitializers(this, _instanceExtraInitializers), whatsapp);
            this.prisma = prisma;
        }
        /**
         * Supports:
         * - Twilio WhatsApp webhook (application/x-www-form-urlencoded)
         * - Generic JSON payloads (future WABA)
         */
        WhatsappController_1.prototype.webhook = function (req, body, headers) {
            return __awaiter(this, void 0, void 0, function () {
                var contentType, fromRaw, toRaw, textRaw, from, to, text, tenantId, _a, _b, reply, externalUserId, conv, _c, conversationId, _d;
                var _e;
                return __generator(this, function (_f) {
                    switch (_f.label) {
                        case 0:
                            contentType = String((headers === null || headers === void 0 ? void 0 : headers['content-type']) || '').toLowerCase();
                            fromRaw = (body === null || body === void 0 ? void 0 : body.From) || (body === null || body === void 0 ? void 0 : body.from) || '';
                            toRaw = (body === null || body === void 0 ? void 0 : body.To) || (body === null || body === void 0 ? void 0 : body.to) || '';
                            textRaw = (body === null || body === void 0 ? void 0 : body.Body) || (body === null || body === void 0 ? void 0 : body.text) || ((_e = body === null || body === void 0 ? void 0 : body.message) === null || _e === void 0 ? void 0 : _e.text) || '';
                            from = String(fromRaw).trim();
                            to = String(toRaw).trim();
                            text = String(textRaw).trim();
                            _a = String((body === null || body === void 0 ? void 0 : body.tenantId) || (headers === null || headers === void 0 ? void 0 : headers['x-tenant-id']) || '').trim();
                            if (_a) return [3 /*break*/, 4];
                            if (!to) return [3 /*break*/, 2];
                            return [4 /*yield*/, this.whatsapp.resolveTenantIdByToNumber(to)];
                        case 1:
                            _b = _f.sent();
                            return [3 /*break*/, 3];
                        case 2:
                            _b = null;
                            _f.label = 3;
                        case 3:
                            _a = (_b);
                            _f.label = 4;
                        case 4:
                            tenantId = _a ||
                                '';
                            return [4 /*yield*/, this.whatsapp.handleIncoming({
                                    tenantId: tenantId,
                                    from: from,
                                    to: to,
                                    text: text,
                                    raw: body,
                                    contentType: contentType,
                                })];
                        case 5:
                            reply = _f.sent();
                            _f.label = 6;
                        case 6:
                            _f.trys.push([6, 14, , 15]);
                            if (!(tenantId && from)) return [3 /*break*/, 13];
                            externalUserId = from.replace('whatsapp:', '').trim() || from;
                            return [4 /*yield*/, this.prisma.botConversation.findFirst({
                                    where: {
                                        tenantId: tenantId,
                                        channel: 'WHATSAPP',
                                        externalUserId: externalUserId,
                                        isOpen: true,
                                    },
                                    select: { id: true },
                                })];
                        case 7:
                            _c = (_f.sent());
                            if (_c) return [3 /*break*/, 9];
                            return [4 /*yield*/, this.prisma.botConversation.create({
                                    data: {
                                        tenantId: tenantId,
                                        channel: 'WHATSAPP',
                                        externalUserId: externalUserId,
                                        isOpen: true,
                                        state: null,
                                        contextJson: {},
                                    },
                                    select: { id: true },
                                })];
                        case 8:
                            _c = (_f.sent());
                            _f.label = 9;
                        case 9:
                            conv = _c;
                            conversationId = conv.id;
                            if (!text) return [3 /*break*/, 11];
                            return [4 /*yield*/, this.prisma.botMessage.create({
                                    data: {
                                        tenantId: tenantId,
                                        conversationId: conversationId,
                                        role: 'USER',
                                        text: text,
                                        rawJson: body !== null && body !== void 0 ? body : {},
                                    },
                                })];
                        case 10:
                            _f.sent();
                            _f.label = 11;
                        case 11:
                            if (!reply) return [3 /*break*/, 13];
                            return [4 /*yield*/, this.prisma.botMessage.create({
                                    data: {
                                        tenantId: tenantId,
                                        conversationId: conversationId,
                                        role: 'BOT',
                                        text: String(reply),
                                        rawJson: {}, // Json alanı null kabul etmez
                                    },
                                })];
                        case 12:
                            _f.sent();
                            _f.label = 13;
                        case 13: return [3 /*break*/, 15];
                        case 14:
                            _d = _f.sent();
                            return [3 /*break*/, 15];
                        case 15:
                            // Twilio => TwiML
                            if (contentType.includes('application/x-www-form-urlencoded')) {
                                return [2 /*return*/, this.whatsapp.toTwimlMessage(reply)];
                            }
                            return [2 /*return*/, { ok: true, reply: reply }];
                    }
                });
            });
        };
        return WhatsappController_1;
    }());
    __setFunctionName(_classThis, "WhatsappController");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        _webhook_decorators = [(0, common_1.Post)('webhook')];
        __esDecorate(_classThis, null, _webhook_decorators, { kind: "method", name: "webhook", static: false, private: false, access: { has: function (obj) { return "webhook" in obj; }, get: function (obj) { return obj.webhook; } }, metadata: _metadata }, null, _instanceExtraInitializers);
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        WhatsappController = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return WhatsappController = _classThis;
}();
exports.WhatsappController = WhatsappController;
