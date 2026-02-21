import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TenantService {
  constructor(private prisma: PrismaService) {}

  create(name: string) {
    return this.prisma.tenant.create({ data: { name } });
  }

  list() {
    return this.prisma.tenant.findMany({ orderBy: { createdAt: "desc" } });
  }
}
