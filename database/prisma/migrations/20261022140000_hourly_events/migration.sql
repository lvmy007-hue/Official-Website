-- M-P2a-03 小时事件表：HourlySalesEvent / HourlyTrafficEvent / HourlyInventoryEvent。
-- 依据：freeze/models.md 第十节、importers.md N-01/N-02/N-03、04 章 4.2、14 章 P2a-03。
--
-- 内容：
--   一、三张按月分区表（分区列 hourStart）；唯一键含分区列。
--   二、行级安全与授权。
--
-- 回滚方法：见同目录 rollback.sql（删除三张表；小时事件由推送重放可重建，不丢原始通知）。
-- 本迁移只新增表，不修改、不删除任何既有对象。

CREATE TABLE "HourlySalesEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "asin" TEXT NOT NULL,
  "hourStart" TIMESTAMP(3) NOT NULL,
  "units" INTEGER NOT NULL,
  "salesAmount" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "orders" INTEGER NOT NULL DEFAULT 0,
  "isLateArrival" BOOLEAN NOT NULL DEFAULT false,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HourlySalesEvent_pkey" PRIMARY KEY ("id", "hourStart")
) PARTITION BY RANGE ("hourStart");
CREATE UNIQUE INDEX "HourlySalesEvent_uq" ON "HourlySalesEvent"("tenantId", "sellerAccountId", "asin", "hourStart");
CREATE INDEX "HourlySalesEvent_tenant_hour_idx" ON "HourlySalesEvent"("tenantId", "hourStart");
CREATE INDEX "HourlySalesEvent_store_hour_idx" ON "HourlySalesEvent"("tenantId", "sellerAccountId", "hourStart");
CREATE INDEX "HourlySalesEvent_store_idx" ON "HourlySalesEvent"("sellerAccountId");
ALTER TABLE "HourlySalesEvent" ADD CONSTRAINT "HourlySalesEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HourlySalesEvent" ADD CONSTRAINT "HourlySalesEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "HourlyTrafficEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "asin" TEXT NOT NULL,
  "hourStart" TIMESTAMP(3) NOT NULL,
  "pageViews" INTEGER NOT NULL,
  "sessions" INTEGER,
  "buyBoxPct" DECIMAL(9,6),
  "isLateArrival" BOOLEAN NOT NULL DEFAULT false,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HourlyTrafficEvent_pkey" PRIMARY KEY ("id", "hourStart")
) PARTITION BY RANGE ("hourStart");
CREATE UNIQUE INDEX "HourlyTrafficEvent_uq" ON "HourlyTrafficEvent"("tenantId", "sellerAccountId", "asin", "hourStart");
CREATE INDEX "HourlyTrafficEvent_tenant_hour_idx" ON "HourlyTrafficEvent"("tenantId", "hourStart");
CREATE INDEX "HourlyTrafficEvent_store_hour_idx" ON "HourlyTrafficEvent"("tenantId", "sellerAccountId", "hourStart");
CREATE INDEX "HourlyTrafficEvent_store_idx" ON "HourlyTrafficEvent"("sellerAccountId");
ALTER TABLE "HourlyTrafficEvent" ADD CONSTRAINT "HourlyTrafficEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HourlyTrafficEvent" ADD CONSTRAINT "HourlyTrafficEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "HourlyInventoryEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "asin" TEXT NOT NULL,
  "hourStart" TIMESTAMP(3) NOT NULL,
  "availableQty" INTEGER NOT NULL,
  "isLateArrival" BOOLEAN NOT NULL DEFAULT false,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HourlyInventoryEvent_pkey" PRIMARY KEY ("id", "hourStart")
) PARTITION BY RANGE ("hourStart");
CREATE UNIQUE INDEX "HourlyInventoryEvent_uq" ON "HourlyInventoryEvent"("tenantId", "sellerAccountId", "asin", "hourStart");
CREATE INDEX "HourlyInventoryEvent_tenant_hour_idx" ON "HourlyInventoryEvent"("tenantId", "hourStart");
CREATE INDEX "HourlyInventoryEvent_store_hour_idx" ON "HourlyInventoryEvent"("tenantId", "sellerAccountId", "hourStart");
CREATE INDEX "HourlyInventoryEvent_store_idx" ON "HourlyInventoryEvent"("sellerAccountId");
ALTER TABLE "HourlyInventoryEvent" ADD CONSTRAINT "HourlyInventoryEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HourlyInventoryEvent" ADD CONSTRAINT "HourlyInventoryEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  PERFORM nova_ensure_partitions_around('"HourlySalesEvent"'::regclass, (timezone('UTC', now()) - interval '14 months')::timestamp, timezone('UTC', now())::timestamp, 3);
  PERFORM nova_ensure_partitions_around('"HourlyTrafficEvent"'::regclass, (timezone('UTC', now()) - interval '14 months')::timestamp, timezone('UTC', now())::timestamp, 3);
  PERFORM nova_ensure_partitions_around('"HourlyInventoryEvent"'::regclass, (timezone('UTC', now()) - interval '14 months')::timestamp, timezone('UTC', now())::timestamp, 3);
END $$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['HourlySalesEvent', 'HourlyTrafficEvent', 'HourlyInventoryEvent'] LOOP
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
