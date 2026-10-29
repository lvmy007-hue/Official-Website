-- M-P2b-09 利润日表。
-- 依据：freeze/models.md M-P2b-09（ProfitDaily）；07 章 7.9；10 章 10.1；14 章 P2b-09。
--
-- 内容：
--   一、新表 ProfitDaily：店铺 × SKU × 日 × 收入确认口径（下单、发货、结算释放三种并存），由派生任务 profit_daily 先删后写。
--   二、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：唯一键多了 basis（三种口径并存）；平台费用拆成 6 列、另加促销、赔付、其他成本与成本折算依据列，见 CR-047。
--
-- 回滚方法：见同目录 rollback.sql（删表；是派生数据，回滚后重新跑派生任务即可重建）。

-- CreateTable
CREATE TABLE "ProfitDaily" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "profitDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "basis" TEXT NOT NULL,
    "costing" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "units" INTEGER NOT NULL DEFAULT 0,
    "costedUnits" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "refunds" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeCommission" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeFulfillment" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeStorage" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeAged" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeInbound" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "feeOther" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "promotion" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "adsSpendAllocated" DECIMAL(20,6),
    "adsUnallocated" DECIMAL(20,6),
    "productCost" DECIMAL(20,6),
    "firstMileCost" DECIMAL(20,6),
    "otherCost" DECIMAL(20,6),
    "reimbursement" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "profit" DECIMAL(20,6),
    "costCoverage" DECIMAL(9,6),
    "costCurrency" TEXT,
    "productCostOriginal" DECIMAL(20,6),
    "firstMileCostOriginal" DECIMAL(20,6),
    "fxRate" DECIMAL(18,8),
    "fxSource" TEXT,
    "fxFallback" BOOLEAN NOT NULL DEFAULT false,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metricVersion" TEXT NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfitDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfitDaily_uq" ON "ProfitDaily"("tenantId", "sellerAccountId", "sku", "profitDate", "basis");

-- CreateIndex
CREATE INDEX "ProfitDaily_date_idx" ON "ProfitDaily"("tenantId", "basis", "profitDate");

-- CreateIndex
CREATE INDEX "ProfitDaily_sellerAccountId_idx" ON "ProfitDaily"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_basis_check" CHECK ("basis" IN ('ORDERED', 'SHIPPED', 'SETTLED'));
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_costing_check" CHECK ("costing" IN ('FIFO', 'MOVING_AVG', 'MONTH_AVG'));
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_units_check" CHECK ("units" >= 0 AND "costedUnits" >= 0 AND "costedUnits" <= "units");
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_coverage_check" CHECK ("costCoverage" IS NULL OR ("costCoverage" >= 0 AND "costCoverage" <= 1));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ProfitDaily'] LOOP
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
