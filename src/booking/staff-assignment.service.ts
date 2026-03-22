import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type StaffAssignmentResult =
  | { ok: true; staffId: string }
  | { ok: false; code: 'NO_STAFF_AVAILABLE' | 'STAFF_CONFIGURATION_REQUIRED' };

@Injectable()
export class StaffAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveStaffId(tenantId: string): Promise<StaffAssignmentResult> {
    const activeStaff = await this.prisma.staff.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (activeStaff.length === 0) {
      return { ok: false, code: 'NO_STAFF_AVAILABLE' };
    }

    const configuredDefaultId = this.getConfiguredDefaultStaffId(tenantId);
    if (configuredDefaultId) {
      const match = activeStaff.find((staff) => staff.id === configuredDefaultId);
      if (match) {
        return { ok: true, staffId: match.id };
      }
    }

    if (activeStaff.length === 1) {
      return { ok: true, staffId: activeStaff[0].id };
    }

    return { ok: true, staffId: activeStaff[0].id };
  }

  private getConfiguredDefaultStaffId(tenantId: string): string | null {
    const raw = String(process.env.BOOKING_DEFAULT_STAFF_BY_TENANT || '').trim();
    if (!raw) {
      return null;
    }

    const mapping = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [tenant, staffId] = entry.split(':').map((value) => value.trim());
        return { tenant, staffId };
      })
      .find((entry) => entry.tenant === tenantId && entry.staffId);

    return mapping?.staffId || null;
  }
}
