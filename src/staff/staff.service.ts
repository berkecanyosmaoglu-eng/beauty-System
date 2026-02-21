import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateStaffDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
    if (!tenant) throw new BadRequestException('tenantId geçersiz');

    try {
      return await this.prisma.staff.create({
        data: {
          tenant: { connect: { id: dto.tenantId } },
          fullName: dto.fullName.trim(),
          phone: dto.phone?.trim(),
          isActive: dto.isActive ?? true,
        },
      });
    } catch {
      throw new BadRequestException('Personel oluşturulamadı (aynı isim olabilir).');
    }
  }

  async findAll(tenantId?: string) {
    return this.prisma.staff.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const staff = await this.prisma.staff.findUnique({ where: { id } });
    if (!staff) throw new NotFoundException('Staff bulunamadı');
    return staff;
  }

  async update(id: string, dto: UpdateStaffDto) {
    await this.findOne(id);

    try {
      return await this.prisma.staff.update({
        where: { id },
        data: {
          ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone?.trim() } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch {
      throw new BadRequestException('Staff güncellenemedi');
    }
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.staff.delete({ where: { id } });
  }
}
