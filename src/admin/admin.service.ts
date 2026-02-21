import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function parseDateOrThrow(v?: string, name?: string) {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name ?? 'date'} geçersiz: ${v}`);
  return d;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private parseDateOrNull(v?: string) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  private getTodayRange() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  // input date range normalize
  private resolveRange(from?: string, to?: string) {
    const { start: todayFrom, end: todayTo } = this.getTodayRange();

    const fromD = parseDateOrThrow(from, 'from') ?? todayFrom;
    const toD = parseDateOrThrow(to, 'to') ?? todayTo;

    if (fromD.getTime() > toD.getTime()) return { fromD: toD, toD: fromD };
    return { fromD, toD };
  }

private normPhone(v?: string | null) {
  return String(v ?? '').trim();
}

  async listAppointments(params: {
    tenantId: string;
    from?: string;
    to?: string;
    status?: string;
    channel?: string;
    staffId?: string;
    serviceId?: string;
    q?: string;
    order?: 'asc' | 'desc';
    page: number;
    limit: number;
  }) {
    const { tenantId } = params;
    const fromD = parseDateOrThrow(params.from, 'from');
    const toD = parseDateOrThrow(params.to, 'to');

    const page = Number.isFinite(params.page) && params.page > 0 ? params.page : 1;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 200 ? params.limit : 30;
    const skip = (page - 1) * limit;

    const where: any = {
      tenantId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.staffId ? { staffId: params.staffId } : {}),
      ...(params.serviceId ? { serviceId: params.serviceId } : {}),
      ...(fromD || toD
        ? {
            startAt: {
              ...(fromD ? { gte: fromD } : {}),
              ...(toD ? { lte: toD } : {}),
            },
          }
        : {}),
      ...(params.q
        ? {
            customer: {
              OR: [
                { fullName: { contains: params.q, mode: 'insensitive' } },
                { phone: { contains: params.q } },
              ],
            },
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.appointment.count({ where }),
      this.prisma.appointment.findMany({
        where,
        orderBy: { startAt: params.order ?? 'desc' },
        skip,
        take: limit,
        include: { service: true, staff: true, customer: true },
      }),
    ]);

    return {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
    };
  }

  async appointmentsSummary(params: {
    tenantId: string;
    from?: string;
    to?: string;
    bucket: 'day' | 'hour';
  }) {
    const { tenantId, bucket } = params;
    const fromD =
      parseDateOrThrow(params.from, 'from') ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    const toD = parseDateOrThrow(params.to, 'to') ?? new Date();

    const rows = await this.prisma.appointment.findMany({
      where: { tenantId, startAt: { gte: fromD, lte: toD } },
      select: { startAt: true },
      orderBy: { startAt: 'asc' },
    });

    const map = new Map<string, number>();
    for (const r of rows) {
      const d = r.startAt;
      const key =
        bucket === 'hour'
          ? seeHourKey(d)
          : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }

    return {
      tenantId,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      bucket,
      points: Array.from(map.entries()).map(([label, count]) => ({ label, count })),
      total: rows.length,
    };

    function seeHourKey(d: Date) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
        d.getHours(),
      )}:00`;
    }
  }

  /**
   * /admin/metrics
   * KPI'lar seçili aralığa göre:
   * - WhatsApp inbound/outbound: botMessage role USER/BOT üzerinden sayılır
   * - Randevu: seçili aralık
   */
  async metrics(params: { tenantId: string; from?: string; to?: string }) {
    const { tenantId } = params;
    const { fromD, toD } = this.resolveRange(params.from, params.to);

    const [tenantCount, rangeAppointments, waConvIds] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.appointment.count({
        where: { tenantId, startAt: { gte: fromD, lte: toD } },
      }),
      this.prisma.botConversation.findMany({
        where: { tenantId, channel: 'WHATSAPP' as any },
        select: { id: true },
      }),
    ]);

    const ids = waConvIds.map((x) => x.id);

    const [whatsappInbound, whatsappOutbound] = await Promise.all([
      ids.length
        ? this.prisma.botMessage.count({
            where: {
              tenantId,
              conversationId: { in: ids } as any,
              role: 'USER' as any,
              createdAt: { gte: fromD, lte: toD },
            },
          })
        : 0,
      ids.length
        ? this.prisma.botMessage.count({
            where: {
              tenantId,
              conversationId: { in: ids } as any,
              role: 'BOT' as any,
              createdAt: { gte: fromD, lte: toD },
            },
          })
        : 0,
    ]);

    const whatsappTotal = whatsappInbound + whatsappOutbound;

    // UI alan adı "todayAppointments" ama biz "seçili aralık" için kullanıyoruz
    const todayAppointments = rangeAppointments;

    return {
      ok: true,
      tenantCount,
      todayAppointments,

      whatsappInbound,
      whatsappOutbound,
      whatsappTotal,

      // UI hâlâ bu alanları okuyor; aynı değerleri veriyoruz
      todayWhatsappInbound: whatsappInbound,
      todayWhatsappOutbound: whatsappOutbound,
      todayWhatsappTotal: whatsappTotal,

      jarvisMinutes: 0,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      __debug: 'ADMIN_SERVICE_METRICS_V3',
    };
  }

  /**
   * WhatsApp time-series grafik datası
   * GET /admin/whatsapp/series?tenantId=...&from=...&to=...&bucket=day|hour
   */
  async whatsappSeries(params: { tenantId: string; from?: string; to?: string; bucket: 'day' | 'hour' }) {
    const { tenantId, bucket } = params;
    const { fromD, toD } = this.resolveRange(params.from, params.to);

    // performans güvenliği
    const ms = toD.getTime() - fromD.getTime();
    const days = ms / (1000 * 60 * 60 * 24);

    if (bucket === 'hour' && days > 14) {
      throw new BadRequestException('bucket=hour için aralık en fazla 14 gün olmalı');
    }
    if (days > 120) {
      throw new BadRequestException('aralık en fazla 120 gün olmalı');
    }

    const convs = await this.prisma.botConversation.findMany({
      where: { tenantId, channel: 'WHATSAPP' as any },
      select: { id: true },
    });

    const ids = convs.map((x) => x.id);
    if (!ids.length) {
      return {
        ok: true,
        tenantId,
        bucket,
        from: fromD.toISOString(),
        to: toD.toISOString(),
        points: [],
        totals: { inbound: 0, outbound: 0, total: 0 },
        peak: null,
        __debug: 'WHATSAPP_SERIES_V1',
      };
    }

    const messages = await this.prisma.botMessage.findMany({
      where: {
        tenantId,
        conversationId: { in: ids } as any,
        createdAt: { gte: fromD, lte: toD },
        role: { in: ['USER', 'BOT'] } as any,
      },
      select: { createdAt: true, role: true },
      orderBy: { createdAt: 'asc' },
    });

    const keyOf = (d: Date) => {
      if (bucket === 'hour') {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
          d.getHours(),
        )}:00`;
      }
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    const map = new Map<string, { inbound: number; outbound: number; total: number }>();
    let totIn = 0;
    let totOut = 0;

    for (const m of messages) {
      const k = keyOf(m.createdAt);
      const cur = map.get(k) ?? { inbound: 0, outbound: 0, total: 0 };

      if ((m.role as any) === 'USER') {
        cur.inbound += 1;
        totIn += 1;
      } else {
        cur.outbound += 1;
        totOut += 1;
      }
      cur.total = cur.inbound + cur.outbound;

      map.set(k, cur);
    }

    const points = Array.from(map.entries()).map(([label, v]) => ({ label, ...v }));

    let peak: { label: string; inbound: number; outbound: number; total: number } | null = null;
    for (const p of points) {
      if (!peak || p.total > peak.total) peak = p;
    }

    return {
      ok: true,
      tenantId,
      bucket,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      points,
      totals: { inbound: totIn, outbound: totOut, total: totIn + totOut },
      peak,
      __debug: 'WHATSAPP_SERIES_V1',
    };
  }

  async appointmentsMetrics(params: { tenantId: string; from?: string; to?: string }) {
    const { tenantId } = params;

    const fromD = this.parseDateOrNull(params.from);
    const toD = this.parseDateOrNull(params.to);

    const whereBase: any = {
      tenantId,
      ...(fromD || toD
        ? {
            startAt: {
              ...(fromD ? { gte: fromD } : {}),
              ...(toD ? { lte: toD } : {}),
            },
          }
        : {}),
    };

    const [total, scheduled, canceled, byChannel] = await Promise.all([
      this.prisma.appointment.count({ where: whereBase }),
      this.prisma.appointment.count({ where: { ...whereBase, status: 'scheduled' } }),
      this.prisma.appointment.count({ where: { ...whereBase, status: 'cancelled' } }),
      this.prisma.appointment.groupBy({
        by: ['channel'],
        where: whereBase,
        _count: { _all: true },
      }),
    ]);

    const channelCounts = byChannel.map((x) => ({ channel: x.channel, count: x._count._all }));

    return {
      tenantId,
      from: fromD?.toISOString() ?? null,
      to: toD?.toISOString() ?? null,
      total,
      scheduled,
      canceled,
      cancelRate: total ? Number((canceled / total).toFixed(4)) : 0,
      channelCounts,
    };
  }

  // =========================
  // WhatsApp Inbox (Conversation list + Messages)
  // NOTE: Bu kısım prisma.whatsAppMessage tablosunu kullanır.
  // =========================

  async whatsappConversations(params: {
    tenantId: string;
    from?: string;
    to?: string;
    q?: string;
    page: number;
    limit: number;
  }) {
    const { tenantId } = params;
    const { fromD, toD } = this.resolveRange(params.from, params.to);

    const page = Number.isFinite(params.page) && params.page > 0 ? params.page : 1;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 200 ? params.limit : 30;
    const skip = (page - 1) * limit;

    const whereBase: any = {
      tenantId,
      createdAt: { gte: fromD, lte: toD },
      ...(params.q
        ? {
            OR: [
              { from: { contains: params.q } },
              { to: { contains: params.q } },
              { body: { contains: params.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.whatsAppMessage.findMany({
      where: whereBase,
      select: {
        direction: true,
        from: true,
        to: true,
        body: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    type Agg = {
      peer: string;
      lastAt: Date;
      lastBody: string;
      lastDirection: 'INBOUND' | 'OUTBOUND';
      inbound: number;
      outbound: number;
      total: number;
    };

    const map = new Map<string, Agg>();

    for (const r of rows) {
      const peer = r.direction === 'INBOUND' ? this.normPhone(r.from) : this.normPhone(r.to);
      if (!peer) continue;

      const prev = map.get(peer);
      const inboundAdd = r.direction === 'INBOUND' ? 1 : 0;
      const outboundAdd = r.direction === 'OUTBOUND' ? 1 : 0;

      if (!prev) {
        map.set(peer, {
          peer,
          lastAt: r.createdAt,
          lastBody: String(r.body || '').slice(0, 140),
          lastDirection: r.direction,
          inbound: inboundAdd,
          outbound: outboundAdd,
          total: 1,
        });
      } else {
        prev.inbound += inboundAdd;
        prev.outbound += outboundAdd;
        prev.total += 1;

        if (r.createdAt > prev.lastAt) {
          prev.lastAt = r.createdAt;
          prev.lastBody = String(r.body || '').slice(0, 140);
          prev.lastDirection = r.direction;
        }
      }
    }

    const all = Array.from(map.values()).sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
    const total = all.length;
    const items = all.slice(skip, skip + limit);

    const peers = items.map((x) => x.peer).filter(Boolean);
    const customers = peers.length
      ? await this.prisma.customer.findMany({
          where: { tenantId, OR: peers.map((p) => ({ phone: p })) },
          select: { phone: true, fullName: true },
        })
      : [];
    const customerMap = new Map(customers.map((c) => [c.phone, c.fullName]));

    return {
      ok: true,
      tenantId,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items: items.map((x) => ({
        peer: x.peer,
        customerName: customerMap.get(x.peer) ?? null,
        lastAt: x.lastAt.toISOString(),
        lastBody: x.lastBody,
        lastDirection: x.lastDirection,
        inbound: x.inbound,
        outbound: x.outbound,
        total: x.total,
      })),
      __debug: 'WHATSAPP_INBOX_V1',
    };
  }

  async whatsappMessages(params: {
    tenantId: string;
    peer: string;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  }) {
    const { tenantId } = params;
    const { fromD, toD } = this.resolveRange(params.from, params.to);

    const peer = this.normPhone(params.peer);
    if (!peer) throw new BadRequestException('peer gerekli (müşteri telefonu)');

    const page = Number.isFinite(params.page) && params.page > 0 ? params.page : 1;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 200 ? params.limit : 50;
    const skip = (page - 1) * limit;

    const where: any = {
      tenantId,
      createdAt: { gte: fromD, lte: toD },
      OR: [{ from: peer }, { to: peer }],
    };

    const [total, items] = await Promise.all([
      this.prisma.whatsAppMessage.count({ where }),
      this.prisma.whatsAppMessage.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          direction: true,
          from: true,
          to: true,
          body: true,
          provider: true,
          providerSid: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ok: true,
      tenantId,
      peer,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items: items.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
      __debug: 'WHATSAPP_MESSAGES_V1',
    };
  }
}
