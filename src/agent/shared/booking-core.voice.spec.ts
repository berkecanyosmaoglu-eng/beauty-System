import { BookingCoreService } from './booking-core.service';
import { VoiceAgentService } from '../voice-agent.service';
import { VoiceConversationService } from '../voice/voice-conversation.service';

describe('BookingCoreService voice booking flow', () => {
  const tenantId = 'tenant-1';
  const from = '+905551112233';

  const services = [
    { id: 'svc-1', name: 'Lazer Epilasyon', price: 1200, duration: 60 },
    { id: 'svc-2', name: 'Cilt Bakımı', price: 900, duration: 50 },
    { id: 'svc-3', name: 'Manikür', price: 400, duration: 45 },
    { id: 'svc-4', name: 'Pedikür', price: 500, duration: 45 },
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
        findFirst: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            services.find((service) => service.id === where?.id) || services[0],
          ),
        ),
      },
      staff: {
        findMany: jest.fn().mockResolvedValue(staff),
        findFirst: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(staff.find((item) => item.id === where?.id) || staff[0]),
        ),
      },
      customers: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'cust-1' }),
        update: jest.fn().mockResolvedValue(null),
      },
      appointments: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'appt-1' }),
        update: jest.fn().mockResolvedValue({ id: 'appt-1' }),
      },
    } as any;
  }

  it('moves to BOOKING_INTENT_DETECTED when booking intent is detected', async () => {
    const service = new BookingCoreService(createPrismaMock());

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Lazer epilasyon almak istiyoruz',
      channel: 'voice',
    });

    expect(reply).toMatch(/hangi gün|ne zamana|gün ve saat/i);
    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.state).toBe('AWAITING_DATETIME');
    expect(session.draft.serviceId).toBe('svc-1');
  });

  it('moves to AWAITING_CONFIRMATION when datetime is provided', async () => {
    const service = new BookingCoreService(createPrismaMock());

    await service.replyText({
      tenantId,
      from,
      text: 'Lazer epilasyon almak istiyoruz',
      channel: 'voice',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'yarın 19:00',
      channel: 'voice',
    });

    expect(reply).toMatch(/onaylıyor musunuz|onaylayayım mı|oluşturuyorum/i);
    const session = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(session.state).toBe('AWAITING_CONFIRMATION');
  });

  it('confirms booking only when a pending booking exists', async () => {
    const service = new BookingCoreService(createPrismaMock());

    const idleReply = await service.replyText({
      tenantId,
      from,
      text: 'tamam',
      channel: 'voice',
    });
    const idleSession = (service as any).sessions.get(`${tenantId}:${from}`);
    expect(idleSession.state).toBe('IDLE');
    expect(idleReply).not.toBe(
      'Rezervasyonunuz oluşturuldu. Randevunuzdan 2 saat önce bir hatırlatma mesajı alacaksınız.',
    );

    await service.replyText({
      tenantId,
      from,
      text: 'Lazer epilasyon almak istiyoruz',
      channel: 'voice',
    });
    await service.replyText({
      tenantId,
      from,
      text: 'yarın 19:00',
      channel: 'voice',
    });

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'evet',
      channel: 'voice',
    });

    expect(reply).toBe(
      'Rezervasyonunuz oluşturuldu. Randevunuzdan 2 saat önce bir hatırlatma mesajı alacaksınız.',
    );
  });

  it('does not ask for staff during voice booking flow', async () => {
    const service = new BookingCoreService(createPrismaMock());

    const reply = await service.replyText({
      tenantId,
      from,
      text: 'Randevu almak istiyorum',
      channel: 'voice',
    });

    expect(reply).toMatch(/hangi hizmet|hangi işlem|hangi islem/i);
    expect(reply).not.toMatch(/personel|uzman|kim olsun/i);
  });

  it('returns a shortened voice service list', async () => {
    const core = new BookingCoreService(createPrismaMock());
    const voiceConversation = new VoiceConversationService(core);
    const voice = new VoiceAgentService(voiceConversation);

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
    expect(reply).toContain('Hangisi için randevu istersiniz?');
  });
});
