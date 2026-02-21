import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AgentModule } from '../../agent/agent.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [PrismaModule, AgentModule],
  controllers: [WhatsappController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
