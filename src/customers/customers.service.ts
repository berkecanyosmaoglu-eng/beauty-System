import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

function normalizePhone(input: string) {
  // basit normalize: boşluk, parantez, tire vs sil
  return input.replace(/[^\d+]/g, '').trim();
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCustomerDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
    if (!tenant) throw new BadRequestException('tenantId geçersiz');

    const phone = normalizePhone(dto.phone);

    try {
      return await this.prisma.customer.create({
        data: {
          tenant: { connect: { id: dto.tenantId } },
          fullName: dto.fullName.trim(),
          phone,
          note: dto.note?.trim(),
          isActive: dto.isActive ?? true,
        },
      });
    } catch {
      throw new BadRequestException('Müşteri oluşturulamadı (telefon bu şubede kayıtlı olabilir).');
    }
  }

  async findAll(tenantId?: string) {
    return this.prisma.customer.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer bulunamadı');
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findOne(id);

    const phone = dto.phone ? normalizePhone(dto.phone) : undefined;

    try {
      return await this.prisma.customer.update({
        where: { id },
        data: {
          ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch {
      throw new BadRequestException('Customer güncellenemedi (telefon çakışıyor olabilir).');
    }
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.customer.delete({ where: { id } });
  }
}
