import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TENANT_ID = "cmkeas8p500056hpg59gmkquc";

async function main() {
  const staff = await prisma.staff.findMany({
    where: { tenantId: TENANT_ID, isActive: true },
    select: { id: true, fullName: true, phone: true },
    orderBy: { fullName: "asc" },
  });
  console.log(staff);
}
main().catch(console.error).finally(()=>prisma.$disconnect());
