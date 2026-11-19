-- CreateTable
CREATE TABLE "throttle_hits" (
    "id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "throttle_hits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "throttle_hits_bucket_key_occurredAt_idx" ON "throttle_hits"("bucket", "key", "occurredAt");

-- CreateIndex
CREATE INDEX "throttle_hits_occurredAt_idx" ON "throttle_hits"("occurredAt");
