-- M-P2a-01 日汇总表：经营日汇总（StoreDailySummary）、ASIN 日汇总（AsinDailySummary）。
-- 依据：freeze/models.md 第七节（10.1 日汇总表）、10 章 10.1、14 章 P2a-01。
--
-- 内容：
--   一、新增 2 张表（店铺 × 日、店铺 × ASIN × 日）；summaryDate 为数据口径时区（企业 timezone，默认美国太平洋时区）的日历日。
--   二、可空列为空表示“来源还没有接入或没有数据”（不是 0）：广告、利润、会话、库存。
--   三、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（只删除这两张表；汇总数据可由派生任务重新计算，不丢失原始数据）。
-- 本迁移只新增表，不修改、不删除任何既有对象。

CREATE TABLE "StoreDailySummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "summaryDate" DATE NOT NULL,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "salesAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "refundAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "adsSpend" DECIMAL(20,6),
    "adsSales" DECIMAL(20,6),
    "profit" DECIMAL(20,6),
    "sessions" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "metricVersion" TEXT NOT NULL,
    "salesSource" TEXT NOT NULL DEFAULT 'ORDERS',
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreDailySummary_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreDailySummary_counts_check" CHECK ("orders" >= 0 AND "units" >= 0)
);

CREATE TABLE "AsinDailySummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "summaryDate" DATE NOT NULL,
    "asin" TEXT NOT NULL,
    "sku" TEXT,
    "units" INTEGER NOT NULL DEFAULT 0,
    "salesAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "sessions" INTEGER,
    "pageViews" INTEGER,
    "buyBoxPct" DECIMAL(9,6),
    "adsSpend" DECIMAL(20,6),
    "adsSales" DECIMAL(20,6),
    "profit" DECIMAL(20,6),
    "inventoryAvailable" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "metricVersion" TEXT NOT NULL,
    "salesSource" TEXT NOT NULL DEFAULT 'ORDERS',
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AsinDailySummary_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AsinDailySummary_units_check" CHECK ("units" >= 0)
);

CREATE UNIQUE INDEX "StoreDailySummary_tenantId_sellerAccountId_summaryDate_key" ON "StoreDailySummary"("tenantId", "sellerAccountId", "summaryDate");
CREATE INDEX "StoreDailySummary_tenantId_summaryDate_idx" ON "StoreDailySummary"("tenantId", "summaryDate");
CREATE INDEX "StoreDailySummary_sellerAccountId_idx" ON "StoreDailySummary"("sellerAccountId");
CREATE UNIQUE INDEX "AsinDailySummary_tenantId_sellerAccountId_asin_summaryDate_key" ON "AsinDailySummary"("tenantId", "sellerAccountId", "asin", "summaryDate");
CREATE INDEX "AsinDailySummary_tenantId_summaryDate_idx" ON "AsinDailySummary"("tenantId", "summaryDate");
CREATE INDEX "AsinDailySummary_tenantId_sellerAccountId_summaryDate_idx" ON "AsinDailySummary"("tenantId", "sellerAccountId", "summaryDate");
CREATE INDEX "AsinDailySummary_sellerAccountId_idx" ON "AsinDailySummary"("sellerAccountId");

ALTER TABLE "StoreDailySummary" ADD CONSTRAINT "StoreDailySummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreDailySummary" ADD CONSTRAINT "StoreDailySummary_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AsinDailySummary" ADD CONSTRAINT "AsinDailySummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AsinDailySummary" ADD CONSTRAINT "AsinDailySummary_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['StoreDailySummary', 'AsinDailySummary'] LOOP
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
