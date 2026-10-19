CREATE TABLE "FbaReportJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "reportType" TEXT NOT NULL,
  "fromDate" TIMESTAMP(3),
  "toDate" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "externalReportId" TEXT,
  "documentId" TEXT,
  "downloadUrl" TEXT,
  "expiresAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "requestId" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaReportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FbaReportJob_tenantId_createdAt_idx" ON "FbaReportJob"("tenantId", "createdAt");
CREATE INDEX "FbaReportJob_tenantId_status_idx" ON "FbaReportJob"("tenantId", "status");
CREATE INDEX "FbaReportJob_sellerAccountId_reportType_idx" ON "FbaReportJob"("sellerAccountId", "reportType");

ALTER TABLE "FbaReportJob" ADD CONSTRAINT "FbaReportJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaReportJob" ADD CONSTRAINT "FbaReportJob_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FbaReportJob" ADD CONSTRAINT "FbaReportJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
