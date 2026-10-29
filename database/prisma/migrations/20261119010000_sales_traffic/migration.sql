-- M-P4-01 销售与流量。
-- 依据：freeze/models.md M-P4-01（SalesTrafficDaily、SalesTrafficAsinDaily）；freeze/importers.md D-01、D-02、D-03、R-34；04 章 4.5；14 章 P4-01。
--
-- 内容：
--   一、两张按月分区表（分区列 date，DATE 类型）：SalesTrafficDaily（店铺 × 日期 × 粒度 × 来源）、SalesTrafficAsinDaily（店铺 × ASIN × 粒度 × SKU × 日期 × 来源）；唯一键含分区列。
--   二、一张不分区的核对记录表 SalesTrafficDiff：报告补充来源与数据中心同键数据差异超过阈值时记一行（ST_SOURCE_DIFF，只记录不覆盖）。
--   三、检查约束、行级安全与授权（与其他租户表一致）。
-- 与冻结的出入：SalesTrafficDaily 多了 unitsRefunded 列；SalesTrafficAsinDaily 的唯一键多一个 sku（默认空串）、多一列 parentAsin 与 b2bUnits；
--   SalesTrafficDiff 是冻结清单之外新增的表（R-34 要求“差异写核对记录”，没有冻结的落点）。见 CR-076。
-- 比率列存 0 到 1 的小数；官方没给的值存空，不是 0。
--
-- 回滚方法：见同目录 rollback.sql（删三张表；都是从亚马逊重新拉取的数据，回滚后下一次定时任务会重新拉取，数据中心只保留 730 天的历史）。

CREATE TABLE "SalesTrafficDaily" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "granularity" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'DATA_KIOSK',
  "orderedSales" DECIMAL(20,6),
  "unitsOrdered" INTEGER,
  "ordersCount" INTEGER,
  "sessions" INTEGER,
  "pageViews" INTEGER,
  "buyBoxPct" DECIMAL(12,6),
  "unitSessionPct" DECIMAL(12,6),
  "unitsRefunded" INTEGER,
  "refundRate" DECIMAL(12,6),
  "claimsGranted" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrafficDaily_pkey" PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
CREATE UNIQUE INDEX "SalesTrafficDaily_uq" ON "SalesTrafficDaily"("tenantId", "sellerAccountId", "date", "granularity", "source");
CREATE INDEX "SalesTrafficDaily_date_idx" ON "SalesTrafficDaily"("tenantId", "date");
CREATE INDEX "SalesTrafficDaily_store_idx" ON "SalesTrafficDaily"("sellerAccountId");
ALTER TABLE "SalesTrafficDaily" ADD CONSTRAINT "SalesTrafficDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesTrafficDaily" ADD CONSTRAINT "SalesTrafficDaily_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SalesTrafficAsinDaily" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "asin" TEXT NOT NULL,
  "asinGranularity" TEXT NOT NULL,
  "sku" TEXT NOT NULL DEFAULT '',
  "parentAsin" TEXT,
  "source" TEXT NOT NULL DEFAULT 'DATA_KIOSK',
  "orderedSales" DECIMAL(20,6),
  "units" INTEGER,
  "ordersCount" INTEGER,
  "sessions" INTEGER,
  "pageViews" INTEGER,
  "buyBoxPct" DECIMAL(12,6),
  "unitSessionPct" DECIMAL(12,6),
  "b2bSales" DECIMAL(20,6),
  "b2bUnits" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrafficAsinDaily_pkey" PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
