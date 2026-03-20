import { IsNotEmpty, IsString } from 'class-validator';

export class SendWhatsappMessageDto {
  @IsString()
  @IsNotEmpty()
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  to!: string;

  @IsString()
  @IsNotEmpty()
  message!: string;
}
