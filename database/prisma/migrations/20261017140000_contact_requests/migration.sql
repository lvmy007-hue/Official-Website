CREATE TABLE "ContactRequest" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContactRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContactRequest_createdAt_idx" ON "ContactRequest"("createdAt");
CREATE INDEX "ContactRequest_status_createdAt_idx" ON "ContactRequest"("status", "createdAt");
