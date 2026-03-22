import { Injectable } from '@nestjs/common';
import {
  BookingCoreService,
} from './booking-core.service';
import { BookingSlotSuggestion } from './booking.types';

export type BookingDraft = {
  customerName?: string;
  serviceId?: string;
  serviceName?: string;
  dateTimeText?: string;
};

export type BookingStepResult =
  | { type: 'ASK_NAME' }
  | { type: 'ASK_SERVICE' }
  | { type: 'ASK_DATETIME' }
  | { type: 'ASK_CONFIRMATION'; summary: string }
  | { type: 'SUCCESS'; message: string }
  | { type: 'ERROR'; message: string };

@Injectable()
export class BookingOrchestratorService {
  constructor(private readonly bookingCore: BookingCoreService) {}

  async processStep(
    draft: BookingDraft,
    payload: {
      tenantId: string;
      customerPhone: string;
      channel: 'WHATSAPP' | 'VOICE';
      callId?: string;
      streamSid?: string;
    },
  ): Promise<BookingStepResult> {
    void payload;

    if (!draft.serviceId || !draft.serviceName) {
      return { type: 'ASK_SERVICE' };
    }

    if (!draft.dateTimeText) {
      return { type: 'ASK_DATETIME' };
    }

    if (!draft.customerName) {
      return { type: 'ASK_NAME' };
    }

    return {
      type: 'ASK_CONFIRMATION',
      summary: this.buildSummary(draft),
    };
  }

  async confirmBooking(
    draft: BookingDraft,
    payload: {
      tenantId: string;
      customerPhone: string;
      channel: 'WHATSAPP' | 'VOICE';
      callId?: string;
      streamSid?: string;
    },
  ): Promise<BookingStepResult> {
    const startAt = this.bookingCore.parseDateTimeForConversation(
      draft.dateTimeText || '',
    );
    const serviceDuration = await this.getServiceDuration(
      payload.tenantId,
      draft.serviceId,
    );

    if (!draft.serviceId || !draft.serviceName) {
      return {
        type: 'ERROR',
        message:
          payload.channel === 'VOICE'
            ? 'Hangi işlem için randevu istediğinizi tekrar söyler misiniz?'
            : 'Hangi hizmet için randevu istediğinizi tekrar yazar mısınız?',
      };
    }

    if (!draft.dateTimeText || !startAt) {
      return {
        type: 'ERROR',
        message:
          payload.channel === 'VOICE'
            ? 'Gün ve saati tekrar söyler misiniz?'
            : 'Gün ve saati tekrar yazar mısınız?',
      };
    }

    if (!draft.customerName) {
      return {
        type: 'ERROR',
        message:
          payload.channel === 'VOICE'
            ? 'Ad soyadınızı tekrar söyler misiniz?'
            : 'Ad soyadınızı tekrar yazar mısınız?',
      };
    }

    const result = await this.bookingCore.createBookingFromConversation({
      tenantId: payload.tenantId,
      customerPhone: payload.customerPhone,
      customerName: draft.customerName,
      serviceId: draft.serviceId,
      startAt,
      channel: payload.channel,
      callId: payload.callId,
      streamSid: payload.streamSid,
    });

    if (result.ok) {
      return {
        type: 'SUCCESS',
        message:
          payload.channel === 'VOICE'
            ? `Tamam. ${draft.serviceName} randevunuzu oluşturdum.`
            : `Tamamdır, ${draft.serviceName} için randevunuzu oluşturdum.`,
      };
    }

    if (result.code === 'OUT_OF_HOURS') {
      return {
        type: 'ERROR',
        message: this.buildOutOfHoursMessage(
          payload.channel,
          startAt,
          serviceDuration,
          result.suggestions,
        ),
      };
    }

    if (result.code === 'SLOT_TAKEN') {
      return {
        type: 'ERROR',
        message: this.buildSlotTakenMessage(payload.channel, result.suggestions),
      };
    }

    if (result.code === 'STAFF_CONFIGURATION_REQUIRED') {
      return {
        type: 'ERROR',
        message:
          payload.channel === 'VOICE'
            ? 'Sistem personel ayarı eksik. İşletme yöneticisi kontrol etmeli.'
            : 'Randevu ayarı tamamlanamadı. Lütfen işletme yöneticisi varsayılan personel tanımlasın.',
      };
    }

    return {
      type: 'ERROR',
      message:
        payload.channel === 'VOICE'
          ? 'Randevuyu oluşturamadım. Tekrar deneyelim.'
          : 'Randevu oluşturulamadı. Bilgileri tekrar yazar mısınız?',
    };
  }

