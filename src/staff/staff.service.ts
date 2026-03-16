import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateStaffDto) {
    const tenantId = String((dto as any).tenantId || '').trim();
    const fullName = String((dto as any).fullName || '').trim();
    const phone = (dto as any).phone ? String((dto as any).phone).trim() : null;

    if (!tenantId) throw new BadRequestException('tenantId gerekli');
    if (!fullName) throw new BadRequestException('fullName gerekli');

    // tenant var mı? (DB1 delegate: tenants)
    const tenant = await this.prisma.tenants.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant bulunamadı');

    // DB1 legacy: staff input alanları birebir uyuşmayabilir (fullName vs name vs full_name)
    // O yüzden "as any" ile güvenli basıyoruz.
    const created = await this.prisma.staff.create({
      data: {
        tenantId,
        fullName, // legacy DB'de farklı isimli olabilir ama Prisma modelin bunu map'liyorsa çalışır
        phone,
        isActive: true,
      } as any,
    });

    return created;
  }

  async findAll(tenantId: string) {
    const tid = String(tenantId || '').trim();
    if (!tid) throw new BadRequestException('tenantId gerekli');

    return this.prisma.staff.findMany({
      where: { tenantId: tid } as any,
      orderBy: { createdAt: 'desc' } as any,
    });
  }

  async findOne(id: string) {
    const staff = await this.prisma.staff.findUnique({ where: { id } as any });
    if (!staff) throw new NotFoundException('Staff bulunamadı');
    return staff;
  }

  async update(id: string, dto: UpdateStaffDto) {
    const existing = await this.prisma.staff.findUnique({ where: { id } as any });
    if (!existing) throw new NotFoundException('Staff bulunamadı');

    const patch: any = {};
    if ((dto as any).fullName !== undefined) patch.fullName = String((dto as any).fullName || '').trim();
    if ((dto as any).phone !== undefined) patch.phone = (dto as any).phone ? String((dto as any).phone).trim() : null;
    if ((dto as any).isActive !== undefined) patch.isActive = Boolean((dto as any).isActive);

    return this.prisma.staff.update({
      where: { id } as any,
      data: patch,
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.staff.findUnique({ where: { id } as any });
    if (!existing) throw new NotFoundException('Staff bulunamadı');

    return this.prisma.staff.delete({ where: { id } as any });
  }
}
