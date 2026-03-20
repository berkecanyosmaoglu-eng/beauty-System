"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
var core_1 = require("@nestjs/core");
var app_module_1 = require("./app.module");
var common_1 = require("@nestjs/common");
var realtime_bridge_service_1 = require("./bot/realtime-bridge.service");
var prisma_service_1 = require("./prisma/prisma.service");
var http_1 = require("http");
var bodyParser = require("body-parser");
var WebSocket = require("ws");
function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
function bootstrap() {
    return __awaiter(this, void 0, void 0, function () {
        var app, expressApp, httpServer, logger, bridge, port;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, core_1.NestFactory.create(app_module_1.AppModule)];
                case 1:
                    app = _a.sent();
                    // CORS
                    app.enableCors({
                        origin: true,
                        credentials: true,
                    });
                    // Global validation
                    app.useGlobalPipes(new common_1.ValidationPipe({
                        whitelist: true,
                        transform: true,
                        forbidNonWhitelisted: false,
                    }));
                    expressApp = app.getHttpAdapter().getInstance();
                    // Body parsers (Twilio/WhatsApp webhook’ları için)
                    expressApp.use(bodyParser.urlencoded({ extended: false }));
                    expressApp.use(bodyParser.json({ limit: '2mb' }));
                    // Health
                    expressApp.get('/health', function (_req, res) {
                        return res.json({ ok: true, message: 'api up' });
                    });
                    // /admin/metrics?tenantId=...
                    expressApp.get('/admin/metrics', function (req, res) { return __awaiter(_this, void 0, void 0, function () {
                        var tenantId, prisma, todayStart, todayEnd, tenantCount, todayAppointments, whatsappCount, _a, jarvisMinutes, e_1;
                        var _b;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    _c.trys.push([0, 7, , 8]);
                                    tenantId = String(((_b = req === null || req === void 0 ? void 0 : req.query) === null || _b === void 0 ? void 0 : _b.tenantId) || '').trim();
                                    if (!tenantId)
                                        return [2 /*return*/, res.status(400).json({ ok: false, error: 'tenantId gerekli' })];
                                    prisma = app.get(prisma_service_1.PrismaService);
                                    todayStart = new Date();
                                    todayStart.setHours(0, 0, 0, 0);
                                    todayEnd = new Date();
                                    todayEnd.setHours(23, 59, 59, 999);
                                    return [4 /*yield*/, prisma.tenant.count()];
                                case 1:
                                    tenantCount = _c.sent();
                                    return [4 /*yield*/, prisma.appointment.count({
                                            where: { tenantId: tenantId, startAt: { gte: todayStart, lte: todayEnd } },
                                        })];
                                case 2:
                                    todayAppointments = _c.sent();
                                    whatsappCount = 0;
                                    _c.label = 3;
                                case 3:
                                    _c.trys.push([3, 5, , 6]);
                                    return [4 /*yield*/, prisma.whatsAppMessage.count({ where: { tenantId: tenantId } })];
                                case 4:
                                    // @ts-ignore
                                    whatsappCount = _c.sent();
                                    return [3 /*break*/, 6];
                                case 5:
                                    _a = _c.sent();
                                    whatsappCount = 0;
                                    return [3 /*break*/, 6];
                                case 6:
                                    jarvisMinutes = 0;
                                    return [2 /*return*/, res.json({
                                            ok: true,
                                            tenantCount: tenantCount,
                                            todayAppointments: todayAppointments,
                                            whatsappCount: whatsappCount,
                                            jarvisMinutes: jarvisMinutes,
                                        })];
                                case 7:
                                    e_1 = _c.sent();
                                    return [2 /*return*/, res.status(500).json({ ok: false, error: (e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || String(e_1) })];
                                case 8: return [2 /*return*/];
                            }
                        });
                    }); });
                    // /admin/recent-appointments?tenantId=...&limit=10
                    expressApp.get('/admin/recent-appointments', function (req, res) { return __awaiter(_this, void 0, void 0, function () {
                        var tenantId, limitRaw, limit, prisma, rows, e_2;
                        var _a, _b;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    _c.trys.push([0, 2, , 3]);
                                    tenantId = String(((_a = req === null || req === void 0 ? void 0 : req.query) === null || _a === void 0 ? void 0 : _a.tenantId) || '').trim();
                                    if (!tenantId)
                                        return [2 /*return*/, res.status(400).json({ ok: false, error: 'tenantId gerekli' })];
                                    limitRaw = Number(((_b = req === null || req === void 0 ? void 0 : req.query) === null || _b === void 0 ? void 0 : _b.limit) || 10);
                                    limit = clamp(Number.isFinite(limitRaw) ? limitRaw : 10, 1, 50);
                                    prisma = app.get(prisma_service_1.PrismaService);
                                    return [4 /*yield*/, prisma.appointment.findMany({
                                            where: { tenantId: tenantId },
                                            orderBy: { createdAt: 'desc' },
                                            take: limit,
                                            include: {
                                                customer: true,
                                                staff: true,
                                                service: true,
                                            },
                                        })];
                                case 1:
                                    rows = _c.sent();
                                    return [2 /*return*/, res.json({
                                            ok: true,
                                            items: rows.map(function (a) {
                                                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
                                                return ({
                                                    id: a.id,
                                                    createdAt: a.createdAt,
                                                    startsAt: (_a = a.startAt) !== null && _a !== void 0 ? _a : null,
                                                    status: (_b = a.status) !== null && _b !== void 0 ? _b : null,
                                                    customerName: (_e = (_d = (_c = a.customer) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : a.customerName) !== null && _e !== void 0 ? _e : null,
                                                    customerPhone: (_h = (_g = (_f = a.customer) === null || _f === void 0 ? void 0 : _f.phone) !== null && _g !== void 0 ? _g : a.customerPhone) !== null && _h !== void 0 ? _h : null,
                                                    staffName: (_k = (_j = a.staff) === null || _j === void 0 ? void 0 : _j.name) !== null && _k !== void 0 ? _k : null,
                                                    serviceName: (_m = (_l = a.service) === null || _l === void 0 ? void 0 : _l.name) !== null && _m !== void 0 ? _m : null,
                                                });
                                            }),
                                        })];
                                case 2:
                                    e_2 = _c.sent();
                                    return [2 /*return*/, res.status(500).json({ ok: false, error: (e_2 === null || e_2 === void 0 ? void 0 : e_2.message) || String(e_2) })];
                                case 3: return [2 /*return*/];
                            }
                        });
                    }); });
                    httpServer = (0, http_1.createServer)(expressApp);
                    // Nest app init (controller’lar vs ayağa kalksın)
                    return [4 /*yield*/, app.init()];
                case 2:
                    // Nest app init (controller’lar vs ayağa kalksın)
                    _a.sent();
                    logger = new common_1.Logger('WS');
                    bridge = app.get(realtime_bridge_service_1.RealtimeBridgeService);
                    // Twilio Media Stream WS: /bot/stream...
                    httpServer.on('upgrade', function (req, socket, head) {
                        try {
                            var url_1 = req.url || '';
                            if (!url_1.startsWith('/bot/stream')) {
                                socket.destroy();
                                return;
                            }
                            logger.log("UPGRADE ".concat(url_1));
                            var wss_1 = new WebSocket.Server({ noServer: true });
                            wss_1.handleUpgrade(req, socket, head, function (ws) {
                                wss_1.emit('connection', ws, req);
                                bridge.handleTwilioWebSocket(ws, url_1);
                            });
                        }
                        catch (e) {
                            logger.error("upgrade error: ".concat((e === null || e === void 0 ? void 0 : e.message) || e));
                            try {
                                socket.destroy();
                            }
                            catch (_a) { }
                        }
                    });
                    port = Number(process.env.PORT || 3001);
                    httpServer.listen(port, '0.0.0.0', function () {
                        logger.log("HTTP+WS listening on ".concat(port));
                    });
                    return [2 /*return*/];
            }
        });
    });
}
bootstrap();
