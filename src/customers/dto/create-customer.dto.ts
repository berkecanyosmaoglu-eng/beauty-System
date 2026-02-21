import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  tenantId: string;

  @IsString()
  @MinLength(2)
  fullName: string;

  @IsString()
  @MinLength(7)
  phone: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
