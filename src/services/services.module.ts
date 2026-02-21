import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
exports: [ServicesService],
  controllers: [ServicesController],
  providers: [ServicesService]
})
export class ServicesModule {}
