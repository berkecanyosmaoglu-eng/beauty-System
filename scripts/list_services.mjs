import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TENANT_ID = "cmkeas8p500056hpg59gmkquc";

async function main() {
  const services = await prisma.service.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true, name: true, isActive: true, duration: true, price: true },
    orderBy: { name: "asc" },
  });
  console.log(services);
}
main().catch(console.error).finally(()=>prisma.$disconnect());
