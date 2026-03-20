import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateCustomerDto {
  // Bazı endpoint'lerde tenantId body'den gelebiliyor, bazılarında decorator ile geliyor.
  // O yüzden optional bırakıyoruz (controller/service zaten tenantId'yi garanti etmeli).
  @IsOptional()
  @IsString()
  tenantId?: string;

  // Yeni şema alanı
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  // Legacy destek (eski client'lar fullName gönderebilir)
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  // Yeni şema alanı
  @IsOptional()
  @IsString()
  @MinLength(7)
  phoneNumber?: string;

  // Legacy destek (eski client'lar phone gönderebilir)
  @IsOptional()
  @IsString()
  @MinLength(7)
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  // Şemada notes var (sende note diye geçmiş)
  @IsOptional()
  @IsString()
  notes?: string;

  // Legacy destek
  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
