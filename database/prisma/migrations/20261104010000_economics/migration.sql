-- M-P2b-11 官方经济数据对账。
-- 依据：freeze/models.md M-P2b-11（EconomicsDaily、EconomicsPreview）；freeze/importers.md D-04、D-05；07 章 7.10；14 章 P2b-11。
--
-- 内容：
--   一、新表 EconomicsDaily：官方单品经济的实际数据，店铺 × MSKU × 日，重复拉取按唯一键覆盖。
--   二、新表 EconomicsPreview：官方费用预览（未来最多 120 天），每次查询带同一个 queriedAt。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：EconomicsDaily 多了件数、下单与退款销售额、费用合计、成本明细列；EconomicsPreview 多了 asin、数量、单件费用与单件费用变化；
--   均没有按月分区（数据量按 SKU 数 × 天数估算在百万行以内，与 ProfitDaily 一致），见 CR-049。
-- 官方没给的值一律存空：成本未填、净收益未算出，都不是 0。
--
-- 回滚方法：见同目录 rollback.sql（删两张表；都是从亚马逊重新拉取的数据，回滚后下一次定时任务会重新拉取）。

-- CreateTable
CREATE TABLE "EconomicsDaily" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "msku" TEXT NOT NULL,
    "asin" TEXT,
    "aggregation" TEXT NOT NULL DEFAULT 'DAY',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "unitsOrdered" INTEGER NOT NULL DEFAULT 0,
    "unitsRefunded" INTEGER NOT NULL DEFAULT 0,
    "netUnits" INTEGER NOT NULL DEFAULT 0,
    "orderedSales" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "refundedSales" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "sales" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feesTotal" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feesJson" JSONB NOT NULL DEFAULT '[]',
    "adsSpend" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "sellerCostPerUnit" DECIMAL(20,6),
    "costJson" JSONB,
    "netProceeds" DECIMAL(20,6),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomicsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicsPreview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "msku" TEXT NOT NULL,
    "asin" TEXT,
    "feeType" TEXT NOT NULL,
    "rangeStart" DATE NOT NULL,
    "rangeEnd" DATE NOT NULL,
    "estimatedAmount" DECIMAL(20,6) NOT NULL,
    "quantity" DECIMAL(20,6),
    "amountPerUnit" DECIMAL(20,6),
    "amountPerUnitDelta" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "queriedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomicsPreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EconomicsDaily_uq" ON "EconomicsDaily"("tenantId", "sellerAccountId", "msku", "date", "aggregation");

-- CreateIndex
CREATE INDEX "EconomicsDaily_date_idx" ON "EconomicsDaily"("tenantId", "date");

-- CreateIndex
CREATE INDEX "EconomicsDaily_sellerAccountId_idx" ON "EconomicsDaily"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomicsPreview_uq" ON "EconomicsPreview"("tenantId", "sellerAccountId", "msku", "feeType", "rangeStart", "rangeEnd");

-- CreateIndex
CREATE INDEX "EconomicsPreview_time_idx" ON "EconomicsPreview"("tenantId", "queriedAt");

-- CreateIndex
CREATE INDEX "EconomicsPreview_sellerAccountId_idx" ON "EconomicsPreview"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "EconomicsDaily" ADD CONSTRAINT "EconomicsDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomicsDaily" ADD CONSTRAINT "EconomicsDaily_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomicsPreview" ADD CONSTRAINT "EconomicsPreview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomicsPreview" ADD CONSTRAINT "EconomicsPreview_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "EconomicsDaily" ADD CONSTRAINT "EconomicsDaily_aggregation_check" CHECK ("aggregation" IN ('DAY'));
ALTER TABLE "EconomicsDaily" ADD CONSTRAINT "EconomicsDaily_units_check" CHECK ("unitsOrdered" >= 0 AND "unitsRefunded" >= 0);
ALTER TABLE "EconomicsPreview" ADD CONSTRAINT "EconomicsPreview_range_check" CHECK ("rangeEnd" >= "rangeStart");

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['EconomicsDaily', 'EconomicsPreview'] LOOP
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
