-- CreateEnum
CREATE TYPE "MemberImportStatus" AS ENUM ('PARSING', 'READY', 'COMMITTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemberImportRowStatus" AS ENUM ('VALID', 'INVALID', 'DUPLICATE', 'CREATED', 'SKIPPED');

-- CreateTable
CREATE TABLE "member_imports" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "filename" TEXT NOT NULL,
    "sheetName" TEXT,
    "status" "MemberImportStatus" NOT NULL DEFAULT 'READY',
    "columnMap" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMPTZ(3),

    CONSTRAINT "member_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_import_rows" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "status" "MemberImportRowStatus" NOT NULL DEFAULT 'VALID',
    "issues" JSONB,
    "duplicateOfMemberId" UUID,
    "memberId" UUID,

    CONSTRAINT "member_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_imports_organizationId_createdAt_idx" ON "member_imports"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "member_import_rows_organizationId_importId_status_idx" ON "member_import_rows"("organizationId", "importId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "member_import_rows_importId_rowNumber_key" ON "member_import_rows"("importId", "rowNumber");

-- AddForeignKey
ALTER TABLE "member_imports" ADD CONSTRAINT "member_imports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_imports" ADD CONSTRAINT "member_imports_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_import_rows" ADD CONSTRAINT "member_import_rows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_import_rows" ADD CONSTRAINT "member_import_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "member_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
