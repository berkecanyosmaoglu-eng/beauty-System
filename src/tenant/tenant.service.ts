import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  private tenantDelegate(): any {
    const p: any = this.prisma as any;
    // Prisma'da çoğu zaman model adı singular olur: prisma.tenant
    // Ama bazı projelerde prisma.tenants / prisma.Tenant vs görülebiliyor.
    return p.tenant || p.tenants || p.Tenant || p.Tenants;
  }

  async list() {
    const del = this.tenantDelegate();
    if (!del?.findMany) {
      // burada patlıyorsa Prisma client'ta tenant modeli yok demektir
      throw new Error('Prisma tenant delegate not found (tenant/tenants).');
    }
    return del.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(name: string) {
    const del = this.tenantDelegate();
    if (!del?.create) throw new Error('Prisma tenant delegate not found (tenant/tenants).');

    const now = new Date();
    return del.create({
      data: {
        name,
        createdAt: now,
        updatedAt: now,
      } as any,
    });
  }
}
