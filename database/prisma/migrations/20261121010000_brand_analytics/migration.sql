-- M-P4-04 品牌分析。
-- 依据：freeze/models.md M-P4-04（BrandSearchQueryPerformance、BrandSearchCatalogPerformance、BrandSearchTerm、BrandMarketBasket、BrandRepeatPurchase）；
--   freeze/importers.md R-35 至 R-39；04 章 4.7；14 章 P4-04。
--
-- 内容：五张不分区的租户表（品牌分析按周、月、季发布，数据量按“周期 × ASIN × 搜索词”计，热门搜索词只导入排名靠前的词），
--   外加检查约束、行级安全与授权（与其他租户表一致）。
-- 与冻结的出入（见 CR-079）：
--   一、reportPeriod 取值 WEEK / MONTH / QUARTER，另存 periodEnd（周期最后一天），导入时由起止日是否对齐校验；
--   二、BrandSearchTerm 的唯一键是 (店铺, 周期种类, 周期起始日, 部门, 搜索词)，不含搜索频率排名（排名是值，同一个词在不同部门的排名不同）；
--      官方每行是“词 × 点击份额排名 1 到 3 的 ASIN”，导入时按排名合并进同一行的三组列（clickedAsin1..3 等）；
--   三、BrandSearchQueryPerformance 按“次数 + 官方份额”存（总量与我方两套次数列，份额页面按次数重算）；价格中位数与配送速度只存购买阶段。
-- 比率与份额列存 0 到 1 的小数；官方没给的值存空，不是 0。
--
-- 回滚方法：见同目录 rollback.sql（删五张表；都是从亚马逊重新申请的报告数据，回滚后下一次定时任务会重新申请最近一个周期，
--   更早的周期需要在亚马逊保留期内手工重新申请报告）。

CREATE TABLE "BrandSearchQueryPerformance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "reportPeriod" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "asin" TEXT NOT NULL,
  "searchQuery" TEXT NOT NULL,
  "searchQueryScore" INTEGER,
  "searchVolume" INTEGER,
  "impressionsTotal" INTEGER,
  "impressionsOwn" INTEGER,
  "impressionShare" DECIMAL(12,6),
  "clicksTotal" INTEGER,
  "clicksOwn" INTEGER,
  "clickShare" DECIMAL(12,6),
  "cartAddsTotal" INTEGER,
  "cartAddsOwn" INTEGER,
  "cartAddShare" DECIMAL(12,6),
  "purchasesTotal" INTEGER,
  "purchasesOwn" INTEGER,
  "purchaseShare" DECIMAL(12,6),
  "clickPriceTotal" DECIMAL(14,4),
  "clickPriceOwn" DECIMAL(14,4),
  "cartAddPriceTotal" DECIMAL(14,4),
  "cartAddPriceOwn" DECIMAL(14,4),
  "purchasePriceTotal" DECIMAL(14,4),
  "purchasePriceOwn" DECIMAL(14,4),
  "currency" TEXT,
  "purchasesSameDayTotal" INTEGER,
  "purchasesSameDayOwn" INTEGER,
  "purchasesOneDayTotal" INTEGER,
  "purchasesOneDayOwn" INTEGER,
  "purchasesTwoDayTotal" INTEGER,
  "purchasesTwoDayOwn" INTEGER,
  "sourceReportJobId" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandSearchQueryPerformance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandSqp_uq" ON "BrandSearchQueryPerformance"("tenantId", "sellerAccountId", "reportPeriod", "periodStart", "asin", "searchQuery");
CREATE INDEX "BrandSqp_period_idx" ON "BrandSearchQueryPerformance"("tenantId", "reportPeriod", "periodStart");
CREATE INDEX "BrandSqp_store_idx" ON "BrandSearchQueryPerformance"("sellerAccountId");

CREATE TABLE "BrandSearchCatalogPerformance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "reportPeriod" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "asin" TEXT NOT NULL,
  "impressions" INTEGER,
  "clicks" INTEGER,
  "cartAdds" INTEGER,
  "purchases" INTEGER,
  "clickRate" DECIMAL(12,6),
  "conversionRate" DECIMAL(12,6),
  "searchTrafficSales" DECIMAL(20,6),
  "impressionMedianPrice" DECIMAL(14,4),
  "clickMedianPrice" DECIMAL(14,4),
  "cartAddMedianPrice" DECIMAL(14,4),
  "purchaseMedianPrice" DECIMAL(14,4),
  "currency" TEXT,
  "sourceReportJobId" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandSearchCatalogPerformance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandCatalog_uq" ON "BrandSearchCatalogPerformance"("tenantId", "sellerAccountId", "reportPeriod", "periodStart", "asin");
