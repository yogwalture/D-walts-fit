-- CreateEnum
CREATE TYPE "VerificationTokenType" AS ENUM ('PASSWORD_RESET', 'STAFF_INVITATION', 'EMAIL_VERIFICATION', 'MEMBER_OTP');

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL,
    "type" "VerificationTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" UUID,
    "organizationId" UUID,
    "memberId" UUID,
    "roleId" UUID,
    "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID,
    "ipAddress" TEXT,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "verification_tokens_email_type_idx" ON "verification_tokens"("email", "type");

-- CreateIndex
CREATE INDEX "verification_tokens_expiresAt_idx" ON "verification_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "verification_tokens_organizationId_type_idx" ON "verification_tokens"("organizationId", "type");
