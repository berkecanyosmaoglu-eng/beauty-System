import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TENANT_ID = "cmkeas8p500056hpg59gmkquc";

const staffList = [
  { fullName: "Uzman Elif", phone: "+9055551110000" },
  { fullName: "Ayşe", phone: "+9055551110001" },
  { fullName: "Merve", phone: "+9055551110002" },
  { fullName: "Zeynep", phone: "+9055551110003" },
];

async function main() {
  for (const s of staffList) {
    const existing = await prisma.staff.findFirst({
      where: { tenantId: TENANT_ID, fullName: s.fullName },
      select: { id: true, fullName: true },
    });

    if (existing) {
      console.log("Exists:", existing.fullName, existing.id);
      continue;
    }

    const created = await prisma.staff.create({
      data: { tenantId: TENANT_ID, fullName: s.fullName, phone: s.phone, isActive: true },
      select: { id: true, fullName: true, phone: true },
    });

    console.log("Created:", created);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); }).finally(()=>prisma.$disconnect());
