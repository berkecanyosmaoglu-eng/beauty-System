/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,staffId,startAt]` on the table `Appointment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('VOICE', 'WHATSAPP', 'SMS', 'WEB');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'BOT', 'SYSTEM');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "whatsappPhone" TEXT;

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "ownerName" TEXT,
    "ownerPhone" TEXT,
    "ownerWhatsapp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffService" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkingHours" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkingHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "customerId" TEXT,
    "externalUserId" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT,
    "contextJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "text" TEXT NOT NULL,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Business_tenantId_key" ON "Business"("tenantId");

-- CreateIndex
CREATE INDEX "Business_tenantId_idx" ON "Business"("tenantId");

-- CreateIndex
CREATE INDEX "StaffService_tenantId_idx" ON "StaffService"("tenantId");

-- CreateIndex
CREATE INDEX "StaffService_tenantId_staffId_idx" ON "StaffService"("tenantId", "staffId");

-- CreateIndex
CREATE INDEX "StaffService_tenantId_serviceId_idx" ON "StaffService"("tenantId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffService_tenantId_staffId_serviceId_key" ON "StaffService"("tenantId", "staffId", "serviceId");

-- CreateIndex
CREATE INDEX "WorkingHours_tenantId_staffId_idx" ON "WorkingHours"("tenantId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkingHours_tenantId_staffId_dayOfWeek_startMin_endMin_key" ON "WorkingHours"("tenantId", "staffId", "dayOfWeek", "startMin", "endMin");

-- CreateIndex
CREATE INDEX "TimeOff_tenantId_staffId_startAt_idx" ON "TimeOff"("tenantId", "staffId", "startAt");

-- CreateIndex
CREATE INDEX "BotConversation_tenantId_channel_isOpen_idx" ON "BotConversation"("tenantId", "channel", "isOpen");

-- CreateIndex
CREATE INDEX "BotConversation_tenantId_externalUserId_idx" ON "BotConversation"("tenantId", "externalUserId");

-- CreateIndex
CREATE INDEX "BotMessage_tenantId_conversationId_createdAt_idx" ON "BotMessage"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_staffId_startAt_key" ON "Appointment"("tenantId", "staffId", "startAt");

-- CreateIndex
CREATE INDEX "Customer_tenantId_whatsappPhone_idx" ON "Customer"("tenantId", "whatsappPhone");

-- AddForeignKey
ALTER TABLE "Business" ADD CONSTRAINT "Business_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
