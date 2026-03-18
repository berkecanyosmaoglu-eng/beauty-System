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
      customers: { findUnique: jest.fn().mockResolvedValue(null) },
      appointments: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
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
    expect(reply).toMatch(/hangi hizmet/i);

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
});
