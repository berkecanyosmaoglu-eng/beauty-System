import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { SendWhatsappMessageDto } from './dto/send-whatsapp-message.dto';

function parseDateOrThrow(v?: string, name?: string) {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(`${name ?? 'date'} geçersiz: ${v}`);
  return d;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

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

  private resolveRange(from?: string, to?: string) {
    const { start: todayFrom, end: todayTo } = this.getTodayRange();
    const fromD = parseDateOrThrow(from, 'from') ?? todayFrom;
    const toD = parseDateOrThrow(to, 'to') ?? todayTo;
    if (fromD.getTime() > toD.getTime()) return { fromD: toD, toD: fromD };
    return { fromD, toD };
  }

  async sendWhatsappMessage(body: SendWhatsappMessageDto) {
    const tenantId = String(body.tenantId || '').trim();
    const to = String(body.to || '').trim();
    const message = String(body.message || '').trim();

    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    if (!to) throw new BadRequestException('to gerekli');
    if (!message) throw new BadRequestException('message gerekli');

    const tenant = await this.prisma.tenants.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new BadRequestException(`tenant bulunamadı: ${tenantId}`);
    }

    const result = await this.whatsapp.sendProactiveWhatsApp({
      tenantId,
      toPhone: to,
      body: message,
      subject: 'Admin panel WhatsApp message',
      metadata: {
        source: 'admin-panel',
        route: 'POST /admin/whatsapp/send',
      },
    });

    const provider = String((result as any)?.provider || 'twilio');
    const providerMessageId =
      String((result as any)?.messageId || (result as any)?.sid || '').trim() ||
      null;

    const notification = await this.prisma.notifications.findFirst({
      where: {
        tenantId,
        type: 'WHATSAPP' as any,
        body: message,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tenantId: true,
        type: true,
        recipient: true,
        subject: true,
        body: true,
        status: true,
        metadata: true,
        sentAt: true,
        createdAt: true,
      },
    });

    return {
      ok: true,
      route: 'POST /admin/whatsapp/send',
      provider,
      providerMessageId,
      notification,
    };
  }

  async listAppointments(params: {
    tenantId: string;
    from?: string;
    to?: string;
    status?: string; // AppointmentStatus
    channel?: string; // SessionChannel
    staffId?: string;
    serviceId?: string;
    q?: string; // customer name/phone
    order?: 'asc' | 'desc';
    page: number;
    limit: number;
  }) {
    const { tenantId } = params;

    const fromD = parseDateOrThrow(params.from, 'from');
    const toD = parseDateOrThrow(params.to, 'to');

    const page =
      Number.isFinite(params.page) && params.page > 0 ? params.page : 1;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 200
        ? params.limit
        : 30;
    const skip = (page - 1) * limit;

    // Schema: appointments { date: DateTime, time: String, startAtUtc?: DateTime }
    // Range filtre: mümkünse startAtUtc üzerinden; yoksa date üzerinden.
    // Basit ve güvenli: her zaman date aralığını uygula (DB drift riski düşük).
    const where: any = {
      tenantId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.staffId ? { staffId: params.staffId } : {}),
      ...(params.serviceId ? { serviceId: params.serviceId } : {}),
      ...(fromD || toD
        ? {
            date: {
              ...(fromD ? { gte: fromD } : {}),
              ...(toD ? { lte: toD } : {}),
            },
          }
        : {}),
      ...(params.q
        ? {
            customers: {
              OR: [
                { name: { contains: params.q, mode: 'insensitive' } },
                { phoneNumber: { contains: params.q } },
              ],
            },
          }
        : {}),
    };

    const order = params.order ?? 'desc';

    const [total, items] = await Promise.all([
      this.prisma.appointments.count({ where }),
      this.prisma.appointments.findMany({
        where,
        orderBy: [
          { startAtUtc: order }, // null olabilir ama sorun değil
          { date: order },
          { time: order },
        ] as any,
        skip,
        take: limit,
        include: {
          services: true,
          staff: true,
          customers: true,
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
      __debug: 'ADMIN_LIST_APPOINTMENTS_V4_SCHEMA_MATCH',
    };
  }

  async appointmentsSummary(params: {
    tenantId: string;
    from?: string;
    to?: string;
    bucket: 'day' | 'hour';
  }) {
    const { tenantId, bucket } = params;

    // date+time tabanlı sistemde "hour" bucket tam doğru olsun diye startAtUtc varsa onu kullanmak daha iyi.
    // Ama minimum viable: date üzerinden özet.
    const fromD =
      parseDateOrThrow(params.from, 'from') ??
      new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    const toD = parseDateOrThrow(params.to, 'to') ?? new Date();

    const rows = await this.prisma.appointments.findMany({
      where: { tenantId, date: { gte: fromD, lte: toD } },
      select: { date: true, time: true, startAtUtc: true },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      take: 20000,
    });

    const map = new Map<string, number>();

    for (const r of rows) {
      const d = r.startAtUtc ? new Date(r.startAtUtc) : new Date(r.date);
      const key =
        bucket === 'hour'
          ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
          : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      map.set(key, (map.get(key) ?? 0) + 1);
    }

    return {
      tenantId,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      bucket,
      points: Array.from(map.entries()).map(([label, count]) => ({
        label,
        count,
      })),
      total: rows.length,
      __debug: 'ADMIN_APPT_SUMMARY_V4_SCHEMA_MATCH',
    };
  }

  async appointmentsMetrics(params: {
    tenantId: string;
    from?: string;
    to?: string;
  }) {
    const { tenantId } = params;

    const fromD = this.parseDateOrNull(params.from);
    const toD = this.parseDateOrNull(params.to);

    const whereBase: any = {
      tenantId,
      ...(fromD || toD
        ? {
            date: {
              ...(fromD ? { gte: fromD } : {}),
              ...(toD ? { lte: toD } : {}),
            },
          }
        : {}),
    };

    const [total, pending, confirmed, canceled, byChannel] = await Promise.all([
      this.prisma.appointments.count({ where: whereBase }),
      this.prisma.appointments.count({
        where: { ...whereBase, status: 'PENDING' as any },
      }),
      this.prisma.appointments.count({
        where: { ...whereBase, status: 'CONFIRMED' as any },
      }),
      this.prisma.appointments.count({
        where: { ...whereBase, status: 'CANCELLED' as any },
      }),
      this.prisma.appointments.groupBy({
        by: ['channel'],
        where: whereBase,
        _count: { _all: true },
      }),
    ]);

    const channelCounts = (byChannel || []).map((x: any) => ({
      channel: x.channel,
      count: x._count._all,
    }));

    return {
      tenantId,
      from: fromD?.toISOString() ?? null,
      to: toD?.toISOString() ?? null,
      total,
      pending,
      confirmed,
      canceled,
      cancelRate: total ? Number((canceled / total).toFixed(4)) : 0,
      channelCounts,
      __debug: 'ADMIN_APPT_METRICS_V4_SCHEMA_MATCH',
    };
  }

  async metrics(params: { tenantId: string; from?: string; to?: string }) {
    const { tenantId } = params;
    const { fromD, toD } = this.resolveRange(params.from, params.to);

    const [tenantCount, rangeAppointments, outboundWhatsapps] =
      await Promise.all([
        this.prisma.tenants.count(),
        this.prisma.appointments.count({
          where: { tenantId, date: { gte: fromD, lte: toD } },
        }),
        this.prisma.notifications.count({
          where: {
            tenantId,
            type: 'WHATSAPP' as any,
            createdAt: { gte: fromD, lte: toD },
          },
        }),
      ]);

    // Schema’da inbound WA mesaj tablosu yok -> şimdilik 0
    const whatsappInbound = 0;
    const whatsappOutbound = outboundWhatsapps;
    const whatsappTotal = whatsappInbound + whatsappOutbound;

    return {
      ok: true,
      tenantCount,
      todayAppointments: rangeAppointments,

      whatsappInbound,
      whatsappOutbound,
      whatsappTotal,

      todayWhatsappInbound: whatsappInbound,
      todayWhatsappOutbound: whatsappOutbound,
      todayWhatsappTotal: whatsappTotal,

      jarvisMinutes: 0,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      __debug: 'ADMIN_METRICS_V4_SCHEMA_MATCH',
    };
  }

  async whatsappSeries(params: {
    tenantId: string;
    from?: string;
    to?: string;
    bucket: 'day' | 'hour';
  }) {
    const { tenantId, bucket } = params;
    const { fromD, toD } = this.resolveRange(params.from, params.to);

    // Schema’da botMessage/whatsAppMessage yok.
    // Şimdilik boş dönüyoruz (admin paneli gelince message log tablosunu ekleyip dolduracağız).
    return {
      ok: true,
      tenantId,
      bucket,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      points: [],
      totals: { inbound: 0, outbound: 0, total: 0 },
      peak: null,
      __debug: 'WHATSAPP_SERIES_NOT_AVAILABLE_NO_MESSAGE_TABLE',
    };
  }

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

    // Message table yok → empty
    const page =
      Number.isFinite(params.page) && params.page > 0 ? params.page : 1;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 200
        ? params.limit
        : 30;

    return {
      ok: true,
      tenantId,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      page,
      limit,
      total: 0,
      pages: 0,
      items: [],
      __debug: 'WHATSAPP_INBOX_NOT_AVAILABLE_NO_MESSAGE_TABLE',
    };
  }

  async activityFeed(params: { tenantId: string; limit: number }) {
    const { tenantId } = params;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 50
        ? params.limit
        : 10;

    const [latestAppointments, latestCustomers] = await Promise.all([
      this.prisma.appointments.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          customers: true,
          services: true,
          staff: true,
        },
      }),
      this.prisma.customers.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const appointmentItems = latestAppointments.map((a: any) => ({
      type: 'appointment',
      message: `${a.customers?.name ?? 'Müşteri'} için ${a.services?.name ?? 'hizmet'} randevusu oluşturuldu`,
      createdAt: a.createdAt,
      meta: {
        appointmentId: a.id,
        customerName: a.customers?.name ?? null,
        serviceName: a.services?.name ?? null,
        staffName: a.staff?.name ?? null,
        status: a.status ?? null,
        date: a.date,
        time: a.time,
      },
    }));

    const customerItems = latestCustomers.map((c: any) => ({
      type: 'customer',
      message: `${c.name ?? c.phoneNumber ?? 'Yeni müşteri'} müşteri havuzuna eklendi`,
      createdAt: c.createdAt,
      meta: {
        customerId: c.id,
        customerName: c.name ?? null,
        phoneNumber: c.phoneNumber ?? null,
      },
    }));

    const items = [...appointmentItems, ...customerItems]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, limit);

    return {
      ok: true,
      tenantId,
      total: items.length,
      items,
      __debug: 'ADMIN_ACTIVITY_FEED_V1',
    };
  }

  async channelPerformance(params: { tenantId: string }) {
    const { tenantId } = params;

    const grouped = await this.prisma.appointments.groupBy({
      by: ['channel'],
      where: { tenantId },
      _count: { _all: true },
    });

    const counts = new Map<string, number>();
    for (const row of grouped as any[]) {
      counts.set(
        String(row.channel ?? 'UNKNOWN'),
        Number(row._count?._all ?? 0),
      );
    }

    const whatsapp = counts.get('WHATSAPP') ?? 0;
    const instagram = counts.get('INSTAGRAM') ?? 0;
    const mail = counts.get('MAIL') ?? 0;

    return {
      ok: true,
      tenantId,
      channels: {
        whatsapp: {
          count: whatsapp,
          label: whatsapp > 0 ? `${whatsapp} randevuya dönüştü` : 'Veri yok',
        },
        instagram: {
          count: instagram,
          label: instagram > 0 ? `${instagram} randevuya dönüştü` : 'Veri yok',
        },
        mail: {
          count: mail,
          label: mail > 0 ? `${mail} randevuya dönüştü` : 'Veri yok',
        },
      },
      __debug: 'ADMIN_CHANNEL_PERFORMANCE_V1',
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

    const peer = String(params.peer || '').trim();
    if (!peer) throw new BadRequestException('peer gerekli (müşteri telefonu)');

    const page =
      Number.isFinite(params.page) && params.page > 0 ? params.page : 1;
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 && params.limit <= 200
        ? params.limit
        : 50;

    return {
      ok: true,
      tenantId,
      peer,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      page,
      limit,
      total: 0,
      pages: 0,
      items: [],
      __debug: 'WHATSAPP_MESSAGES_NOT_AVAILABLE_NO_MESSAGE_TABLE',
    };
  }
}
