import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateStaffDto {
  @IsString()
  tenantId: string;

  @IsString()
  @MinLength(2)
  fullName: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