CREATE INDEX "BrandCatalog_period_idx" ON "BrandSearchCatalogPerformance"("tenantId", "reportPeriod", "periodStart");
CREATE INDEX "BrandCatalog_store_idx" ON "BrandSearchCatalogPerformance"("sellerAccountId");

CREATE TABLE "BrandSearchTerm" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "reportPeriod" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "department" TEXT NOT NULL DEFAULT '',
  "searchTerm" TEXT NOT NULL,
  "searchFrequencyRank" INTEGER,
  "clickedAsin1" TEXT,
  "clickedTitle1" TEXT,
  "clickShare1" DECIMAL(12,6),
  "conversionShare1" DECIMAL(12,6),
  "clickedAsin2" TEXT,
  "clickedTitle2" TEXT,
  "clickShare2" DECIMAL(12,6),
  "conversionShare2" DECIMAL(12,6),
  "clickedAsin3" TEXT,
  "clickedTitle3" TEXT,
  "clickShare3" DECIMAL(12,6),
  "conversionShare3" DECIMAL(12,6),
  "sourceReportJobId" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandSearchTerm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandTerm_uq" ON "BrandSearchTerm"("tenantId", "sellerAccountId", "reportPeriod", "periodStart", "department", "searchTerm");
CREATE INDEX "BrandTerm_rank_idx" ON "BrandSearchTerm"("tenantId", "sellerAccountId", "reportPeriod", "periodStart", "searchFrequencyRank");
CREATE INDEX "BrandTerm_store_idx" ON "BrandSearchTerm"("sellerAccountId");

CREATE TABLE "BrandMarketBasket" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "reportPeriod" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "asin" TEXT NOT NULL,
  "pairedAsin" TEXT NOT NULL,
  "combinationPct" DECIMAL(12,6),
  "purchaseRank" INTEGER,
  "sourceReportJobId" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandMarketBasket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandBasket_uq" ON "BrandMarketBasket"("tenantId", "sellerAccountId", "reportPeriod", "periodStart", "asin", "pairedAsin");
CREATE INDEX "BrandBasket_period_idx" ON "BrandMarketBasket"("tenantId", "reportPeriod", "periodStart");
CREATE INDEX "BrandBasket_store_idx" ON "BrandMarketBasket"("sellerAccountId");

CREATE TABLE "BrandRepeatPurchase" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "reportPeriod" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "asin" TEXT NOT NULL,
  "orders" INTEGER,
  "uniqueCustomers" INTEGER,
  "repeatCustomersPct" DECIMAL(12,6),
  "repeatRevenue" DECIMAL(20,6),
  "repeatRevenuePct" DECIMAL(12,6),
  "currency" TEXT,
  "sourceReportJobId" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandRepeatPurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrandRepeat_uq" ON "BrandRepeatPurchase"("tenantId", "sellerAccountId", "reportPeriod", "periodStart", "asin");
CREATE INDEX "BrandRepeat_period_idx" ON "BrandRepeatPurchase"("tenantId", "reportPeriod", "periodStart");
CREATE INDEX "BrandRepeat_store_idx" ON "BrandRepeatPurchase"("sellerAccountId");

