import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { AppointmentStatus, SessionChannel } from '@prisma/client';

export class CreateAppointmentDto {
  @IsString()
  tenantId: string;

  @IsString()
  customerId: string;

  @IsString()
  serviceId: string;

  @IsOptional()
  @IsString()
  staffId?: string;


  @IsDateString()
  startAt: string;

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

