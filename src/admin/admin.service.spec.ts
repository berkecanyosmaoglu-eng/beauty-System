import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService.sendWhatsappMessage', () => {
  const prisma = {
    tenants: {
      findUnique: jest.fn(),
    },
    notifications: {
      findFirst: jest.fn(),
    },
  } as any;

  const whatsapp = {
    sendProactiveWhatsApp: jest.fn(),
  } as any;

  let service: AdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminService(prisma, whatsapp);
  });

  it('sends a tenant-aware WhatsApp message and returns latest notification log', async () => {
    prisma.tenants.findUnique.mockResolvedValue({
      id: 'cmkeas8p500056hpg59gmkquc',
    });
    whatsapp.sendProactiveWhatsApp.mockResolvedValue({
      provider: 'meta',
      messageId: 'wamid.123',
    });
    prisma.notifications.findFirst.mockResolvedValue({
      id: 'notif_1',
      tenantId: 'cmkeas8p500056hpg59gmkquc',
      type: 'WHATSAPP',
      recipient: '+905551112233',
      body: 'Merhaba',
      status: 'sent',
      metadata: { direction: 'outbound', source: 'admin-panel' },
      sentAt: new Date('2026-03-18T12:00:00.000Z'),
      createdAt: new Date('2026-03-18T12:00:00.000Z'),
    });

    const result = await service.sendWhatsappMessage({
      tenantId: 'cmkeas8p500056hpg59gmkquc',
      to: '+905551112233',
      message: 'Merhaba',
    });

    expect(prisma.tenants.findUnique).toHaveBeenCalledWith({
      where: { id: 'cmkeas8p500056hpg59gmkquc' },
      select: { id: true },
    });
    expect(whatsapp.sendProactiveWhatsApp).toHaveBeenCalledWith({
      tenantId: 'cmkeas8p500056hpg59gmkquc',
      toPhone: '+905551112233',
      body: 'Merhaba',
      subject: 'Admin panel WhatsApp message',
      metadata: {
        source: 'admin-panel',
        route: 'POST /admin/whatsapp/send',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      route: 'POST /admin/whatsapp/send',
      provider: 'meta',
      providerMessageId: 'wamid.123',
      notification: {
        id: 'notif_1',
        tenantId: 'cmkeas8p500056hpg59gmkquc',
      },
    });
  });

  it('throws when tenant does not exist', async () => {
    prisma.tenants.findUnique.mockResolvedValue(null);

    await expect(
      service.sendWhatsappMessage({
        tenantId: 'missing-tenant',
        to: '+905551112233',
        message: 'Merhaba',
      }),
    ).rejects.toThrow(
      new BadRequestException('tenant bulunamadı: missing-tenant'),
    );

    expect(whatsapp.sendProactiveWhatsApp).not.toHaveBeenCalled();
  });
});
