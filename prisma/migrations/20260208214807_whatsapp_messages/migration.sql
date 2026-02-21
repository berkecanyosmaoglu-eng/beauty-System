-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "from" TEXT,
    "to" TEXT,
    "body" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'twilio',
    "providerSid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppMessage_tenantId_createdAt_idx" ON "WhatsAppMessage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_tenantId_direction_createdAt_idx" ON "WhatsAppMessage"("tenantId", "direction", "createdAt");
