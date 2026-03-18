import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('appointments')
  async listAppointments(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('staffId') staffId?: string,
    @Query('serviceId') serviceId?: string,
    @Query('q') q?: string,
    @Query('order') order: 'asc' | 'desc' = 'desc',
    @Query('page') page = '1',
    @Query('limit') limit = '30',
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');

    return this.admin.listAppointments({
      tenantId,
      from,
      to,
      status,
      channel,
      staffId,
      serviceId,
      q,
      order,
      page: Number(page),
      limit: Number(limit),
    });
  }

  @Get('appointments/summary')
  async appointmentsSummary(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bucket') bucket: 'day' | 'hour' = 'day',
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    return this.admin.appointmentsSummary({ tenantId, from, to, bucket });
  }

  @Get('appointments/metrics')
  async appointmentsMetrics(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    return this.admin.appointmentsMetrics({ tenantId, from, to });
  }

  @Get('metrics')
  async metrics(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    return this.admin.metrics({ tenantId, from, to });
  }

  @Get('whatsapp/series')
  async whatsappSeries(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bucket') bucket: 'day' | 'hour' = 'day',
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    return this.admin.whatsappSeries({ tenantId, from, to, bucket });
  }

  @Get('whatsapp/conversations')
  async whatsappConversations(
    @Query('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '30',
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');

    return this.admin.whatsappConversations({
      tenantId,
      from,
      to,
      q,
      page: Number(page),
      limit: Number(limit),
    });
  }

  @Get('whatsapp/messages')
  async whatsappMessages(
    @Query('tenantId') tenantId: string,
    @Query('peer') peer: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    if (!peer) throw new BadRequestException('peer gerekli');

    return this.admin.whatsappMessages({
      tenantId,
      peer,
      from,
      to,
      page: Number(page),
      limit: Number(limit),
    });
  }
  @Get('activity-feed')
  async activityFeed(
    @Query('tenantId') tenantId: string,
    @Query('limit') limit = '10',
  ) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    return this.admin.activityFeed({
      tenantId,
      limit: Number(limit),
    });
  }

  @Get('channel-performance')
  async channelPerformance(@Query('tenantId') tenantId: string) {
    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    return this.admin.channelPerformance({ tenantId });
  }

}
