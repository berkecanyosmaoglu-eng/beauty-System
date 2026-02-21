import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { NotificationsService } from '../notifications/notifications.service';


type NextAvailableInput = {
  tenantId: string;
  staffId: string;
  serviceId: string;
  desiredStart: Date | string;
  stepMinutes?: number;   // default 15
  searchHours?: number;   // default 24
  suggestions?: number;   // default 5
};


// --- Booking time rules (TR) ---
const TR_OFFSET = '+03:00'; // Europe/Istanbul (fixed offset, no DST)
const MIN_LEAD_MINUTES = 60; // "şimdi + 60dk" altına randevu alma
const MAX_FUTURE_DAYS = 30;  // en fazla 30 gün ileri

function coerceToTrIso(input: string) {
  // Accept:
  // - 2026-02-02T14:00
  // - 2026-02-02 14:00
  // - 2026-02-02T14:00:00
  // If timezone missing, assume TR (+03:00)
  const s = String(input).trim();

  // If already has Z or +hh:mm or -hh:mm, keep as is.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;

  // Normalize space to T
  const normalized = s.includes(' ') ? s.replace(' ', 'T') : s;

  // If has only date, reject (we need time)
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized + 'T00:00:00' + TR_OFFSET;

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



@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private addMinutes(d: Date, minutes: number) {
    return new Date(d.getTime() + minutes * 60 * 1000);
  }

  private isValidDate(d: any) {
    return d instanceof Date && !Number.isNaN(d.getTime());
  }

  private async getServiceOrThrow(serviceId: string) {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) throw new BadRequestException('serviceId geçersiz');
    if (!service.duration || service.duration <= 0) {
      throw new BadRequestException('service duration geçersiz');
    }
    return service;
  }

  private async hasOverlap(params: {
    tenantId: string;
    staffId: string;
    startAt: Date;
    endAt: Date;
    excludeAppointmentId?: string;
  }) {
    const { tenantId, staffId, startAt, endAt, excludeAppointmentId } = params;

    const overlap = await this.prisma.appointment.findFirst({
      where: {
        tenantId,
        staffId,
        // iptal edilenleri sayma (senin statü isimlerin farklıysa burayı genişletiriz)
        NOT: { status: 'cancelled' as any },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        // Overlap şartı: existing.start < new.end && existing.end > new.start
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { id: true, startAt: true, endAt: true },
    });

    return overlap;
  }

  // ✅ NEW: slot check + suggestions (controller burayı çağırıyor)
  async nextAvailable(input: NextAvailableInput) {
    const {
      tenantId,
      staffId,
      serviceId,
      desiredStart,
      stepMinutes = 15,
      searchHours = 24,
      suggestions = 5,
    } = input;

    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    if (!staffId) throw new BadRequestException('staffId gerekli');
    if (!serviceId) throw new BadRequestException('serviceId gerekli');

    const service = await this.getServiceOrThrow(serviceId);

// desiredStart Date geliyorsa aynen, string geliyorsa TR offset uygula
const start =
  typeof (desiredStart as any) === 'string'
    ? new Date(coerceToTrIso(String(desiredStart)))
    : new Date(desiredStart);

if (!this.isValidDate(start)) throw new BadRequestException('desiredStart geçersiz');

// Lead time + max future
const now = new Date();
const minStart = this.addMinutes(now, MIN_LEAD_MINUTES);
if (start < minStart) {
  return {
    ok: false,
    message: `En erken ${MIN_LEAD_MINUTES} dakika sonrası için saat seçilebilir`,
    desired: null,
    suggestions: [],
  };
}
const maxStart = this.addMinutes(now, MAX_FUTURE_DAYS * 24 * 60);
if (start > maxStart) {
  return {
    ok: false,
    message: `En fazla ${MAX_FUTURE_DAYS} gün ileriye randevu alınabilir`,
    desired: null,
    suggestions: [],
  };
}

    const desiredEnd = this.addMinutes(start, Number(service.duration));
    const conflict = await this.hasOverlap({
      tenantId,
      staffId,
      startAt: start,
      endAt: desiredEnd,
    });

    // Uygunsa direkt "ok:true"
    if (!conflict) {
      return {
        ok: true,
        message: 'Uygun',
        desired: { startAt: start.toISOString(), endAt: desiredEnd.toISOString() },
        suggestions: [],
      };
    }

    // Doluysa suggestion üret
    const slots: { startAt: string; endAt: string }[] = [];
    const endSearch = new Date(start.getTime() + searchHours * 60 * 60 * 1000);

    let cursor = new Date(start);
    // sonsuz döngü koruması
    const maxIterations = Math.min(2000, Math.ceil((searchHours * 60) / Math.max(1, stepMinutes)) + 10);

    for (let i = 0; i < maxIterations; i++) {
      if (cursor >= endSearch) break;

      const candStart = new Date(cursor);
      const candEnd = this.addMinutes(candStart, Number(service.duration));

      const c = await this.hasOverlap({
        tenantId,
        staffId,
        startAt: candStart,
        endAt: candEnd,
      });

      if (!c) {
        slots.push({ startAt: candStart.toISOString(), endAt: candEnd.toISOString() });
        if (slots.length >= suggestions) break;
      }

      cursor = this.addMinutes(cursor, stepMinutes);
    }

    return {
      ok: false,
      message: 'Bu saat dolu',
      desired: { startAt: start.toISOString(), endAt: desiredEnd.toISOString() },
      suggestions: slots,
    };
  }

  async create(dto: CreateAppointmentDto) {
    if (!dto?.tenantId) throw new BadRequestException('tenantId gerekli');
    if (!dto?.customerId) throw new BadRequestException('customerId gerekli');
    if (!dto?.serviceId) throw new BadRequestException('serviceId gerekli');
    if (!dto?.staffId) throw new BadRequestException('staffId gerekli');
    if (!dto?.startAt) throw new BadRequestException('startAt gerekli');

    const service = await this.getServiceOrThrow(dto.serviceId);

const startAt = new Date(coerceToTrIso(String(dto.startAt)));
if (!this.isValidDate(startAt)) throw new BadRequestException('startAt geçersiz');

// Lead time + max future
const now = new Date();
const minStart = this.addMinutes(now, MIN_LEAD_MINUTES);
if (startAt < minStart) {
  throw new BadRequestException(`Randevu en erken ${MIN_LEAD_MINUTES} dakika sonrasına alınabilir`);
}
const maxStart = this.addMinutes(now, MAX_FUTURE_DAYS * 24 * 60);
if (startAt > maxStart) {
  throw new BadRequestException(`Randevu en fazla ${MAX_FUTURE_DAYS} gün ileriye alınabilir`);
}

const endAt = this.addMinutes(startAt, Number(service.duration));

    const conflict = await this.hasOverlap({
      tenantId: dto.tenantId,
      staffId: dto.staffId,
      startAt,
      endAt,
    });

    if (conflict) {
      // ✅ doluysa: 409 + suggestions
      const suggest = await this.nextAvailable({
        tenantId: dto.tenantId,
        staffId: dto.staffId,
        serviceId: dto.serviceId,
        desiredStart: startAt,
        stepMinutes: 15,
        searchHours: 24,
        suggestions: 5,
      });

      throw new ConflictException(suggest);
    }

    const created = await this.prisma.appointment.create({
      data: {
        tenantId: dto.tenantId,
        customerId: dto.customerId,
        serviceId: dto.serviceId,
        staffId: dto.staffId,
        startAt,
        endAt,
        status: (dto as any).status ?? 'scheduled',
        channel: (dto as any).channel ?? 'API',
      },
      include: {
        customer: true,
        service: true,
        staff: true,
      },
    });

    // Bildirim/WhatsApp/SMS tarafı sende ayrı modülde zaten var; burada dokunmuyorum.
    // İstersen create sonrası notificationsService trigger’ı ekleriz.

    return created;
  }

  async findAll(
    tenantId?: string,
    date?: string,
    status?: string,
    today = false,
  ) {
    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (status) where.status = status;

    if (today) {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      where.startAt = { gte: start, lte: end };
    } else if (date) {
      // date=YYYY-MM-DD beklersek
      const d = new Date(date);
      if (this.isValidDate(d)) {
        const start = new Date(d);
        start.setHours(0, 0, 0, 0);
        const end = new Date(d);
        end.setHours(23, 59, 59, 999);
        where.startAt = { gte: start, lte: end };
      }
    }

    return this.prisma.appointment.findMany({
      where,
      orderBy: { startAt: 'asc' },
      include: { customer: true, service: true, staff: true },
    });
  }

  async findOne(id: string) {
    const appt = await this.prisma.appointment.findUnique({
      where: { id },
      include: { customer: true, service: true, staff: true },
    });
    if (!appt) throw new NotFoundException('appointment bulunamadı');
    return appt;
  }

  async update(id: string, dto: UpdateAppointmentDto) {
    const existing = await this.prisma.appointment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('appointment bulunamadı');

    // startAt değişiyorsa endAt’yi de service duration ile güncelle + overlap kontrol
    let startAt: Date | undefined;
    let endAt: Date | undefined;

    if ((dto as any).startAt) {
      const serviceId = (dto as any).serviceId ?? existing.serviceId;
      const staffId = (dto as any).staffId ?? existing.staffId;
      const tenantId = (dto as any).tenantId ?? existing.tenantId;

      const service = await this.getServiceOrThrow(serviceId);
      startAt = new Date(String((dto as any).startAt));
      if (!this.isValidDate(startAt)) throw new BadRequestException('startAt geçersiz');
      endAt = this.addMinutes(startAt, Number(service.duration));

      const conflict = await this.hasOverlap({
        tenantId,
        staffId,
        startAt,
        endAt,
        excludeAppointmentId: id,
      });

      if (conflict) {
        const suggest = await this.nextAvailable({
          tenantId,
          staffId,
          serviceId,
          desiredStart: startAt,
          stepMinutes: 15,
          searchHours: 24,
          suggestions: 5,
        });
        throw new ConflictException(suggest);
      }
    }

    return this.prisma.appointment.update({
      where: { id },
      data: {
        ...(dto as any),
        ...(startAt ? { startAt } : {}),
        ...(endAt ? { endAt } : {}),
      },
      include: { customer: true, service: true, staff: true },
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.appointment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('appointment bulunamadı');

    // Silmek yerine iptal istersen burada status=canceled yaparız
    return this.prisma.appointment.delete({ where: { id } });
  }
}
