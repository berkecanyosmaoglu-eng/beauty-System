import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingCoreService } from './booking-core.service';
import { StaffAssignmentService } from './staff-assignment.service';
import { BookingOrchestratorService } from './booking-orchestrator.service';

@Module({
  imports: [PrismaModule],
  providers: [
    StaffAssignmentService,
    BookingCoreService,
    BookingOrchestratorService,
  ],
  exports: [
    StaffAssignmentService,
    BookingCoreService,
    BookingOrchestratorService,
  ],
})
export class BookingModule {}
