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
exports.AppointmentsService = void 0;
var common_1 = require("@nestjs/common");
// --- Booking time rules (TR) ---
var TR_OFFSET = '+03:00'; // Europe/Istanbul (fixed offset, no DST)
var MIN_LEAD_MINUTES = 60; // "şimdi + 60dk" altına randevu alma
var MAX_FUTURE_DAYS = 30; // en fazla 30 gün ileri
function coerceToTrIso(input) {
    // Accept:
    // - 2026-02-02T14:00
    // - 2026-02-02 14:00
    // - 2026-02-02T14:00:00
    // If timezone missing, assume TR (+03:00)
    var s = String(input).trim();
    // If already has Z or +hh:mm or -hh:mm, keep as is.
    if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s))
        return s;
    // Normalize space to T
    var normalized = s.includes(' ') ? s.replace(' ', 'T') : s;
    // If has only date, reject (we need time)
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized))
        return normalized + 'T00:00:00' + TR_OFFSET;
    // If has HH:mm but no seconds
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
        return normalized + ':00' + TR_OFFSET;
    }
    // If has HH:mm:ss
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
        return normalized + TR_OFFSET;
    }
    // Fallback: just append offset if no timezone marker
    return normalized + TR_OFFSET;
}
var AppointmentsService = function () {
    var _classDecorators = [(0, common_1.Injectable)()];
    var _classDescriptor;
    var _classExtraInitializers = [];
    var _classThis;
    var AppointmentsService = _classThis = /** @class */ (function () {
        function AppointmentsService_1(prisma, notificationsService) {
            this.prisma = prisma;
            this.notificationsService = notificationsService;
        }
        AppointmentsService_1.prototype.addMinutes = function (d, minutes) {
            return new Date(d.getTime() + minutes * 60 * 1000);
        };
        AppointmentsService_1.prototype.isValidDate = function (d) {
            return d instanceof Date && !Number.isNaN(d.getTime());
        };
        AppointmentsService_1.prototype.getServiceOrThrow = function (serviceId) {
            return __awaiter(this, void 0, void 0, function () {
                var service;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.service.findUnique({ where: { id: serviceId } })];
                        case 1:
                            service = _a.sent();
                            if (!service)
                                throw new common_1.BadRequestException('serviceId geçersiz');
                            if (!service.duration || service.duration <= 0) {
                                throw new common_1.BadRequestException('service duration geçersiz');
                            }
                            return [2 /*return*/, service];
                    }
                });
            });
        };
        AppointmentsService_1.prototype.hasOverlap = function (params) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, staffId, startAt, endAt, excludeAppointmentId, overlap;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            tenantId = params.tenantId, staffId = params.staffId, startAt = params.startAt, endAt = params.endAt, excludeAppointmentId = params.excludeAppointmentId;
                            return [4 /*yield*/, this.prisma.appointment.findFirst({
                                    where: __assign(__assign({ tenantId: tenantId, staffId: staffId, 
                                        // iptal edilenleri sayma (senin statü isimlerin farklıysa burayı genişletiriz)
                                        NOT: { status: 'cancelled' } }, (excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {})), { 
                                        // Overlap şartı: existing.start < new.end && existing.end > new.start
                                        startAt: { lt: endAt }, endAt: { gt: startAt } }),
                                    select: { id: true, startAt: true, endAt: true },
                                })];
                        case 1:
                            overlap = _a.sent();
                            return [2 /*return*/, overlap];
                    }
                });
            });
        };
        // ✅ NEW: slot check + suggestions (controller burayı çağırıyor)
        AppointmentsService_1.prototype.nextAvailable = function (input) {
            return __awaiter(this, void 0, void 0, function () {
                var tenantId, staffId, serviceId, desiredStart, _a, stepMinutes, _b, searchHours, _c, suggestions, service, start, now, minStart, maxStart, desiredEnd, conflict, slots, endSearch, cursor, maxIterations, i, candStart, candEnd, c;
                return __generator(this, function (_d) {
                    switch (_d.label) {
                        case 0:
                            tenantId = input.tenantId, staffId = input.staffId, serviceId = input.serviceId, desiredStart = input.desiredStart, _a = input.stepMinutes, stepMinutes = _a === void 0 ? 15 : _a, _b = input.searchHours, searchHours = _b === void 0 ? 24 : _b, _c = input.suggestions, suggestions = _c === void 0 ? 5 : _c;
                            if (!tenantId)
                                throw new common_1.BadRequestException('tenantId gerekli');
                            if (!staffId)
                                throw new common_1.BadRequestException('staffId gerekli');
                            if (!serviceId)
                                throw new common_1.BadRequestException('serviceId gerekli');
                            return [4 /*yield*/, this.getServiceOrThrow(serviceId)];
                        case 1:
                            service = _d.sent();
                            start = typeof desiredStart === 'string'
                                ? new Date(coerceToTrIso(String(desiredStart)))
                                : new Date(desiredStart);
                            if (!this.isValidDate(start))
                                throw new common_1.BadRequestException('desiredStart geçersiz');
                            now = new Date();
                            minStart = this.addMinutes(now, MIN_LEAD_MINUTES);
                            if (start < minStart) {
                                return [2 /*return*/, {
                                        ok: false,
                                        message: "En erken ".concat(MIN_LEAD_MINUTES, " dakika sonras\u0131 i\u00E7in saat se\u00E7ilebilir"),
                                        desired: null,
                                        suggestions: [],
                                    }];
                            }
                            maxStart = this.addMinutes(now, MAX_FUTURE_DAYS * 24 * 60);
                            if (start > maxStart) {
                                return [2 /*return*/, {
                                        ok: false,
                                        message: "En fazla ".concat(MAX_FUTURE_DAYS, " g\u00FCn ileriye randevu al\u0131nabilir"),
                                        desired: null,
                                        suggestions: [],
                                    }];
                            }
                            desiredEnd = this.addMinutes(start, Number(service.duration));
                            return [4 /*yield*/, this.hasOverlap({
                                    tenantId: tenantId,
                                    staffId: staffId,
                                    startAt: start,
                                    endAt: desiredEnd,
                                })];
                        case 2:
                            conflict = _d.sent();
                            // Uygunsa direkt "ok:true"
                            if (!conflict) {
                                return [2 /*return*/, {
                                        ok: true,
                                        message: 'Uygun',
                                        desired: { startAt: start.toISOString(), endAt: desiredEnd.toISOString() },
                                        suggestions: [],
                                    }];
                            }
                            slots = [];
                            endSearch = new Date(start.getTime() + searchHours * 60 * 60 * 1000);
                            cursor = new Date(start);
                            maxIterations = Math.min(2000, Math.ceil((searchHours * 60) / Math.max(1, stepMinutes)) + 10);
                            i = 0;
                            _d.label = 3;
                        case 3:
                            if (!(i < maxIterations)) return [3 /*break*/, 6];
                            if (cursor >= endSearch)
                                return [3 /*break*/, 6];
                            candStart = new Date(cursor);
                            candEnd = this.addMinutes(candStart, Number(service.duration));
                            return [4 /*yield*/, this.hasOverlap({
                                    tenantId: tenantId,
                                    staffId: staffId,
                                    startAt: candStart,
                                    endAt: candEnd,
                                })];
                        case 4:
                            c = _d.sent();
                            if (!c) {
                                slots.push({ startAt: candStart.toISOString(), endAt: candEnd.toISOString() });
                                if (slots.length >= suggestions)
                                    return [3 /*break*/, 6];
                            }
                            cursor = this.addMinutes(cursor, stepMinutes);
                            _d.label = 5;
                        case 5:
                            i++;
                            return [3 /*break*/, 3];
                        case 6: return [2 /*return*/, {
                                ok: false,
                                message: 'Bu saat dolu',
                                desired: { startAt: start.toISOString(), endAt: desiredEnd.toISOString() },
                                suggestions: slots,
                            }];
                    }
                });
            });
        };
        AppointmentsService_1.prototype.create = function (dto) {
            return __awaiter(this, void 0, void 0, function () {
                var service, startAt, now, minStart, maxStart, endAt, conflict, suggest, created;
                var _a, _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            if (!(dto === null || dto === void 0 ? void 0 : dto.tenantId))
                                throw new common_1.BadRequestException('tenantId gerekli');
                            if (!(dto === null || dto === void 0 ? void 0 : dto.customerId))
                                throw new common_1.BadRequestException('customerId gerekli');
                            if (!(dto === null || dto === void 0 ? void 0 : dto.serviceId))
                                throw new common_1.BadRequestException('serviceId gerekli');
                            if (!(dto === null || dto === void 0 ? void 0 : dto.staffId))
                                throw new common_1.BadRequestException('staffId gerekli');
                            if (!(dto === null || dto === void 0 ? void 0 : dto.startAt))
                                throw new common_1.BadRequestException('startAt gerekli');
                            return [4 /*yield*/, this.getServiceOrThrow(dto.serviceId)];
                        case 1:
                            service = _c.sent();
                            startAt = new Date(coerceToTrIso(String(dto.startAt)));
                            if (!this.isValidDate(startAt))
                                throw new common_1.BadRequestException('startAt geçersiz');
                            now = new Date();
                            minStart = this.addMinutes(now, MIN_LEAD_MINUTES);
                            if (startAt < minStart) {
                                throw new common_1.BadRequestException("Randevu en erken ".concat(MIN_LEAD_MINUTES, " dakika sonras\u0131na al\u0131nabilir"));
                            }
                            maxStart = this.addMinutes(now, MAX_FUTURE_DAYS * 24 * 60);
                            if (startAt > maxStart) {
                                throw new common_1.BadRequestException("Randevu en fazla ".concat(MAX_FUTURE_DAYS, " g\u00FCn ileriye al\u0131nabilir"));
                            }
                            endAt = this.addMinutes(startAt, Number(service.duration));
                            return [4 /*yield*/, this.hasOverlap({
                                    tenantId: dto.tenantId,
                                    staffId: dto.staffId,
                                    startAt: startAt,
                                    endAt: endAt,
                                })];
                        case 2:
                            conflict = _c.sent();
                            if (!conflict) return [3 /*break*/, 4];
                            return [4 /*yield*/, this.nextAvailable({
                                    tenantId: dto.tenantId,
                                    staffId: dto.staffId,
                                    serviceId: dto.serviceId,
                                    desiredStart: startAt,
                                    stepMinutes: 15,
                                    searchHours: 24,
                                    suggestions: 5,
                                })];
                        case 3:
                            suggest = _c.sent();
                            throw new common_1.ConflictException(suggest);
                        case 4: return [4 /*yield*/, this.prisma.appointment.create({
                                data: {
                                    tenantId: dto.tenantId,
                                    customerId: dto.customerId,
                                    serviceId: dto.serviceId,
                                    staffId: dto.staffId,
                                    startAt: startAt,
                                    endAt: endAt,
                                    status: (_a = dto.status) !== null && _a !== void 0 ? _a : 'scheduled',
                                    channel: (_b = dto.channel) !== null && _b !== void 0 ? _b : 'API',
                                },
                                include: {
                                    customer: true,
                                    service: true,
                                    staff: true,
                                },
                            })];
                        case 5:
                            created = _c.sent();
                            // Bildirim/WhatsApp/SMS tarafı sende ayrı modülde zaten var; burada dokunmuyorum.
                            // İstersen create sonrası notificationsService trigger’ı ekleriz.
                            return [2 /*return*/, created];
                    }
                });
            });
        };
        AppointmentsService_1.prototype.findAll = function (tenantId_1, date_1, status_1) {
            return __awaiter(this, arguments, void 0, function (tenantId, date, status, today) {
                var where, now, start, end, d, start, end;
                if (today === void 0) { today = false; }
                return __generator(this, function (_a) {
                    where = {};
                    if (tenantId)
                        where.tenantId = tenantId;
                    if (status)
                        where.status = status;
                    if (today) {
                        now = new Date();
                        start = new Date(now);
                        start.setHours(0, 0, 0, 0);
                        end = new Date(now);
                        end.setHours(23, 59, 59, 999);
                        where.startAt = { gte: start, lte: end };
                    }
                    else if (date) {
                        d = new Date(date);
                        if (this.isValidDate(d)) {
                            start = new Date(d);
                            start.setHours(0, 0, 0, 0);
                            end = new Date(d);
                            end.setHours(23, 59, 59, 999);
                            where.startAt = { gte: start, lte: end };
                        }
                    }
                    return [2 /*return*/, this.prisma.appointment.findMany({
                            where: where,
                            orderBy: { startAt: 'asc' },
                            include: { customer: true, service: true, staff: true },
                        })];
                });
            });
        };
        AppointmentsService_1.prototype.findOne = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var appt;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.appointment.findUnique({
                                where: { id: id },
                                include: { customer: true, service: true, staff: true },
                            })];
                        case 1:
                            appt = _a.sent();
                            if (!appt)
                                throw new common_1.NotFoundException('appointment bulunamadı');
                            return [2 /*return*/, appt];
                    }
                });
            });
        };
        AppointmentsService_1.prototype.update = function (id, dto) {
            return __awaiter(this, void 0, void 0, function () {
                var existing, startAt, endAt, serviceId, staffId, tenantId, service, conflict, suggest;
                var _a, _b, _c;
                return __generator(this, function (_d) {
                    switch (_d.label) {
                        case 0: return [4 /*yield*/, this.prisma.appointment.findUnique({ where: { id: id } })];
                        case 1:
                            existing = _d.sent();
                            if (!existing)
                                throw new common_1.NotFoundException('appointment bulunamadı');
                            if (!dto.startAt) return [3 /*break*/, 5];
                            serviceId = (_a = dto.serviceId) !== null && _a !== void 0 ? _a : existing.serviceId;
                            staffId = (_b = dto.staffId) !== null && _b !== void 0 ? _b : existing.staffId;
                            tenantId = (_c = dto.tenantId) !== null && _c !== void 0 ? _c : existing.tenantId;
                            return [4 /*yield*/, this.getServiceOrThrow(serviceId)];
                        case 2:
                            service = _d.sent();
                            startAt = new Date(String(dto.startAt));
                            if (!this.isValidDate(startAt))
                                throw new common_1.BadRequestException('startAt geçersiz');
                            endAt = this.addMinutes(startAt, Number(service.duration));
                            return [4 /*yield*/, this.hasOverlap({
                                    tenantId: tenantId,
                                    staffId: staffId,
                                    startAt: startAt,
                                    endAt: endAt,
                                    excludeAppointmentId: id,
                                })];
                        case 3:
                            conflict = _d.sent();
                            if (!conflict) return [3 /*break*/, 5];
                            return [4 /*yield*/, this.nextAvailable({
                                    tenantId: tenantId,
                                    staffId: staffId,
                                    serviceId: serviceId,
                                    desiredStart: startAt,
                                    stepMinutes: 15,
                                    searchHours: 24,
                                    suggestions: 5,
                                })];
                        case 4:
                            suggest = _d.sent();
                            throw new common_1.ConflictException(suggest);
                        case 5: return [2 /*return*/, this.prisma.appointment.update({
                                where: { id: id },
                                data: __assign(__assign(__assign({}, dto), (startAt ? { startAt: startAt } : {})), (endAt ? { endAt: endAt } : {})),
                                include: { customer: true, service: true, staff: true },
                            })];
                    }
                });
            });
        };
        AppointmentsService_1.prototype.remove = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                var existing;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.prisma.appointment.findUnique({ where: { id: id } })];
                        case 1:
                            existing = _a.sent();
                            if (!existing)
                                throw new common_1.NotFoundException('appointment bulunamadı');
                            // Silmek yerine iptal istersen burada status=canceled yaparız
                            return [2 /*return*/, this.prisma.appointment.delete({ where: { id: id } })];
                    }
                });
            });
        };
        return AppointmentsService_1;
    }());
    __setFunctionName(_classThis, "AppointmentsService");
    (function () {
        var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        AppointmentsService = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return AppointmentsService = _classThis;
}();
exports.AppointmentsService = AppointmentsService;
