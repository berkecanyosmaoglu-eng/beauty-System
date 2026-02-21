import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateServiceDto) {
    // tenant var mı kontrol (sağlamlık)
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
    if (!tenant) throw new BadRequestException('tenantId geçersiz');

    try {
      return await this.prisma.service.create({
        data: {
          // ✅ tenant relation zorunlu olduğu için connect ile bağlıyoruz
          tenant: { connect: { id: dto.tenantId } },
          name: dto.name.trim(),
          price: dto.price,
          duration: dto.duration,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (e: any) {
      throw new BadRequestException('Servis oluşturulamadı (aynı isim olabilir).');
    }
  }

  async findAll(tenantId?: string) {
    return this.prisma.service.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw new NotFoundException('Service bulunamadı');
    return service;
  }

  async update(id: string, dto: UpdateServiceDto) {
    // önce var mı
    await this.findOne(id);

    try {
      return await this.prisma.service.update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.duration !== undefined ? { duration: dto.duration } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch (e: any) {
      throw new BadRequestException('Service güncellenemedi');
    }
  }

  async remove(id: string) {
    // önce var mı
    await this.findOne(id);

    return this.prisma.service.delete({ where: { id } });
  }
}
