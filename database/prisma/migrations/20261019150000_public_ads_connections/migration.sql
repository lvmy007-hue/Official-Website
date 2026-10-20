DROP INDEX IF EXISTS "SellerAccount_provider_sellerId_logicalRegion_key";
CREATE UNIQUE INDEX "SellerAccount_tenantId_provider_sellerId_logicalRegion_key" ON "SellerAccount"("tenantId", "provider", "sellerId", "logicalRegion");

ALTER TABLE "PlatformConnection" ADD COLUMN "adsProfileId" TEXT;

CREATE TABLE "AdsProfile" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "accountId" TEXT,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "countryCode" TEXT NOT NULL DEFAULT 'US',
  "currencyCode" TEXT NOT NULL DEFAULT 'USD',
  "timezone" TEXT,
  "displayName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdsCampaign" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "externalCampaignId" TEXT NOT NULL,
  "adProduct" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "budget" DECIMAL(20,6),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdsReportJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "reportType" TEXT NOT NULL,
  "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "externalReportId" TEXT,
  "downloadUrl" TEXT,
  "fromDate" TIMESTAMP(3),
  "toDate" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsReportJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdsProfile_tenantId_profileId_key" ON "AdsProfile"("tenantId", "profileId");
CREATE INDEX "AdsProfile_tenantId_marketplaceId_status_idx" ON "AdsProfile"("tenantId", "marketplaceId", "status");
CREATE UNIQUE INDEX "AdsCampaign_adsProfileId_externalCampaignId_adProduct_key" ON "AdsCampaign"("adsProfileId", "externalCampaignId", "adProduct");
CREATE INDEX "AdsCampaign_tenantId_state_sourceUpdatedAt_idx" ON "AdsCampaign"("tenantId", "state", "sourceUpdatedAt");
CREATE INDEX "AdsReportJob_tenantId_status_createdAt_idx" ON "AdsReportJob"("tenantId", "status", "createdAt");
CREATE INDEX "AdsReportJob_adsProfileId_reportType_idx" ON "AdsReportJob"("adsProfileId", "reportType");
CREATE INDEX "PlatformConnection_tenantId_adsProfileId_idx" ON "PlatformConnection"("tenantId", "adsProfileId");

ALTER TABLE "PlatformConnection" ADD CONSTRAINT "PlatformConnection_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdsProfile" ADD CONSTRAINT "AdsProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsCampaign" ADD CONSTRAINT "AdsCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsCampaign" ADD CONSTRAINT "AdsCampaign_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaInboundPlan" ADD COLUMN "items" JSONB;
ALTER TABLE "FbaFeeEvent" ADD COLUMN "sourceEventId" TEXT;
CREATE UNIQUE INDEX "FbaFeeEvent_sellerAccountId_sourceEventId_key" ON "FbaFeeEvent"("sellerAccountId", "sourceEventId");