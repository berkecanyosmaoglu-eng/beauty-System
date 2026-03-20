import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
