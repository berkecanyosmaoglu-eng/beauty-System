import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TENANT_ID = "cmkeas8p500056hpg59gmkquc";

async function main() {
  const total = await prisma.appointment.count({ where: { tenantId: TENANT_ID } });

  // staff relation filtresi bazı şemalarda çalışmayabilir. O yüzden 2 aşamalı:
  const withStaff = await prisma.appointment.findMany({
    where: { tenantId: TENANT_ID, staffId: { not: null } },
    select: { id: true, staffId: true, startAt: true },
    take: 5000,
  });

  const staffIds = [...new Set(withStaff.map(a => a.staffId).filter(Boolean))];

  const staffs = await prisma.staff.findMany({
    where: { tenantId: TENANT_ID, id: { in: staffIds } },
    select: { id: true, fullName: true },
  });

  const staffSet = new Set(staffs.map(s => s.id));
  const orphans = withStaff.filter(a => a.staffId && !staffSet.has(a.staffId));

  console.log("Total appointments:", total);
  console.log("Appointments with staffId:", withStaff.length);
  console.log("Orphan staffId appointments:", orphans.length);
  console.log("Sample orphans:", orphans.slice(0, 10));
}

main().catch(e=>{ console.error(e); process.exit(1); }).finally(()=>prisma.$disconnect());
