import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizePhone(input: string): string {
    const s = String(input || '').trim();
    // sadece rakamları al
    const digits = s.replace(/[^\d]/g, '');
    if (!digits) return '';
    // +90 / 90 / 0 prefixlerini normalize et
    if (digits.startsWith('90')) return `+${digits}`;
    if (digits.startsWith('0')) return `+9${digits}`; // 0XXXXXXXXXX -> +90XXXXXXXXXX
    if (digits.startsWith('5') && digits.length === 10) return `+90${digits}`; // 5XXXXXXXXX -> +90...
    // fallback
    return digits.startsWith('+') ? digits : `+${digits}`;
  }

  private pickName(dto: any): string {
    // API DTO: fullName, DB field: name
    const fullName = String(dto?.fullName || '').trim();
    const name = String(dto?.name || '').trim();
    return fullName || name || '';
  }

  private pickPhoneNumber(dto: any): string {
    // API DTO: phone, DB field: phoneNumber
    const phone = String(dto?.phone || '').trim();
    const phoneNumber = String(dto?.phoneNumber || '').trim();
    return this.normalizePhone(phoneNumber || phone);
  }

  async create(tenantId: string, dto: any) {
    const t = String(tenantId || '').trim();
    if (!t) throw new BadRequestException('tenantId gerekli');

    const name = this.pickName(dto);
    const phoneNumber = this.pickPhoneNumber(dto);

    if (!name) throw new BadRequestException('fullName gerekli');
    if (!phoneNumber) throw new BadRequestException('phone gerekli');

    const email = dto?.email ? String(dto.email).trim() : undefined;
    const notes = dto?.note ? String(dto.note).trim() : dto?.notes ? String(dto.notes).trim() : undefined;
    const isActive =
      dto?.isActive === undefined ? undefined : Boolean(dto.isActive);

    // ⚠️ Senin DB’de customers.id ve updatedAt zorunlu görünüyor
    // o yüzden create data içine ekliyoruz
    const now = new Date();
    const id = crypto.randomUUID();

    try {
      return await this.prisma.customers.create({
        data: {
          id,
          tenantId: t,
          name,
          phoneNumber,
          ...(email ? { email } : {}),
          ...(notes ? { notes } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
          // bazı şemalarda required olabiliyor
          ...(true ? { createdAt: now, updatedAt: now } : {}),
        } as any,
      });
    } catch (e: any) {
      // unique: tenantId+phoneNumber çakışırsa
      throw new BadRequestException(
        `Customer oluşturulamadı (telefon çakışıyor olabilir). ${e?.message || e}`,
      );
    }
  }

  async findAll(tenantId: string) {
    const t = String(tenantId || '').trim();
    if (!t) throw new BadRequestException('tenantId gerekli');

    return this.prisma.customers.findMany({
      where: { tenantId: t },
      orderBy: { createdAt: 'desc' } as any,
      take: 500,
    });
  }

  async findOne(tenantId: string, id: string) {
    const t = String(tenantId || '').trim();
    const cid = String(id || '').trim();
    if (!t) throw new BadRequestException('tenantId gerekli');
    if (!cid) throw new BadRequestException('id gerekli');

    const customer = await this.prisma.customers.findFirst({
      where: { tenantId: t, id: cid },
    });

    if (!customer) throw new NotFoundException('Customer bulunamadı');
    return customer;
  }

  async update(tenantId: string, id: string, dto: any) {
    const t = String(tenantId || '').trim();
    const cid = String(id || '').trim();
    if (!t) throw new BadRequestException('tenantId gerekli');
    if (!cid) throw new BadRequestException('id gerekli');

    await this.findOne(t, cid);

    const patch: any = {};
    const name = this.pickName(dto);
    const phoneNumber = this.pickPhoneNumber(dto);
    const email = dto?.email !== undefined ? String(dto.email || '').trim() : undefined;
    const notes =
      dto?.note !== undefined
        ? String(dto.note || '').trim()
        : dto?.notes !== undefined
          ? String(dto.notes || '').trim()
          : undefined;

    if (dto?.fullName !== undefined || dto?.name !== undefined) patch.name = name;
    if (dto?.phone !== undefined || dto?.phoneNumber !== undefined) patch.phoneNumber = phoneNumber;
    if (dto?.isActive !== undefined) patch.isActive = Boolean(dto.isActive);
    if (dto?.email !== undefined) patch.email = email || null;
    if (dto?.note !== undefined || dto?.notes !== undefined) patch.notes = notes || null;

    patch.updatedAt = new Date();

    try {
      return await this.prisma.customers.update({
        where: { id: cid } as any,
        data: patch,
      });
    } catch (e: any) {
      throw new BadRequestException(
        `Customer güncellenemedi (telefon çakışıyor olabilir). ${e?.message || e}`,
      );
    }
  }

  async remove(tenantId: string, id: string) {
    const t = String(tenantId || '').trim();
    const cid = String(id || '').trim();
    if (!t) throw new BadRequestException('tenantId gerekli');
    if (!cid) throw new BadRequestException('id gerekli');

    await this.findOne(t, cid);

    return this.prisma.customers.delete({
      where: { id: cid } as any,
    });
  }
}
