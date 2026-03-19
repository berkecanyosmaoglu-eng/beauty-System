import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingCoreService } from './booking-core.service';
import { StaffAssignmentService } from './staff-assignment.service';

@Module({
  imports: [PrismaModule],
  providers: [StaffAssignmentService, BookingCoreService],
  exports: [StaffAssignmentService, BookingCoreService],
})
export class BookingModule {}
