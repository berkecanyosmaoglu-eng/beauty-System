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
  stepMinutes?: number; // default 15
  searchHours?: number; // default 24
  suggestions?: number; // default 5
};

// --- Booking time rules (TR) ---
const TR_OFFSET = '+03:00'; // Europe/Istanbul (fixed offset, no DST)
const TR_OFFSET_MINUTES = 3 * 60;
const MIN_LEAD_MINUTES = 60; // "şimdi + 60dk" altına randevu alma
const MAX_FUTURE_DAYS = 30; // en fazla 30 gün ileri

function coerceToTrIso(input: string) {
  const s = String(input).trim();

  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return s;

  const normalized = s.includes(' ') ? s.replace(' ', 'T') : s;

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized + 'T00:00:00' + TR_OFFSET;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    return normalized + ':00' + TR_OFFSET;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized + TR_OFFSET;
  }

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

  private pad2(n: number) {
    return String(n).padStart(2, '0');
  }

  private toTrShiftedDate(d: Date) {
    return new Date(d.getTime() + TR_OFFSET_MINUTES * 60 * 1000);
  }

  private toTrDateString(d: Date) {
    const tr = this.toTrShiftedDate(d);
    const y = tr.getUTCFullYear();
    const m = this.pad2(tr.getUTCMonth() + 1);
    const day = this.pad2(tr.getUTCDate());
    return `${y}-${m}-${day}`;
  }

  private toTrTimeString(d: Date) {
    const tr = this.toTrShiftedDate(d);
    const hh = this.pad2(tr.getUTCHours());
    const mm = this.pad2(tr.getUTCMinutes());
    return `${hh}:${mm}`;
  }

  private trDayStartAsDate(d: Date) {
    return new Date(`${this.toTrDateString(d)}T00:00:00${TR_OFFSET}`);
  }

  private timeToMinutes(time: string) {
    const [hh, mm] = String(time).split(':').map(Number);
    return (hh || 0) * 60 + (mm || 0);
  }

  private minutesToTime(minutes: number) {
    const safe = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
    const hh = Math.floor(safe / 60);
    const mm = safe % 60;
    return `${this.pad2(hh)}:${this.pad2(mm)}`;
  }

  private async getServiceOrThrow(serviceId: string) {
    const service = await this.prisma.services.findUnique({
      where: { id: serviceId },
    });
    if (!service) throw new BadRequestException('serviceId geçersiz');
    if (!service.duration || service.duration <= 0) {
      throw new BadRequestException('service duration geçersiz');
    }
    return service;
  }

  private async hasOverlap(params: {
    tenantId: string;
    staffId: string;
    date: Date;
    time: string;
    endTime: string;
    excludeAppointmentId?: string;
  }) {
    const { tenantId, staffId, date, time, endTime, excludeAppointmentId } = params;

    const targetStartMin = this.timeToMinutes(time);
    const targetEndMin = this.timeToMinutes(endTime);

    const sameDayAppointments = await this.prisma.appointments.findMany({
      where: {
        tenantId,
        staffId,
        date,
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        NOT: {
          status: {
            in: ['cancelled', 'canceled'],
          },
        },
      } as any,
      include: {
        services: true,
      },
    });

    for (const appt of sameDayAppointments as any[]) {
      const existingStartMin = this.timeToMinutes(appt.time);

      let existingEndMin: number;
      if (appt.endTime) {
        existingEndMin = this.timeToMinutes(appt.endTime);
      } else {
        const duration = Number(appt?.services?.duration ?? 0);
        existingEndMin = existingStartMin + Math.max(0, duration);
      }

      const overlaps =
        existingStartMin < targetEndMin && existingEndMin > targetStartMin;

      if (overlaps) {
        return appt;
      }
    }

    return null;
  }

  private async buildSlotParts(startInput: Date | string, serviceId: string) {
    const service = await this.getServiceOrThrow(serviceId);

    const start =
      typeof startInput === 'string'
        ? new Date(coerceToTrIso(String(startInput)))
        : new Date(startInput);

    if (!this.isValidDate(start)) {
      throw new BadRequestException('startAt geçersiz');
    }

    const now = new Date();
    const minStart = this.addMinutes(now, MIN_LEAD_MINUTES);
    if (start < minStart) {
      throw new BadRequestException(
        `Randevu en erken ${MIN_LEAD_MINUTES} dakika sonrasına alınabilir`,
      );
    }

    const maxStart = this.addMinutes(now, MAX_FUTURE_DAYS * 24 * 60);
    if (start > maxStart) {
      throw new BadRequestException(
        `Randevu en fazla ${MAX_FUTURE_DAYS} gün ileriye alınabilir`,
      );
    }

    const end = this.addMinutes(start, Number(service.duration));

    return {
      service,
      start,
      end,
      date: this.trDayStartAsDate(start),
      time: this.toTrTimeString(start),
      endTime: this.toTrTimeString(end),
    };
  }

  // ✅ slot check + suggestions
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

    let desired;
    try {
      desired = await this.buildSlotParts(desiredStart, serviceId);
    } catch (err: any) {
      return {
        ok: false,
        message: err?.message || 'desiredStart geçersiz',
        desired: null,
        suggestions: [],
      };
    }

    const conflict = await this.hasOverlap({
      tenantId,
      staffId,
      date: desired.date,
      time: desired.time,
      endTime: desired.endTime,
    });

    if (!conflict) {
      return {
        ok: true,
        message: 'Uygun',
        desired: {
          startAt: desired.start.toISOString(),
          endAt: desired.end.toISOString(),
          date: desired.date.toISOString(),
          time: desired.time,
          endTime: desired.endTime,
        },
        suggestions: [],
      };
    }

    const slots: { startAt: string; endAt: string; date: string; time: string; endTime: string }[] = [];
    const searchStart = new Date(desired.start);
    const endSearch = new Date(
      desired.start.getTime() + searchHours * 60 * 60 * 1000,
    );

    let cursor = new Date(searchStart);
    const maxIterations = Math.min(
      2000,
      Math.ceil((searchHours * 60) / Math.max(1, stepMinutes)) + 10,
    );

    for (let i = 0; i < maxIterations; i++) {
      if (cursor >= endSearch) break;

      const candidate = await this.buildSlotParts(cursor, serviceId);

      const c = await this.hasOverlap({
        tenantId,
        staffId,
        date: candidate.date,
        time: candidate.time,
        endTime: candidate.endTime,
      });

      if (!c) {
        slots.push({
          startAt: candidate.start.toISOString(),
          endAt: candidate.end.toISOString(),
          date: candidate.date.toISOString(),
          time: candidate.time,
          endTime: candidate.endTime,
        });

        if (slots.length >= suggestions) break;
      }

      cursor = this.addMinutes(cursor, stepMinutes);
    }

    return {
      ok: false,
      message: 'Bu saat dolu',
      desired: {
        startAt: desired.start.toISOString(),
        endAt: desired.end.toISOString(),
        date: desired.date.toISOString(),
        time: desired.time,
        endTime: desired.endTime,
      },
      suggestions: slots,
    };
  }

  async create(dto: CreateAppointmentDto) {
    if (!dto?.tenantId) throw new BadRequestException('tenantId gerekli');
    if (!dto?.customerId) throw new BadRequestException('customerId gerekli');
    if (!dto?.serviceId) throw new BadRequestException('serviceId gerekli');
    if (!dto?.staffId) throw new BadRequestException('staffId gerekli');
    if (!(dto as any)?.startAt) throw new BadRequestException('startAt gerekli');

    const slot = await this.buildSlotParts((dto as any).startAt, dto.serviceId);

    const conflict = await this.hasOverlap({
      tenantId: dto.tenantId,
      staffId: dto.staffId,
      date: slot.date,
      time: slot.time,
      endTime: slot.endTime,
    });

    if (conflict) {
      const suggest = await this.nextAvailable({
        tenantId: dto.tenantId,
        staffId: dto.staffId,
        serviceId: dto.serviceId,
        desiredStart: slot.start,
        stepMinutes: 15,
        searchHours: 24,
        suggestions: 5,
      });

      throw new ConflictException(suggest);
    }

    const created = await this.prisma.appointments.create({
      data: {
        tenantId: dto.tenantId,
        customerId: dto.customerId,
        serviceId: dto.serviceId,
        staffId: dto.staffId,
        date: slot.date,
        time: slot.time,
        endTime: slot.endTime,
        status: ((dto as any).status ?? 'scheduled') as any,
      } as any,
      include: {
        customers: true,
        services: true,
        staff: true,
      },
    });

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
      const start = this.trDayStartAsDate(now);
      const end = this.addMinutes(start, 24 * 60 - 1);
      where.date = { gte: start, lte: end };
    } else if (date) {
      const d = new Date(`${date}T00:00:00${TR_OFFSET}`);
      if (this.isValidDate(d)) {
        const start = this.trDayStartAsDate(d);
        const end = this.addMinutes(start, 24 * 60 - 1);
        where.date = { gte: start, lte: end };
      }
    }

    return this.prisma.appointments.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      include: {
        customers: true,
        services: true,
        staff: true,
      },
    });
  }

  async findOne(id: string) {
    const appt = await this.prisma.appointments.findUnique({
      where: { id },
      include: {
        customers: true,
        services: true,
        staff: true,
      },
    });

    if (!appt) throw new NotFoundException('appointment bulunamadı');
    return appt;
  }

  async update(id: string, dto: UpdateAppointmentDto) {
    const existing = await this.prisma.appointments.findUnique({
      where: { id },
      include: {
        services: true,
      },
    });

    if (!existing) throw new NotFoundException('appointment bulunamadı');

    const nextTenantId = ((dto as any).tenantId ?? existing.tenantId) as string;
    const nextCustomerId = ((dto as any).customerId ?? existing.customerId) as string;
    const nextServiceId = ((dto as any).serviceId ?? existing.serviceId) as string;
    const nextStaffId = ((dto as any).staffId ?? existing.staffId) as string;

    let nextDate = existing.date;
    let nextTime = existing.time;
    let nextEndTime = existing.endTime;

    if ((dto as any).startAt) {
      const slot = await this.buildSlotParts((dto as any).startAt, nextServiceId);

      const conflict = await this.hasOverlap({
        tenantId: nextTenantId,
        staffId: nextStaffId,
        date: slot.date,
        time: slot.time,
        endTime: slot.endTime,
        excludeAppointmentId: id,
      });

      if (conflict) {
        const suggest = await this.nextAvailable({
          tenantId: nextTenantId,
          staffId: nextStaffId,
          serviceId: nextServiceId,
          desiredStart: slot.start,
          stepMinutes: 15,
          searchHours: 24,
          suggestions: 5,
        });

        throw new ConflictException(suggest);
      }

      nextDate = slot.date;
      nextTime = slot.time;
      nextEndTime = slot.endTime;
    } else if ((dto as any).serviceId) {
      const service = await this.getServiceOrThrow(nextServiceId);
      nextEndTime = this.minutesToTime(
        this.timeToMinutes(existing.time) + Number(service.duration),
      );

      const conflict = await this.hasOverlap({
        tenantId: nextTenantId,
        staffId: nextStaffId,
        date: existing.date,
        time: existing.time,
        endTime: nextEndTime,
        excludeAppointmentId: id,
      });

      if (conflict) {
        const desiredStart = new Date(
          `${this.toTrDateString(existing.date)}T${existing.time}:00${TR_OFFSET}`,
        );

        const suggest = await this.nextAvailable({
          tenantId: nextTenantId,
          staffId: nextStaffId,
          serviceId: nextServiceId,
          desiredStart,
          stepMinutes: 15,
          searchHours: 24,
          suggestions: 5,
        });

        throw new ConflictException(suggest);
      }
    }

    return this.prisma.appointments.update({
      where: { id },
      data: {
        tenantId: nextTenantId,
        customerId: nextCustomerId,
        serviceId: nextServiceId,
        staffId: nextStaffId,
        date: nextDate,
        time: nextTime,
        endTime: nextEndTime,
        ...((dto as any).status !== undefined
          ? { status: (dto as any).status }
          : {}),
      } as any,
      include: {
        customers: true,
        services: true,
        staff: true,
      },
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.appointments.findUnique({
      where: { id },
    });

    if (!existing) throw new NotFoundException('appointment bulunamadı');

    return this.prisma.appointments.delete({
      where: { id },
    });
  }
}
