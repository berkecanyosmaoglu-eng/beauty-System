import { BookingCoreService } from './booking-core.service';
import { VoiceAgentService } from '../voice-agent.service';

describe('BookingCoreService voice booking guards', () => {
  const tenantId = 'tenant-1';
  const from = '+905551112233';

  const services = [
    { id: 'svc-1', name: 'Lazer Epilasyon', price: 1200, duration: 60 },
    { id: 'svc-2', name: 'Cilt Bakımı', price: 900, duration: 50 },
    { id: 'svc-3', name: 'Manikür', price: 400, duration: 45 },
    { id: 'svc-4', name: 'Pedikür', price: 500, duration: 45 },
    { id: 'svc-5', name: 'Protez Tırnak', price: 1500, duration: 90 },
  ];
  const staff = [
    { id: 'stf-1', name: 'Ayşe' },
    { id: 'stf-2', name: 'Fatma' },
    { id: 'stf-3', name: 'Esra' },
    { id: 'stf-4', name: 'Elif Kaya', fullName: 'Elif Kaya' },
  ];

  function createPrismaMock() {
    return {
      businessProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      services: {
        findMany: jest.fn().mockResolvedValue(services),
        findFirst: jest.fn().mockResolvedValue(services[0]),
      },
      staff: {
        findMany: jest.fn().mockResolvedValue(staff),
        findFirst: jest.fn().mockResolvedValue(staff[0]),
      },
      customers: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'cust-1' }),
      },
      appointments: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'appt-1' }),
      },
    } as any;
  }

  it("starts voice booking flow for 'yarın sabah 8'e randevu almak isterim'", async () => {
    const service = new BookingCoreService(createPrismaMock());

    const reply = await service.replyText({
      tenantId,
      from,
      text: "Yarın sabah 8'e randevu almak isterim",
      channel: 'voice',
    });

    expect(reply).not.toContain('Şu an görünen bir randevun yok');
    expect(reply).toMatch(/hangi (hizmet|işlem|islem)/i);

    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.state).toBe('WAIT_SERVICE');
    expect(session.pendingStartAt).toContain('T08:00:00+03:00');
  });

  it("does not store 'bir defa olsun' as customerName in voice mode", () => {
    const service = new BookingCoreService(createPrismaMock());
    const session = {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-1',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    } as any;

    (service as any).extractSlotsFromMessage({
      session,
      raw: 'Bir defa olsun',
      services,
      staff,
      isVoice: true,
    });

    expect(session.draft.customerName).toBeUndefined();
    expect(session.draft.staffId).toBe('stf-1');
    expect(session.draft.serviceId).toBe('svc-1');
  });

  it('merges pendingDateOnly with a later time on the same day', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;
    const friday = '2026-03-20';

    (service as any).sessions.set(key, {
      state: 'WAIT_DATETIME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-1',
        staffId: 'stf-1',
        customerName: 'Ayşe Yılmaz',
      },
      pendingDateOnly: friday,
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Saat 11',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.startAt).toContain(`${friday}T11:00:00+03:00`);
    expect(session.pendingDateOnly).toBeUndefined();
  });

  it('returns a shortened voice service list', async () => {
    const core = new BookingCoreService(createPrismaMock());
    const voice = new VoiceAgentService(core);

    const reply = await voice.replyText({
      tenantId,
      from,
      text: 'Hizmetlerinizi sayar mısınız?',
      channel: 'voice',
    });

    expect(reply).toContain('Lazer Epilasyon');
    expect(reply).toContain('Cilt Bakımı');
    expect(reply).toContain('Manikür');
    expect(reply).toContain('Pedikür');
    expect(reply).not.toContain('Protez Tırnak');
    expect(reply).toContain('Hangisi için randevu istersiniz?');
  });

  it('reuses recent service context for a follow-up booking request', async () => {
    const service = new BookingCoreService(createPrismaMock());

    await service.replyText({
      tenantId,
      from,
      text: 'Protez tırnak hakkında bilgi almak istiyorum',
      channel: 'voice',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Yarına rezervasyon yaptırabilir miyiz?',
      channel: 'voice',
    });

    expect(reply).not.toMatch(/hangi hizmet/i);
    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.draft.serviceId).toBe('svc-5');
  });

  it('treats short follow-up booking requests like "yarına olsun" as continuity-driven booking', async () => {
    const service = new BookingCoreService(createPrismaMock());

    await service.replyText({
      tenantId,
      from,
      text: 'Protez tırnak hakkında bilgi alabilir miyim?',
      channel: 'voice',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Yarına olsun',
      channel: 'voice',
    });

    expect(reply).not.toMatch(/hangi hizmet/i);
    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.draft.serviceId).toBe('svc-5');
    expect(session.pendingDateOnly).toBe('2026-03-19');
    expect(session.state).toBe('WAIT_STAFF');
  });

  it('resolves ellipsis like "bunu alayım" using recent service continuity', async () => {
    const service = new BookingCoreService(createPrismaMock());

    await service.replyText({
      tenantId,
      from,
      text: 'Protez tırnak hakkında bilgi alabilir miyim?',
      channel: 'voice',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Tamam bunu alayım',
      channel: 'voice',
    });

    expect(reply).not.toMatch(/hangi hizmet/i);
    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.draft.serviceId).toBe('svc-5');
    expect(session.state).toBe('WAIT_STAFF');
  });

  it('reuses recent staff context on "Esra Hanım olsun"', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'IDLE',
      draft: {
        tenantId,
        customerPhone: from,
      },
      updatedAt: Date.now(),
      history: [],
      lastServiceId: 'svc-5',
      lastServiceName: 'Protez Tırnak',
      recentStaffId: 'stf-3',
      recentStaffName: 'Esra',
      recentIntentContext: 'info',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Esra Hanım olsun',
      channel: 'voice',
    });

    expect(reply).not.toMatch(/hangi hizmet/i);
    const session = (service as any).sessions.get(key);
    expect(session.draft.serviceId).toBe('svc-5');
    expect(session.draft.staffId).toBe('stf-3');
    expect(session.state).toBe('WAIT_NAME');
  });

  it('does not ask "hangi hizmet" again when continuity already resolved service', async () => {
    const service = new BookingCoreService(createPrismaMock());

    await service.replyText({
      tenantId,
      from,
      text: 'Protez tırnak hakkında bilgi almak istiyorum',
      channel: 'voice',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Tamam',
      channel: 'voice',
    });

    expect(reply).not.toMatch(/hangi hizmet/i);
    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.draft.serviceId).toBe('svc-5');
  });

  it('answers booking follow-up questions from typed session summary after confirmation', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_CONFIRM',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-4',
        customerName: 'Ayşe Yılmaz',
        startAt: '2026-03-19T10:00:00+03:00',
      },
      updatedAt: Date.now(),
      history: [],
    });

    const confirmation = await service.replyText({
      tenantId,
      from,
      text: 'Evet',
      channel: 'voice',
    });
    expect(confirmation).toContain('Rezervasyondan 2 saat önce telefonunuza bir hatırlatma mesajı gönderilecektir.');

    const followUp = await service.replyText({
      tenantId,
      from,
      text: 'Randevuyu hangi saate aldık?',
      channel: 'voice',
    });

    expect(followUp).toContain('2026');
    expect(followUp).toContain('10:00');
    const session = (service as any).sessions.get(key);
    expect(session.lastBookingSummary).toBeTruthy();
    expect(session.lastBookingStartAt).toContain('T10:00:00+03:00');
  });

  it('keeps waiting for staff instead of silently defaulting on weak input', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_STAFF',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'şey yani',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.state).toBe('WAIT_STAFF');
    expect(session.draft.staffId).toBeUndefined();
    expect(reply).toMatch(/personel|fark etmez/i);
  });

  it('accepts a single spoken first name in WAIT_NAME', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Berkecan.',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.customerName).toBe('Berkecan');
    expect(session.state).toBe('WAIT_DATETIME');
  });

  it('accepts first and last name in WAIT_NAME', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Erke Yosunoğlu.',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.customerName).toBe('Erke Yosunoğlu');
  });

  it('accepts foreign names in WAIT_NAME', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Jennifer Lopez.',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.customerName).toBe('Jennifer Lopez');
  });

  it('strips honorifics from customer name in WAIT_NAME', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Aylin Hanım',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.customerName).toBe('Aylin');
  });

  it('rejects non-name acknowledgements in WAIT_NAME', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'tamam',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.customerName).toBeUndefined();
    expect(session.state).toBe('WAIT_NAME');
    expect(reply).toMatch(/isim|ad soyad/i);
  });

  it('parses spoken name correctly even when voice_context metadata is present', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_NAME',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
        staffId: 'stf-1',
      },
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Berkecan.\n\n[voice_context: Yakın intent bağlamı: general.]',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.customerName).toBe('Berkecan');
  });

  it('resolves plain single-token staff reply in WAIT_STAFF without re-asking staff', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_STAFF',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
      },
      updatedAt: Date.now(),
      history: [],
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Elif',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.staffId).toBe('stf-4');
    expect(session.draft.customerName).toBeUndefined();
    expect(session.state).toBe('WAIT_NAME');
    expect(reply).toMatch(/isim|ad soyad/i);
    expect(reply).not.toMatch(/personel/i);
  });

  it('does not save customer name from "Elif olsun" in WAIT_STAFF', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_STAFF',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
      },
      updatedAt: Date.now(),
      history: [],
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Elif olsun',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.staffId).toBe('stf-4');
    expect(session.draft.customerName).toBeUndefined();
    expect(session.state).toBe('WAIT_NAME');
    expect(reply).toMatch(/isim|ad soyad/i);
  });

  it('does not save customer name from "Esra Hanım olsun" in WAIT_STAFF', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    (service as any).sessions.set(key, {
      state: 'WAIT_STAFF',
      draft: {
        tenantId,
        customerPhone: from,
        serviceId: 'svc-5',
      },
      updatedAt: Date.now(),
      history: [],
    });

    await service.replyText({
      tenantId,
      from,
      text: 'Esra Hanım olsun',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.staffId).toBe('stf-3');
    expect(session.draft.customerName).toBeUndefined();
    expect(session.state).toBe('WAIT_NAME');
  });

  it('end-to-end voice booking never stores staff-selection phrase as customer name', async () => {
    const service = new BookingCoreService(createPrismaMock());
    const key = `${tenantId}:${from}`;

    await service.replyText({
      tenantId,
      from,
      text: 'Protez tırnak hakkında bilgi almak istiyorum',
      channel: 'voice',
    });
    await service.replyText({
      tenantId,
      from,
      text: 'Yarına randevu alayım',
      channel: 'voice',
    });

    const staffReply = await service.replyText({
      tenantId,
      from,
      text: 'Elif olsun',
      channel: 'voice',
    });

    const session = (service as any).sessions.get(key);
    expect(session.draft.staffId).toBe('stf-4');
    expect(session.draft.customerName).toBeUndefined();
    expect(staffReply).toMatch(/isim|ad soyad/i);
  });
});
