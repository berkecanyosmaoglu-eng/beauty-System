import { Body, Controller, Get, Post } from "@nestjs/common";
import { TenantService } from "./tenant.service";

@Controller("tenants")
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Post()
  create(@Body() body: { name: string }) {
    return this.tenantService.create(body.name);
  }

  @Get()
  list() {
    return this.tenantService.list();
  }
}
