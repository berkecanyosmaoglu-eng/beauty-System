export type BookingChannel = 'VOICE' | 'WHATSAPP';

export type BookingRequest = {
  tenantId: string;
  customerPhone: string;
  fullName: string;
  serviceId: string;
  startAt: string;
  channel: BookingChannel;
  messageSessionId?: string;
  callSessionId?: string;
};

export type BookingSlotSuggestion = {
  startAt: string;
  endAt: string;
};

export type BookingSuccessResult = {
  ok: true;
  appointmentId: string;
  customerId: string;
  staffId: string;
  startAt: string;
  endAt: string;
};

export type BookingFailureCode =
  | 'INVALID_REQUEST'
  | 'SERVICE_NOT_FOUND'
  | 'SERVICE_INACTIVE'
  | 'NO_STAFF_AVAILABLE'
  | 'STAFF_CONFIGURATION_REQUIRED'
  | 'INVALID_DATETIME'
  | 'OUTSIDE_WORKING_HOURS'
  | 'SLOT_CONFLICT';

export type BookingFailureResult = {
  ok: false;
  code: BookingFailureCode;
  suggestions?: BookingSlotSuggestion[];
};

export type BookingResult = BookingSuccessResult | BookingFailureResult;

export type ConversationBookingRequest = {
  tenantId: string;
  customerPhone: string;
  customerName: string;
  serviceId: string;
  startAt: string;
  channel: BookingChannel;
  messageSessionId?: string;
  callId?: string;
  streamSid?: string;
};

export type ConversationBookingResult =
  | ({ ok: true } & BookingSuccessResult)
  | {
      ok: false;
      code:
        | 'INVALID_REQUEST'
        | 'SERVICE_NOT_FOUND'
        | 'SERVICE_INACTIVE'
        | 'NO_STAFF_AVAILABLE'
        | 'STAFF_CONFIGURATION_REQUIRED'
        | 'INVALID_DATETIME'
        | 'OUT_OF_HOURS'
        | 'SLOT_TAKEN';
      suggestions?: BookingSlotSuggestion[];
    };