CREATE UNIQUE INDEX "SalesTrafficAsinDaily_uq" ON "SalesTrafficAsinDaily"("tenantId", "sellerAccountId", "asin", "asinGranularity", "sku", "date", "source");
CREATE INDEX "SalesTrafficAsinDaily_date_idx" ON "SalesTrafficAsinDaily"("tenantId", "date");
CREATE INDEX "SalesTrafficAsinDaily_store_date_idx" ON "SalesTrafficAsinDaily"("tenantId", "sellerAccountId", "date");
CREATE INDEX "SalesTrafficAsinDaily_store_idx" ON "SalesTrafficAsinDaily"("sellerAccountId");
ALTER TABLE "SalesTrafficAsinDaily" ADD CONSTRAINT "SalesTrafficAsinDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesTrafficAsinDaily" ADD CONSTRAINT "SalesTrafficAsinDaily_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SalesTrafficDiff" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "asin" TEXT NOT NULL DEFAULT '',
  "sku" TEXT NOT NULL DEFAULT '',
  "metric" TEXT NOT NULL,
  "kioskValue" DECIMAL(20,6) NOT NULL,
  "reportValue" DECIMAL(20,6) NOT NULL,
  "delta" DECIMAL(20,6) NOT NULL,
  "relativeDiff" DECIMAL(12,6),
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesTrafficDiff_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesTrafficDiff_uq" ON "SalesTrafficDiff"("tenantId", "sellerAccountId", "level", "date", "asin", "sku", "metric");
CREATE INDEX "SalesTrafficDiff_date_idx" ON "SalesTrafficDiff"("tenantId", "date");
CREATE INDEX "SalesTrafficDiff_store_idx" ON "SalesTrafficDiff"("sellerAccountId");
ALTER TABLE "SalesTrafficDiff" ADD CONSTRAINT "SalesTrafficDiff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesTrafficDiff" ADD CONSTRAINT "SalesTrafficDiff_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束（取值由契约 sales-traffic.ts 约定；数量非负；比率在 0 到 1 之间）
ALTER TABLE "SalesTrafficDaily" ADD CONSTRAINT "SalesTrafficDaily_granularity_check" CHECK ("granularity" IN ('DAY', 'WEEK', 'MONTH'));
ALTER TABLE "SalesTrafficDaily" ADD CONSTRAINT "SalesTrafficDaily_source_check" CHECK ("source" IN ('DATA_KIOSK', 'REPORT'));
ALTER TABLE "SalesTrafficDaily" ADD CONSTRAINT "SalesTrafficDaily_value_check" CHECK (
  COALESCE("unitsOrdered", 0) >= 0 AND COALESCE("ordersCount", 0) >= 0 AND COALESCE("sessions", 0) >= 0 AND COALESCE("pageViews", 0) >= 0
  AND COALESCE("unitsRefunded", 0) >= 0 AND COALESCE("claimsGranted", 0) >= 0
  AND COALESCE("buyBoxPct", 0) BETWEEN 0 AND 1 AND COALESCE("unitSessionPct", 0) BETWEEN 0 AND 1 AND COALESCE("refundRate", 0) BETWEEN 0 AND 1
);
ALTER TABLE "SalesTrafficAsinDaily" ADD CONSTRAINT "SalesTrafficAsinDaily_granularity_check" CHECK ("asinGranularity" IN ('PARENT', 'CHILD', 'SKU'));
ALTER TABLE "SalesTrafficAsinDaily" ADD CONSTRAINT "SalesTrafficAsinDaily_source_check" CHECK ("source" IN ('DATA_KIOSK', 'REPORT'));
ALTER TABLE "SalesTrafficAsinDaily" ADD CONSTRAINT "SalesTrafficAsinDaily_value_check" CHECK (
  COALESCE("units", 0) >= 0 AND COALESCE("ordersCount", 0) >= 0 AND COALESCE("sessions", 0) >= 0 AND COALESCE("pageViews", 0) >= 0 AND COALESCE("b2bUnits", 0) >= 0
  AND COALESCE("buyBoxPct", 0) BETWEEN 0 AND 1 AND COALESCE("unitSessionPct", 0) BETWEEN 0 AND 1
);
ALTER TABLE "SalesTrafficDiff" ADD CONSTRAINT "SalesTrafficDiff_level_check" CHECK ("level" IN ('DAY', 'PARENT', 'CHILD', 'SKU'));
ALTER TABLE "SalesTrafficDiff" ADD CONSTRAINT "SalesTrafficDiff_metric_check" CHECK ("metric" IN ('orderedSales', 'unitsOrdered', 'sessions', 'pageViews'));

-- 分区：向前 26 个月（数据中心保留两年）、向后 3 个月
DO $$
BEGIN
  PERFORM nova_ensure_partitions_around('"SalesTrafficDaily"'::regclass, (timezone('UTC', now()) - interval '26 months')::timestamp, timezone('UTC', now())::timestamp, 3);
  PERFORM nova_ensure_partitions_around('"SalesTrafficAsinDaily"'::regclass, (timezone('UTC', now()) - interval '26 months')::timestamp, timezone('UTC', now())::timestamp, 3);
END $$;

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['SalesTrafficDaily', 'SalesTrafficAsinDaily', 'SalesTrafficDiff'] LOOP
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
