const { PrismaClient } = require('@prisma/client');
const { DateTime } = require('luxon');
const crypto = require('crypto');

const prisma = new PrismaClient();
const tenantId = process.env.DEFAULT_TENANT_ID || 'cmkeas8p500056hpg59gmkquc';

(async () => {
  const ZONE = 'Europe/Istanbul';
  const nowTr = DateTime.now().setZone(ZONE);

  // 2 saat öncesi reminder test: randevuyu şimdi + ADD_MIN dk'ya kur
  const ADD_MIN = Number(process.env.ADD_MIN || 121); // 121 bırak, window'a daha rahat girer
  const targetTr = nowTr.plus({ minutes: ADD_MIN });

  // ✅ kritik fix: date, targetTr'nin GÜN BAŞLANGICI olmalı (nowTr'nin değil!)
  const dayStartTr = targetTr.startOf('day');
  const dateUtcJs = new Date(dayStartTr.toUTC().toISO());
  const timeTr = targetTr.toFormat('HH:mm');

  const staff = await prisma.staff.findFirst({
    where: { tenantId, isActive: true },
    select: { id: true, name: true },
  });

  const service = await prisma.services.findFirst({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, duration: true },
  });

  if (!staff) throw new Error('Aktif staff yok');
  if (!service) throw new Error('Aktif service yok');

  // kendi numaran (DB’de nasıl tutuyorsan öyle)
  const phoneNumber = process.env.TEST_PHONE || '905323698805';

  const nowUtcJs = new Date();

  // customer (id + timestamps zorunlu görünüyor sende)
  const customer = await prisma.customers.upsert({
    where: { tenantId_phoneNumber: { tenantId, phoneNumber } },
    update: { updatedAt: nowUtcJs },
    create: {
      id: crypto.randomUUID(),
      tenantId,
      phoneNumber,
      name: 'Test Müşteri',
      createdAt: nowUtcJs,
      updatedAt: nowUtcJs,
    },
    select: { id: true, phoneNumber: true, name: true },
  });

  const appt = await prisma.appointments.create({
    data: {
      id: crypto.randomUUID(),
      tenantId,
      staffId: staff.id,
      serviceId: service.id,
      customerId: customer.id,
      date: dateUtcJs,
      time: timeTr,
      status: 'CONFIRMED',
      // bazı şemalarda zorunlu olabiliyor:
      createdAt: nowUtcJs,
      updatedAt: nowUtcJs,
    },
    select: { id: true, date: true, time: true, tenantId: true, staffId: true, serviceId: true },
  });

  console.log('Created customer:', customer);
  console.log('Created appt:', appt);
  console.log('nowTr:', nowTr.toFormat('yyyy-LL-dd HH:mm'));
  console.log('TR target:', targetTr.toFormat('yyyy-LL-dd HH:mm'));
  console.log('TR date(dayStart):', dayStartTr.toFormat('yyyy-LL-dd'));
  console.log('staff:', staff.name, 'service:', service.name);
})().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