-- 外键
ALTER TABLE "BrandSearchQueryPerformance" ADD CONSTRAINT "BrandSearchQueryPerformance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandSearchQueryPerformance" ADD CONSTRAINT "BrandSearchQueryPerformance_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandSearchCatalogPerformance" ADD CONSTRAINT "BrandSearchCatalogPerformance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandSearchCatalogPerformance" ADD CONSTRAINT "BrandSearchCatalogPerformance_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandSearchTerm" ADD CONSTRAINT "BrandSearchTerm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandSearchTerm" ADD CONSTRAINT "BrandSearchTerm_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandMarketBasket" ADD CONSTRAINT "BrandMarketBasket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandMarketBasket" ADD CONSTRAINT "BrandMarketBasket_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandRepeatPurchase" ADD CONSTRAINT "BrandRepeatPurchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandRepeatPurchase" ADD CONSTRAINT "BrandRepeatPurchase_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：周期种类、结束日不早于起始日（周、月、季是否对齐由导入器校验）、数量非负、份额与比率在 0 到 1 之间
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['BrandSearchQueryPerformance', 'BrandSearchCatalogPerformance', 'BrandSearchTerm', 'BrandMarketBasket', 'BrandRepeatPurchase'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("reportPeriod" IN (''WEEK'', ''MONTH'', ''QUARTER''))', tbl, tbl || '_period_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("periodEnd" >= "periodStart")', tbl, tbl || '_range_check');
  END LOOP;
END $$;

ALTER TABLE "BrandSearchQueryPerformance" ADD CONSTRAINT "BrandSearchQueryPerformance_value_check" CHECK (
  COALESCE("searchQueryScore", 0) >= 0 AND COALESCE("searchVolume", 0) >= 0
  AND COALESCE("impressionsTotal", 0) >= 0 AND COALESCE("impressionsOwn", 0) >= 0 AND COALESCE("clicksTotal", 0) >= 0 AND COALESCE("clicksOwn", 0) >= 0
  AND COALESCE("cartAddsTotal", 0) >= 0 AND COALESCE("cartAddsOwn", 0) >= 0 AND COALESCE("purchasesTotal", 0) >= 0 AND COALESCE("purchasesOwn", 0) >= 0
  AND COALESCE("purchasesSameDayTotal", 0) >= 0 AND COALESCE("purchasesSameDayOwn", 0) >= 0 AND COALESCE("purchasesOneDayTotal", 0) >= 0
  AND COALESCE("purchasesOneDayOwn", 0) >= 0 AND COALESCE("purchasesTwoDayTotal", 0) >= 0 AND COALESCE("purchasesTwoDayOwn", 0) >= 0
  AND COALESCE("impressionShare", 0) BETWEEN 0 AND 1 AND COALESCE("clickShare", 0) BETWEEN 0 AND 1
  AND COALESCE("cartAddShare", 0) BETWEEN 0 AND 1 AND COALESCE("purchaseShare", 0) BETWEEN 0 AND 1
);
ALTER TABLE "BrandSearchCatalogPerformance" ADD CONSTRAINT "BrandSearchCatalogPerformance_value_check" CHECK (
  COALESCE("impressions", 0) >= 0 AND COALESCE("clicks", 0) >= 0 AND COALESCE("cartAdds", 0) >= 0 AND COALESCE("purchases", 0) >= 0
  AND COALESCE("clickRate", 0) BETWEEN 0 AND 1 AND COALESCE("conversionRate", 0) BETWEEN 0 AND 1
);
ALTER TABLE "BrandSearchTerm" ADD CONSTRAINT "BrandSearchTerm_value_check" CHECK (
  COALESCE("searchFrequencyRank", 1) >= 1
  AND COALESCE("clickShare1", 0) BETWEEN 0 AND 1 AND COALESCE("conversionShare1", 0) BETWEEN 0 AND 1
  AND COALESCE("clickShare2", 0) BETWEEN 0 AND 1 AND COALESCE("conversionShare2", 0) BETWEEN 0 AND 1
  AND COALESCE("clickShare3", 0) BETWEEN 0 AND 1 AND COALESCE("conversionShare3", 0) BETWEEN 0 AND 1
);
ALTER TABLE "BrandMarketBasket" ADD CONSTRAINT "BrandMarketBasket_value_check" CHECK (COALESCE("combinationPct", 0) BETWEEN 0 AND 1 AND COALESCE("purchaseRank", 1) >= 1);
ALTER TABLE "BrandRepeatPurchase" ADD CONSTRAINT "BrandRepeatPurchase_value_check" CHECK (
  COALESCE("orders", 0) >= 0 AND COALESCE("uniqueCustomers", 0) >= 0 AND COALESCE("repeatRevenue", 0) >= 0
  AND COALESCE("repeatCustomersPct", 0) BETWEEN 0 AND 1 AND COALESCE("repeatRevenuePct", 0) BETWEEN 0 AND 1
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['BrandSearchQueryPerformance', 'BrandSearchCatalogPerformance', 'BrandSearchTerm', 'BrandMarketBasket', 'BrandRepeatPurchase'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', tbl);
    END IF;
  END LOOP;
END $$;
