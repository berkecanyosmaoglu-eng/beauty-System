import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Post()
  create(@Body() dto: CreateAppointmentDto) {
    return this.appointmentsService.create(dto);
  }

  @Get()
  findAll(
    @Query('tenantId') tenantId?: string,
    @Query('date') date?: string,
    @Query('status') status?: string,
    @Query('today') today?: string,
  ) {
    const todayBool = today === 'true' || today === '1';
    return this.appointmentsService.findAll(tenantId, date, status, todayBool);
  }

  // ✅ NEW: This endpoint supports "slot check + suggestions"
  // Query params:
  // tenantId, staffId, serviceId, from(optional), step(optional), maxDays(optional)
  @Get('next-available')
  nextAvailable(
    @Query('tenantId') tenantId: string,
    @Query('staffId') staffId: string,
    @Query('serviceId') serviceId: string,
    @Query('from') from?: string,
    @Query('step') step?: string,
    @Query('maxDays') maxDays?: string,
  ) {
    const desiredStart = from ? new Date(String(from)) : new Date();

    const stepMinutes = step ? Number(step) : 15;
    const days = maxDays ? Number(maxDays) : 1;

    return this.appointmentsService.nextAvailable({
      tenantId,
      staffId,
      serviceId,
      desiredStart,
      stepMinutes: Number.isFinite(stepMinutes) ? stepMinutes : 15,
      searchHours: Number.isFinite(days) ? days * 24 : 24,
      suggestions: 5,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.appointmentsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAppointmentDto) {
    return this.appointmentsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.appointmentsService.remove(id);
  }
}
