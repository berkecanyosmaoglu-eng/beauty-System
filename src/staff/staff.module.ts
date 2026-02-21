import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
exports: [StaffService],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