  private buildSummary(draft: BookingDraft): string {
    const customerName = draft.customerName || 'müşteri';
    const serviceName = draft.serviceName || 'işlem';

    const parsed = this.bookingCore.parseDateTimeForConversation(
      draft.dateTimeText || '',
    );

    const dateLabel = parsed
      ? this.formatSlot(parsed)
      : this.cleanDateTimeText(draft.dateTimeText || 'uygun zaman');

    return `${customerName} adına, ${dateLabel} için ${serviceName}`;
  }

  private cleanDateTimeText(value: string): string {
    return String(value || '')
      .replace(/\brandevu(su|sunu|yu|yı)?\b/gi, ' ')
      .replace(/\biçin\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }


  private async getServiceDuration(
    tenantId: string,
    serviceId?: string,
  ): Promise<number | null> {
    if (!serviceId) {
      return null;
    }

    const services = await this.bookingCore.listServicesForConversation(tenantId);
    const service = services.find((item) => item.id === serviceId);
    return typeof service?.duration === 'number' ? service.duration : null;
  }

  private buildOutOfHoursMessage(
    channel: 'WHATSAPP' | 'VOICE',
    requestedStartAt?: string | null,
    serviceDuration?: number | null,
    suggestions?: BookingSlotSuggestion[],
  ): string {
    const requestedLabel = requestedStartAt
      ? this.formatTime(requestedStartAt)
      : null;
    const latestValidLabel = this.findLatestValidSuggestion(
      requestedStartAt,
      serviceDuration,
      suggestions,
    );
    const suggestionText = this.formatSuggestions(suggestions);

    if (requestedLabel && latestValidLabel) {
      return channel === 'VOICE'
        ? `${requestedLabel} bu hizmet için geç bir başlangıç saati oluyor. En yakın uygun saat ${latestValidLabel}. İsterseniz o saate alabilirim.`
        : `${requestedLabel} bu hizmet için geç bir başlangıç saati oluyor. En yakın uygun saat ${latestValidLabel}. İstersen o saate alabilirim.`;
    }

    if (suggestionText) {
      return channel === 'VOICE'
        ? `Bu saat çalışma saatleri dışında kalıyor. Size en yakın uygun saatler: ${suggestionText}.`
        : `Bu saat çalışma saatleri dışında kalıyor. En yakın uygun saatler: ${suggestionText}.`;
    }

    return channel === 'VOICE'
      ? 'Bu saat çalışma saatleri dışında kalıyor. Başka gün veya saat söyleyebilir misiniz?'
      : 'Bu saat çalışma saatleri dışında kalıyor. Başka bir gün veya saat yazar mısınız?';
  }

  private findLatestValidSuggestion(
    requestedStartAt?: string | null,
    serviceDuration?: number | null,
    suggestions?: BookingSlotSuggestion[],
  ): string | null {
    if (!requestedStartAt || !serviceDuration || !suggestions?.length) {
      return null;
    }

    const requested = new Date(requestedStartAt);
    if (Number.isNaN(requested.getTime())) {
      return null;
    }

    const candidate = suggestions.find((slot) => {
      const suggestedStart = new Date(slot.startAt);
      const suggestedEnd = new Date(slot.endAt);

      if (Number.isNaN(suggestedStart.getTime()) || Number.isNaN(suggestedEnd.getTime())) {
        return false;
      }

      const closingTime = suggestedEnd.getTime();
      const latestValidStart = new Date(closingTime - serviceDuration * 60_000);

      return latestValidStart <= requested;
    });

    if (!candidate) {
      return null;
    }

    const latestValidStart = new Date(
      new Date(candidate.endAt).getTime() - serviceDuration * 60_000,
    );

    return this.formatTime(latestValidStart.toISOString());
  }


  private buildSlotTakenMessage(
    channel: 'WHATSAPP' | 'VOICE',
    suggestions?: BookingSlotSuggestion[],
  ): string {
    const suggestionText = this.formatSuggestions(suggestions);

    if (suggestionText) {
      return channel === 'VOICE'
        ? `O saat dolu görünüyor. Size en yakın uygun saatler: ${suggestionText}.`
        : `O saat dolu görünüyor. En yakın uygun saatler: ${suggestionText}.`;
    }

    return channel === 'VOICE'
      ? 'O saat dolu görünüyor. Başka gün veya saat söyleyebilir misiniz?'
      : 'O saat dolu görünüyor. Başka bir gün veya saat yazar mısınız?';
  }

  private formatTime(iso: string): string | null {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  private formatSuggestions(
    suggestions?: BookingSlotSuggestion[],
  ): string | null {
    if (!suggestions?.length) {
      return null;
    }

    const labels = suggestions
      .slice(0, 3)
      .map((slot) => this.formatSlot(slot.startAt))
      .filter(Boolean);

    if (!labels.length) {
      return null;
    }

    return labels.join(', ');
  }

  private formatSlot(iso: string): string | null {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
}
