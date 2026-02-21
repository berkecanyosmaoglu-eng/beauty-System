import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

/**
 * NOT:
 * - /health burada
 * - /admin/whatsapp/daily burada (eğer UI kullanıyorsa)
 * - /admin/metrics burada YOK -> AdminModule (AdminController) yönetiyor.
 */

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  /**
   * Admin panelde WhatsApp günlük sayımlar (UI bunu çağırıyorsa)
   * Şimdilik Appointment tablosundaki channel alanından sayıyoruz:
   * - inbound  => customer -> bot (kanal whatsapp)
   * - outbound => bot -> customer (kanal whatsapp)
   *
   * Eğer sende gerçek message tablosu yoksa en azından yanlış "5 5 10" sabit sayıları buradan gelmiyor olur.
   */
  @Get('admin/whatsapp/daily')
  async whatsappDaily(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');

    const fromD = from ? new Date(from) : null;
    const toD = to ? new Date(to) : null;

    if (from && Number.isNaN(fromD!.getTime())) throw new BadRequestException(`from geçersiz: ${from}`);
    if (to && Number.isNaN(toD!.getTime())) throw new BadRequestException(`to geçersiz: ${to}`);

    // Eğer range verilmezse: bugün
    const start = fromD ?? new Date(new Date().setHours(0, 0, 0, 0));
    const end = toD ?? new Date(new Date().setHours(23, 59, 59, 999));

    // Appointment üstünden kanal sayımı (senin modelinde channel var diye varsayıyorum)
    // whatsappInbound/outbound ayrımı sende message tablosu yoksa birebir olmaz.
    // Şimdilik:
    const total = await this.prisma.appointment.count({
      where: {
        tenantId,
        startAt: { gte: start, lte: end },
        channel: 'WHATSAPP',
      },
    });

    return {
      ok: true,
      tenantId,
      from: start.toISOString(),
      to: end.toISOString(),
      whatsappTotal: total,
      whatsappInbound: 0,
      whatsappOutbound: 0,
    };
  }
}
