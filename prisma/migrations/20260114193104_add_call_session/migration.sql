-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "callSid" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'SERVICE',
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallSession_tenantId_phone_idx" ON "CallSession"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_tenantId_callSid_key" ON "CallSession"("tenantId", "callSid");
