// scripts/migrate_db1_to_db2.js
const { Client } = require("pg");
const { PrismaClient } = require("@prisma/client");

const SRC = process.env.SRC_DB_URL || "postgresql://beauty:beauty_pass@localhost:5432/beauty_db";
const DST = process.env.DST_DB_URL || "postgresql://beauty:beauty_pass@localhost:5432/beauty_db2";

// küçük helper: ilk bulunan kolonu seç
function pick(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return null;
}

async function getColumns(pg, table) {
  const q = `
    select column_name
    from information_schema.columns
    where table_schema='public' and table_name=$1
    order by ordinal_position
  `;
  const r = await pg.query(q, [table]);
  return r.rows.map(x => x.column_name);
}

async function main() {
  const src = new Client({ connectionString: SRC });
  await src.connect();

  const prisma = new PrismaClient({
    datasources: { db: { url: DST } },
  });

  try {
    // 0) tenant eşleştirme: src.tenants -> dst.Tenant (name ile) yoksa dst'de ilk tenant
    const dstTenant = await prisma.tenant.findFirst();
    if (!dstTenant) throw new Error("DST (beauty_db2) içinde Tenant yok.");

    // SRC tenant'ı al
    const srcTenantRes = await src.query(`select * from tenants limit 1`);
    if (srcTenantRes.rowCount === 0) throw new Error("SRC (beauty_db) içinde tenants yok.");
    const srcTenant = srcTenantRes.rows[0];

    console.log("DST tenant:", dstTenant.id, dstTenant.name);

    // 1) SERVICES
    console.log("== migrate services ==");
    const srcServices = (await src.query(`select * from services order by id asc`)).rows;

    for (const s of srcServices) {
      const name = pick(s, ["name", "title", "service_name"]);
      const price = Number(pick(s, ["price", "amount", "fee"]) ?? 0);
      const duration = Number(pick(s, ["duration", "duration_min", "minutes"]) ?? 60);

      if (!name) continue;

      const exists = await prisma.service.findFirst({ where: { tenantId: dstTenant.id, name } });
      if (!exists) {
        await prisma.service.create({
          data: { tenantId: dstTenant.id, name, price, duration, isActive: true },
        });
        console.log("  + service:", name);
      }
    }

    // 2) STAFF
    console.log("== migrate staff ==");
    const staffCols = await getColumns(src, "staff");
    // olası isim kolonları
    const staffNameKeys = ["full_name", "fullname", "fullName", "name", "staff_name", "title"];
    const phoneKeys = ["phone", "phone_number", "mobile", "tel"];

    const srcStaff = (await src.query(`select * from staff order by id asc`)).rows;

    const dstStaffMap = new Map(); // srcStaffId -> dstStaffId

    for (const st of srcStaff) {
      const fullName = pick(st, staffNameKeys) || "Staff";
      const phone = pick(st, phoneKeys);
      const isActive = (pick(st, ["is_active", "isActive", "active"]) ?? true) !== false;

      // aynı isim varsa reuse
      let dstSt = await prisma.staff.findFirst({ where: { tenantId: dstTenant.id, fullName } });
      if (!dstSt) {
        dstSt = await prisma.staff.create({
          data: { tenantId: dstTenant.id, fullName, phone: phone ? String(phone) : null, isActive: !!isActive },
        });
        console.log("  + staff:", fullName);
      }
      dstStaffMap.set(String(st.id), dstSt.id);
    }

    // 3) CUSTOMERS
    console.log("== migrate customers ==");
    const custCols = await getColumns(src, "customers");
    const custNameKeys = ["full_name", "fullname", "fullName", "name", "customer_name", "title"];
    const custPhoneKeys = ["phone", "phone_number", "mobile", "tel"];
    const custNoteKeys = ["note", "notes", "description"];

    const srcCustomers = (await src.query(`select * from customers order by id asc`)).rows;
    const dstCustomerMap = new Map(); // srcCustomerId -> dstCustomerId

    for (const c of srcCustomers) {
      const fullName = pick(c, custNameKeys) || "Müşteri";
      const phone = pick(c, custPhoneKeys);
      if (!phone) continue;

      const note = pick(c, custNoteKeys);

      // tenant+phone unique
      let dstC = await prisma.customer.findFirst({ where: { tenantId: dstTenant.id, phone: String(phone) } });
      if (!dstC) {
        dstC = await prisma.customer.create({
          data: {
            tenantId: dstTenant.id,
            fullName,
            phone: String(phone),
            note: note ? String(note) : null,
            isActive: true,
            whatsappPhone: null,
          },
        });
        // console.log("  + customer:", fullName, phone);
      }
      dstCustomerMap.set(String(c.id), dstC.id);
    }
    console.log("  customers mapped:", dstCustomerMap.size);

    // 4) APPOINTMENTS (en azından 1 tane var sende)
    console.log("== migrate appointments ==");
    const srcAppointments = (await src.query(`select * from appointments order by id asc`)).rows;

    // service eşleştirme: name üzerinden (src->dst)
    const dstServices = await prisma.service.findMany({ where: { tenantId: dstTenant.id } });
    const dstServiceByName = new Map(dstServices.map(x => [x.name, x]));

    for (const a of srcAppointments) {
      // src tarafında alan isimleri değişebilir
      const srcCustomerId = pick(a, ["customer_id", "customerId"]);
      const srcServiceId = pick(a, ["service_id", "serviceId"]);
      const srcStaffId = pick(a, ["staff_id", "staffId"]);
      const startAt = pick(a, ["start_at", "startAt", "start"]);
      const endAt = pick(a, ["end_at", "endAt", "end"]);

      if (!srcCustomerId || !srcServiceId || !startAt || !endAt) continue;

      // src service name bul
      const srcSvcRes = await src.query(`select * from services where id=$1 limit 1`, [srcServiceId]);
      const srcSvc = srcSvcRes.rows[0];
      const svcName = srcSvc ? pick(srcSvc, ["name", "title", "service_name"]) : null;
      if (!svcName) continue;

      const dstSvc = dstServiceByName.get(svcName);
      if (!dstSvc) continue;

      const dstCustomerId = dstCustomerMap.get(String(srcCustomerId));
      if (!dstCustomerId) continue;

      const dstStaffId = srcStaffId ? (dstStaffMap.get(String(srcStaffId)) || null) : null;

      // duplicate check: tenant+staffId+startAt unique (senin schema)
      const exists = await prisma.appointment.findFirst({
        where: {
          tenantId: dstTenant.id,
          staffId: dstStaffId,
          startAt: new Date(startAt),
        },
      });
      if (exists) continue;

      await prisma.appointment.create({
        data: {
          tenantId: dstTenant.id,
          customerId: dstCustomerId,
          serviceId: dstSvc.id,
          staffId: dstStaffId,
          startAt: new Date(startAt),
          endAt: new Date(endAt),
          status: "scheduled",
          channel: "WHATSAPP",
        },
      });
      console.log("  + appointment:", svcName, String(startAt));
    }

    console.log("\nMIGRATE OK ✅");
  } finally {
    await prisma.$disconnect();
    await src.end();
  }
}

main().catch((e) => {
  console.error("MIGRATE FAILED ❌", e);
  process.exit(1);
});
