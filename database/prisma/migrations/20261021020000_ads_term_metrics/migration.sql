-- CreateTable
CREATE TABLE "AdsTermMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "reportJobId" TEXT,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    "level" TEXT NOT NULL,
    "externalCampaignId" TEXT,
    "campaignName" TEXT,
    "adGroupId" TEXT,
    "adGroupName" TEXT,
    "keywordId" TEXT,
    "keywordText" TEXT,
    "matchType" TEXT,
    "searchTerm" TEXT,
    "rowKey" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(20,6),
    "sales" DECIMAL(20,6),
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "raw" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsTermMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsTermMetric_tenant_date_level_idx" ON "AdsTermMetric"("tenantId", "reportDate", "level");

-- CreateIndex
CREATE INDEX "AdsTermMetric_profile_campaign_idx" ON "AdsTermMetric"("adsProfileId", "externalCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsTermMetric_dedupe_key" ON "AdsTermMetric"("adsProfileId", "reportDate", "adProduct", "level", "rowKey");

-- AddForeignKey
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_reportJobId_fkey" FOREIGN KEY ("reportJobId") REFERENCES "AdsReportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
