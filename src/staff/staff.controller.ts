import { Controller, Get, Post, Patch, Delete, Param, Body, Query, BadRequestException } from '@nestjs/common';
import { StaffService } from './staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Post()
  async create(@Body() dto: CreateStaffDto) {
    // create zaten dto içinden tenantId/fullName kontrol ediyor
    return this.staffService.create(dto);
  }

  @Get()
  async findAll(@Query('tenantId') tenantId?: string) {
    const tid = String(tenantId || '').trim();
    if (!tid) throw new BadRequestException('tenantId gerekli');
    return this.staffService.findAll(tid);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.staffService.findOne(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateStaffDto) {
    return this.staffService.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.staffService.remove(id);
  }
}
