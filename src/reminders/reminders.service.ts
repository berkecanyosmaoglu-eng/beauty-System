import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const REMINDER_TYPE = 'REMINDER_2H';

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Her dakika çalışır. İstersen 2 dakikada 1 de yaparız.
  @Cron('*/1 * * * *')
  async run2hReminders() {
    try {
      const now = new Date();

      // 2 saat kala: [now+119dk, now+121dk] gibi küçük pencere (kaçırma olmasın)
      const from = new Date(now.getTime() + 119 * 60 * 1000);
      const to = new Date(now.getTime() + 121 * 60 * 1000);

      // Yaklaşan randevular
      const appts = await this.prisma.appointment.findMany({
        where: {
          startAt: { gte: from, lte: to },
          // sadece whatsapp kanalına gönderelim (istersen hepsine)
          // channel: 'WHATSAPP' as any,
        },
        select: {
          id: true,
          tenantId: true,
          startAt: true,
          customer: { select: { phone: true, fullName: true } } as any,
          service: { select: { name: true } } as any,
          staff: { select: { fullName: true } } as any,
        } as any,
        take: 200,
      });

      if (!appts.length) return;

      for (const a of appts as any[]) {
        const toPhone = String(a?.customer?.phone || '');
        if (!toPhone) continue;

        // daha önce attıysak atlama (unique constraint)
        const already = await this.prisma.notificationLog.findUnique({
          where: { appointmentId_type: { appointmentId: a.id, type: REMINDER_TYPE } },
          select: { id: true },
        });
        if (already) continue;

        const startText = this.prettyTr(a.startAt);
        const serviceName = String(a?.service?.name || 'randevunuz');
        const staffName = a?.staff?.fullName ? ` (${String(a.staff.fullName)})` : '';

        const msg =
          `Hatırlatma ✅\n` +
          `⏳ Randevunuza 2 saat kaldı.\n` +
          `📅 ${startText}\n` +
          `💅 ${serviceName}${staffName}\n\n` +
          `İptal/erteleme için buraya yazabilirsiniz.`;

        // ⚠️ Burada senin mevcut altyapındaki WhatsApp gönderme fonksiyonunu çağırıyoruz.
        // NotificationsService içinde isim farklıysa bana o dosyayı at, 1 dakikada uydurayım.
await (this.notifications as any).sendWhatsApp?.({
  tenantId: a.tenantId,
  to: toPhone,
  text: msg,
});

        await this.prisma.notificationLog.create({
          data: {
            tenantId: a.tenantId,
            appointmentId: a.id,
            type: REMINDER_TYPE,
            to: toPhone,
            payload: {
              startAt: a.startAt,
              service: serviceName,
            },
          },
        });
      }
    } catch (e: any) {
      this.logger.error(`[run2hReminders] ${e?.message || e}`);
    }
  }

  private prettyTr(d: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const x = new Date(d);
    // DB utc olsa bile kullanıcı TR görüyor diye +03 yazıyorsun; senin sistem zaten IST formatlı gidiyor.
    // Burayı istersen AgentService.prettyIstanbul ile de birleştiririz.
    return `${pad(x.getDate())}.${pad(x.getMonth() + 1)}.${x.getFullYear()} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
  }
}

