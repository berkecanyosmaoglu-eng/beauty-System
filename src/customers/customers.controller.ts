import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CustomersService } from './customers.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TenantId } from './tenant.decorator';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@TenantId() tenantId: string, @Body() dto: any) {
    return this.customersService.create(tenantId, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll(@TenantId() tenantId: string) {
    return this.customersService.findAll(tenantId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.customersService.findOne(tenantId, id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.customersService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.customersService.remove(tenantId, id);
  }
}
