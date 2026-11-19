-- CreateEnum
CREATE TYPE "PaymentGatewayProvider" AS ENUM ('RAZORPAY');

-- CreateTable
CREATE TABLE "payment_gateway_settings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" "PaymentGatewayProvider" NOT NULL DEFAULT 'RAZORPAY',
    "keyId" TEXT,
    "keySecretEncrypted" TEXT,
    "webhookSecretEncrypted" TEXT,
    "webhookId" TEXT NOT NULL,
    "isLiveMode" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_gateway_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_settings_organizationId_key" ON "payment_gateway_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_settings_webhookId_key" ON "payment_gateway_settings"("webhookId");

-- CreateIndex
CREATE INDEX "payment_gateway_settings_organizationId_isEnabled_idx" ON "payment_gateway_settings"("organizationId", "isEnabled");

-- AddForeignKey
ALTER TABLE "payment_gateway_settings" ADD CONSTRAINT "payment_gateway_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
