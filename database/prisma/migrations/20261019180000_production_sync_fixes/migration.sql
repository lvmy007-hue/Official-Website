ALTER TABLE "Order" ADD COLUMN "piiCiphertext" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "piiExpiresAt" TIMESTAMP(3);
CREATE INDEX "Order_piiExpiresAt_idx" ON "Order"("piiExpiresAt");

ALTER TABLE "SyncJob" ADD COLUMN "context" JSONB;
