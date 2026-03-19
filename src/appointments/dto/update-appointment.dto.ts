import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { AppointmentStatus, SessionChannel } from '@prisma/client';

export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;
  @IsOptional()
  @IsEnum(SessionChannel)
  channel?: SessionChannel;

  @IsOptional()
  @IsString()
  messageSessionId?: string;

  @IsOptional()
  @IsString()
  callSessionId?: string;

}
