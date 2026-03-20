import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateServiceDto {
  @IsString()
  tenantId: string;

  @IsString()
  name: string;

  @IsInt()
  @Min(0)
  price: number;

  @IsInt()
  @Min(1)
  duration: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
