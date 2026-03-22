import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  BookingRequest,
  BookingResult,
  BookingSlotSuggestion,
  ConversationBookingRequest,
  ConversationBookingResult,
} from './booking.types';
import { StaffAssignmentService } from './staff-assignment.service';

type WorkingWindow = {
  startMinutes: number;
  endMinutes: number;
  workingDays: Set<number>;
  timezone: string;
};

type ServiceRecord = {
  id: string;
  duration: number;
};

@Injectable()
export class BookingCoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staffAssignment: StaffAssignmentService,
  ) {}

  async listServicesForConversation(tenantId: string) {
    return this.prisma.services.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, duration: true },
    });
  }

  parseDateTimeForConversation(rawText: string): string | null {
    const text = String(rawText || '').trim();
    if (!text) {
      return null;
    }

    const normalized = this.normalizeDateText(text);

    const now = new Date();
    const baseDate = new Date(now);
    baseDate.setSeconds(0, 0);

    if (/\bbugun\b/.test(normalized)) {
      return this.applyClock(baseDate, normalized)?.toISOString() || null;
    }

    if (/\byarin\b/.test(normalized)) {
      baseDate.setDate(baseDate.getDate() + 1);
      return this.applyClock(baseDate, normalized)?.toISOString() || null;
    }

    const explicitDate = this.parseExplicitDate(normalized, now);
    if (explicitDate) {
      return this.applyClock(explicitDate, normalized)?.toISOString() || null;
    }

    const weekdayDate = this.parseWeekdayDate(normalized, now);
    if (weekdayDate) {
      return this.applyClock(weekdayDate, normalized)?.toISOString() || null;
    }

    return null;
  }

  async createBookingFromConversation(
    input: ConversationBookingRequest,
  ): Promise<ConversationBookingResult> {
    const result = await this.createBooking({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      fullName: input.customerName,
      serviceId: input.serviceId,
      startAt: input.startAt,
      channel: input.channel,
      messageSessionId: input.messageSessionId,
      callSessionId: input.callId || input.streamSid,
    });

    if (result.ok) {
      return result;
    }

    if (result.code === 'OUTSIDE_WORKING_HOURS') {
      return { ok: false, code: 'OUT_OF_HOURS', suggestions: result.suggestions };
    }

    if (result.code === 'SLOT_CONFLICT') {
      return { ok: false, code: 'SLOT_TAKEN', suggestions: result.suggestions };
    }

    return {
      ok: false,
      code: result.code,
      suggestions: result.suggestions,
    };
  }

  async createBooking(input: BookingRequest): Promise<BookingResult> {
    const request = this.normalizeRequest(input);
    if (!request) {
      return { ok: false, code: 'INVALID_REQUEST' };
    }

    const service = await this.prisma.services.findFirst({
      where: { tenantId: request.tenantId, id: request.serviceId },
      select: { id: true, duration: true, isActive: true },
    });

    if (!service) {
      return { ok: false, code: 'SERVICE_NOT_FOUND' };
    }

    if (!service.isActive) {
      return { ok: false, code: 'SERVICE_INACTIVE' };
    }

    const startAt = new Date(request.startAt);
    if (Number.isNaN(startAt.getTime())) {
      return { ok: false, code: 'INVALID_DATETIME' };
    }

    const window = await this.getWorkingWindow(request.tenantId);
    if (!this.isInsideWorkingHours(startAt, service, window)) {
      return {
        ok: false,
        code: 'OUTSIDE_WORKING_HOURS',
        suggestions: this.buildSuggestions(startAt, service.duration, window),
      };
    }

    const assignedStaff = await this.staffAssignment.resolveStaffId(request.tenantId);
    if (!assignedStaff.ok) {
      return { ok: false, code: assignedStaff.code };
    }

    const customer = await this.prisma.customers.upsert({
      where: {
        tenantId_phoneNumber: {
          tenantId: request.tenantId,
          phoneNumber: request.customerPhone,
        },
      },
      update: {
        name: request.fullName,
        updatedAt: new Date(),
      },
      create: {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        phoneNumber: request.customerPhone,
        name: request.fullName,
        updatedAt: new Date(),
      },
      select: { id: true },
    });

    const startMinutes = this.toClockMinutes(startAt, window.timezone);
    const dateOnly = new Date(
      Date.UTC(
        startAt.getUTCFullYear(),
        startAt.getUTCMonth(),
        startAt.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const time = this.toTimeString(startMinutes);
    const endMinutes = startMinutes + service.duration;
    const endAt = new Date(startAt.getTime() + service.duration * 60_000);

    try {
      const appointment = await this.prisma.appointments.create({
        data: {
          id: crypto.randomUUID(),
          tenantId: request.tenantId,
          customerId: customer.id,
          serviceId: service.id,
          staffId: assignedStaff.staffId,
          date: dateOnly,
          time,
          endTime: this.toTimeString(endMinutes),
          status: 'CONFIRMED',
          channel: request.channel,
          messageSessionId: request.messageSessionId,
          callSessionId: request.callSessionId,
          updatedAt: new Date(),
          startAtUtc: startAt,
          endAtUtc: endAt,
        },
        select: { id: true },
      });

      return {
        ok: true,
        appointmentId: appointment.id,
        customerId: customer.id,
        staffId: assignedStaff.staffId,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      };
    } catch (error: any) {
      if (!this.isUniqueConflict(error)) {
        throw error;
      }

      return {
        ok: false,
        code: 'SLOT_CONFLICT',
        suggestions: this.buildSuggestions(startAt, service.duration, window),
      };
    }
  }

  private normalizeRequest(input: BookingRequest): BookingRequest | null {
    const tenantId = String(input?.tenantId || '').trim();
    const customerPhone = String(input?.customerPhone || '').trim();
    const fullName = String(input?.fullName || '').trim();
    const serviceId = String(input?.serviceId || '').trim();
    const startAt = String(input?.startAt || '').trim();

    if (!tenantId || !customerPhone || !fullName || !serviceId || !startAt) {
      return null;
    }

    return {
      tenantId,
      customerPhone,
      fullName,
      serviceId,
      startAt,
      channel: input.channel,
      messageSessionId: input.messageSessionId,
      callSessionId: input.callSessionId,
    };
  }

  private async getWorkingWindow(tenantId: string): Promise<WorkingWindow> {
    const settings = await this.prisma.tenant_settings.findUnique({
      where: { tenantId },
      select: {
        workingHoursStart: true,
        workingHoursEnd: true,
        workingDays: true,
        timezone: true,
      },
    });

    const start = this.parseClockToMinutes(settings?.workingHoursStart || '09:00');
    const end = this.parseClockToMinutes(settings?.workingHoursEnd || '18:00');
    const workingDays = new Set(
      String(settings?.workingDays || '1,2,3,4,5')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    );

    return {
      startMinutes: start,
      endMinutes: end,
      workingDays,
      timezone: String(settings?.timezone || 'Europe/Istanbul'),
    };
  }

  private isInsideWorkingHours(
    startAt: Date,
    service: ServiceRecord,
    window: WorkingWindow,
  ): boolean {
    const day = this.getUtcWeekdayForTimezone(startAt, window.timezone);
    if (!window.workingDays.has(day)) {
      return false;
    }

    const startMinutes = this.toClockMinutes(startAt, window.timezone);
    const endMinutes = startMinutes + service.duration;
    return startMinutes >= window.startMinutes && endMinutes <= window.endMinutes;
  }

  private buildSuggestions(
    startAt: Date,
    durationMinutes: number,
    window: WorkingWindow,
  ): BookingSlotSuggestion[] {
    const suggestions: BookingSlotSuggestion[] = [];
    const candidateOffsets = [60, 120, 180];

    for (const offset of candidateOffsets) {
      const candidateStart = new Date(startAt.getTime() + offset * 60_000);
      if (
        !this.isInsideWorkingHours(
          candidateStart,
          { id: '', duration: durationMinutes },
          window,
        )
      ) {
        continue;
      }

      suggestions.push({
        startAt: candidateStart.toISOString(),
        endAt: new Date(
          candidateStart.getTime() + durationMinutes * 60_000,
        ).toISOString(),
      });
    }

    return suggestions;
  }

  private normalizeDateText(text: string): string {
    return String(text || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/yarın/g, 'yarin')
      .replace(/bugün/g, 'bugun')
      .replace(/pazartesi/g, 'pazartesi')
      .replace(/salı/g, 'sali')
      .replace(/çarşamba/g, 'carsamba')
      .replace(/perşembe/g, 'persembe')
      .replace(/cuma/g, 'cuma')
      .replace(/cumartesi/g, 'cumartesi')
      .replace(/pazar/g, 'pazar')
      .replace(/öğlen/g, '14:00')
      .replace(/ogle/g, '14:00')
      .replace(/öğleden sonra/g, '15:00')
      .replace(/aksam/g, '19:00')
      .replace(/akşam/g, '19:00');
  }

  private parseExplicitDate(text: string, now: Date): Date | null {
    const numeric = text.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
    if (numeric) {
      const day = Number(numeric[1]);
      const month = Number(numeric[2]) - 1;
      const yearRaw = numeric[3];
      const year = yearRaw
        ? yearRaw.length === 2
          ? 2000 + Number(yearRaw)
          : Number(yearRaw)
        : now.getFullYear();

      const dated = new Date(year, month, day);
      dated.setSeconds(0, 0);
      return dated;
    }

    const monthNames: Record<string, number> = {
      ocak: 0,
      subat: 1,
      mart: 2,
      nisan: 3,
      mayis: 4,
      haziran: 5,
      temmuz: 6,
      agustos: 7,
      eylul: 8,
      ekim: 9,
      kasim: 10,
      aralik: 11,
    };

    const verbal = text.match(
      /(\d{1,2})\s+(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)(?:\s+(\d{2,4}))?/,
    );

    if (!verbal) {
      return null;
    }

    const day = Number(verbal[1]);
    const month = monthNames[verbal[2]];
    const yearRaw = verbal[3];
    const year = yearRaw
      ? yearRaw.length === 2
        ? 2000 + Number(yearRaw)
        : Number(yearRaw)
      : now.getFullYear();

    const dated = new Date(year, month, day);
    dated.setSeconds(0, 0);
    return dated;
  }

  private parseWeekdayDate(text: string, now: Date): Date | null {
    const weekdays = [
      'pazar',
      'pazartesi',
      'sali',
      'carsamba',
      'persembe',
      'cuma',
      'cumartesi',
    ];

    const index = weekdays.findIndex((weekday) => text.includes(weekday));
    if (index < 0) {
      return null;
    }

    const candidate = new Date(now);
    const diff = (index - now.getDay() + 7) % 7 || 7;
    candidate.setDate(now.getDate() + diff);
    candidate.setSeconds(0, 0);

    return candidate;
  }


  private applyClock(baseDate: Date, text: string): Date | null {
    const clock = text.match(/(?:saat\s*)?(\d{1,2})[:.](\d{2})/i);
    const half = text.match(/\b(\d{1,2})\s*(bucuk|buçuk)\b/i);
    const saatWhole = text.match(/\bsaat\s*(\d{1,2})(?:\s*(de|da))?\b/i);
    const bareWhole = text.match(/\b(\d{1,2})(?:\s*(de|da))\b/i);

    const date = new Date(baseDate);

    if (clock) {
      let hour = Number(clock[1]);
      const minute = Number(clock[2]);

      if (
        hour >= 1 &&
        hour <= 7 &&
        !/\b(sabah|08|09|10|11)\b/i.test(text)
      ) {
        hour += 12;
      }

      date.setHours(hour, minute, 0, 0);
      return date;
    }

    if (half) {
      let hour = Number(half[1]);
      if (hour >= 1 && hour <= 7) {
        hour += 12;
      }
      date.setHours(hour, 30, 0, 0);
      return date;
    }

    if (saatWhole) {
      let hour = Number(saatWhole[1]);
      if (hour >= 1 && hour <= 7) {
        hour += 12;
      }
      date.setHours(hour, 0, 0, 0);
      return date;
    }

    if (bareWhole) {
      let hour = Number(bareWhole[1]);
      if (hour >= 1 && hour <= 7) {
        hour += 12;
      }
      date.setHours(hour, 0, 0, 0);
      return date;
    }

    return null;
  }

  private isUniqueConflict(error: any): boolean {
    return error?.code === 'P2002';
  }

  private parseClockToMinutes(value: string): number {
    const [hoursRaw, minutesRaw] = String(value || '00:00').split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    return hours * 60 + minutes;
  }

  private toTimeString(totalMinutes: number): string {
    const safeMinutes = ((totalMinutes % 1440) + 1440) % 1440;
    const hours = Math.floor(safeMinutes / 60);
    const minutes = safeMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private toClockMinutes(date: Date, timezone = 'Europe/Istanbul'): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const hours = Number(parts.find((part) => part.type === 'hour')?.value || '0');
    const minutes = Number(
      parts.find((part) => part.type === 'minute')?.value || '0',
    );
    return hours * 60 + minutes;
  }

  private getUtcWeekdayForTimezone(date: Date, timezone: string): number {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).format(date);

    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  }
}
