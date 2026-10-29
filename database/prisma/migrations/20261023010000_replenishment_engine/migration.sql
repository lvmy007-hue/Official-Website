-- M-P2a-07 补货建议：订阅省同步表、补货批次与建议、动作、结果回看、单品经济模拟运行，并扩展补货策略版本表。
-- 依据：freeze/models.md 第十一节 M-P2a-07；06 章 6.2；04 章 4.9；importers.md I-19、D-06；14 章 P2a-07。
--
-- 内容：
--   一、ReplenishmentPolicy 增加 9 列（全部可空，旧版本不受影响）：提前期拆分（生产、国内运输、入仓接收）、服务水平、运输方式偏好与选项、箱规、最小起订量、最小起订金额。
--      level 仍为 TENANT / CATEGORY / SKU，下级版本整行覆盖上级（见 CR-030）。
--   二、新增 7 张表：SubscribeSaveMetric、SubscribeSaveOffer（I-19）、ReplenishmentBatch、ReplenishmentRecommendation、ReplenishmentAction、ReplenishmentOutcome、EconomicsSimulationRun（D-06）。
--   三、检查约束与行级安全、授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除 7 张表与 9 个新列；批次、建议、动作是人工审核过的业务记录，回滚前请先导出）。
-- 本迁移不修改、不删除任何既有数据。
-- AlterTable
ALTER TABLE "ReplenishmentPolicy" ADD COLUMN     "casePackQty" INTEGER,
ADD COLUMN     "domesticDays" INTEGER,
ADD COLUMN     "minOrderValue" DECIMAL(20,6),
ADD COLUMN     "moq" INTEGER,
ADD COLUMN     "productionDays" INTEGER,
ADD COLUMN     "receivingDays" INTEGER,
ADD COLUMN     "serviceLevel" DECIMAL(5,4),
ADD COLUMN     "transportOptionsJson" JSONB,
ADD COLUMN     "transportPreference" TEXT;

-- CreateTable
CREATE TABLE "SubscribeSaveMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "metricDate" DATE NOT NULL,
    "granularity" TEXT NOT NULL DEFAULT 'DAY',
    "activeSubscribers" INTEGER,
    "shippedUnits" INTEGER,
    "revenue" DECIMAL(20,6),
    "currency" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscribeSaveMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscribeSaveOffer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "eligibility" TEXT,
    "fulfillment" TEXT,
    "sellerFundedBasePct" DECIMAL(6,2),
    "price" DECIMAL(20,6),
    "currency" TEXT,
    "inventory" INTEGER,
    "stockRisk" TEXT,
    "subscriptions" INTEGER,
    "forecastNext15" INTEGER,
    "forecastNext30" INTEGER,
    "forecastNext60" INTEGER,
    "forecastNext90" INTEGER,
    "shippedUnitsPrevMonth" INTEGER,
    "prevMonthStart" DATE,
    "prevMonthDays" INTEGER,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscribeSaveOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "today" DATE NOT NULL,
    "storeIdsJson" JSONB NOT NULL,
    "policyVersionsJson" JSONB NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "skuTotal" INTEGER NOT NULL,
    "recommendedCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "fnsku" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'PURCHASE',
    "riskLevel" TEXT,
    "recommendedQty" INTEGER NOT NULL,
    "purchaseQty" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "shipDate" DATE,
    "arriveDate" DATE,
    "stockoutDate" DATE,
    "confidence" DECIMAL(5,4) NOT NULL,
    "calcStepsJson" JSONB NOT NULL,
    "shipmentsJson" JSONB NOT NULL,
    "capitalAmount" DECIMAL(20,6),
    "amazonRestockQty" INTEGER,
    "amazonShipDate" DATE,
    "diffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "finalQty" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DONE',
    "targetDocType" TEXT,
    "targetDocId" TEXT,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "evaluatedAt" DATE NOT NULL,
    "windowStart" DATE NOT NULL,
    "windowEnd" DATE NOT NULL,
    "forecastQty" INTEGER NOT NULL,
    "actualQty" INTEGER NOT NULL,
    "errorPct" DECIMAL(12,4),
    "stockoutDays" INTEGER NOT NULL,
    "excessUnits" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicsSimulationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "syncJobId" TEXT,
    "actionType" TEXT NOT NULL DEFAULT 'AWD',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "inputJson" JSONB NOT NULL,
    "resultJson" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomicsSimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscribeSaveMetric_store_idx" ON "SubscribeSaveMetric"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscribeSaveMetric_uq" ON "SubscribeSaveMetric"("tenantId", "sellerAccountId", "granularity", "metricDate");

-- CreateIndex
CREATE INDEX "SubscribeSaveOffer_store_idx" ON "SubscribeSaveOffer"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscribeSaveOffer_uq" ON "SubscribeSaveOffer"("tenantId", "sellerAccountId", "sku", "snapshotDate");

-- CreateIndex
CREATE INDEX "ReplenishmentBatch_time_idx" ON "ReplenishmentBatch"("tenantId", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentBatch_uq" ON "ReplenishmentBatch"("tenantId", "batchNo");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_store_idx" ON "ReplenishmentRecommendation"("sellerAccountId");

-- CreateIndex
CREATE INDEX "ReplenishmentRecommendation_sku_idx" ON "ReplenishmentRecommendation"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentRecommendation_uq" ON "ReplenishmentRecommendation"("batchId", "sellerAccountId", "sku", "channel");

-- CreateIndex
CREATE INDEX "ReplenishmentAction_tenant_idx" ON "ReplenishmentAction"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ReplenishmentAction_batch_idx" ON "ReplenishmentAction"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "ReplenishmentAction_rec_idx" ON "ReplenishmentAction"("recommendationId");

-- CreateIndex
CREATE INDEX "ReplenishmentOutcome_tenant_idx" ON "ReplenishmentOutcome"("tenantId", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentOutcome_uq" ON "ReplenishmentOutcome"("recommendationId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EconomicsSimulationRun_store_idx" ON "EconomicsSimulationRun"("sellerAccountId");

-- CreateIndex
CREATE INDEX "EconomicsSimulationRun_time_idx" ON "EconomicsSimulationRun"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscribeSaveMetric" ADD CONSTRAINT "SubscribeSaveMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscribeSaveMetric" ADD CONSTRAINT "SubscribeSaveMetric_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscribeSaveOffer" ADD CONSTRAINT "SubscribeSaveOffer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscribeSaveOffer" ADD CONSTRAINT "SubscribeSaveOffer_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentBatch" ADD CONSTRAINT "ReplenishmentBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReplenishmentBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentAction" ADD CONSTRAINT "ReplenishmentAction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentAction" ADD CONSTRAINT "ReplenishmentAction_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReplenishmentBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentAction" ADD CONSTRAINT "ReplenishmentAction_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "ReplenishmentRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentOutcome" ADD CONSTRAINT "ReplenishmentOutcome_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentOutcome" ADD CONSTRAINT "ReplenishmentOutcome_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "ReplenishmentRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomicsSimulationRun" ADD CONSTRAINT "EconomicsSimulationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomicsSimulationRun" ADD CONSTRAINT "EconomicsSimulationRun_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "ReplenishmentPolicy" ADD CONSTRAINT "ReplenishmentPolicy_ref_check" CHECK ("level" <> 'TENANT' OR "levelRef" = 'ALL');
ALTER TABLE "ReplenishmentPolicy" ADD CONSTRAINT "ReplenishmentPolicy_replenish_check" CHECK (
  ("productionDays" IS NULL OR "productionDays" BETWEEN 0 AND 365)
  AND ("domesticDays" IS NULL OR "domesticDays" BETWEEN 0 AND 365)
  AND ("receivingDays" IS NULL OR "receivingDays" BETWEEN 0 AND 365)
  AND ("serviceLevel" IS NULL OR ("serviceLevel" >= 0.5 AND "serviceLevel" <= 0.9999))
  AND ("transportPreference" IS NULL OR "transportPreference" IN ('AUTO', 'SEA', 'AIR', 'EXPRESS'))
  AND ("transportOptionsJson" IS NULL OR jsonb_typeof("transportOptionsJson") = 'array')
  AND ("casePackQty" IS NULL OR "casePackQty" >= 1)
  AND ("moq" IS NULL OR "moq" >= 1)
  AND ("minOrderValue" IS NULL OR "minOrderValue" >= 0)
);
ALTER TABLE "SubscribeSaveMetric" ADD CONSTRAINT "SubscribeSaveMetric_granularity_check" CHECK ("granularity" IN ('DAY', 'WEEK', 'MONTH'));
ALTER TABLE "ReplenishmentBatch" ADD CONSTRAINT "ReplenishmentBatch_status_check" CHECK ("status" IN ('COMPUTING', 'PENDING_REVIEW', 'CONFIRMED', 'DRAFTED', 'CLOSED'));
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_channel_check" CHECK ("channel" IN ('PURCHASE', 'INBOUND', 'AWD'));
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_risk_check" CHECK ("riskLevel" IS NULL OR "riskLevel" IN ('HIGH', 'MEDIUM', 'NORMAL', 'EXCESS'));
ALTER TABLE "ReplenishmentRecommendation" ADD CONSTRAINT "ReplenishmentRecommendation_qty_check" CHECK ("recommendedQty" >= 0 AND "purchaseQty" >= 0 AND "confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "ReplenishmentAction" ADD CONSTRAINT "ReplenishmentAction_action_check" CHECK ("action" IN ('ADOPT', 'ADJUST', 'IGNORE', 'PURCHASE_DRAFT', 'INBOUND_DRAFT', 'AWD_DRAFT'));
ALTER TABLE "ReplenishmentAction" ADD CONSTRAINT "ReplenishmentAction_status_check" CHECK ("status" IN ('DONE', 'PENDING_TARGET'));
ALTER TABLE "ReplenishmentAction" ADD CONSTRAINT "ReplenishmentAction_qty_check" CHECK ("finalQty" IS NULL OR "finalQty" >= 0);
ALTER TABLE "EconomicsSimulationRun" ADD CONSTRAINT "EconomicsSimulationRun_action_check" CHECK ("actionType" IN ('AWD', 'SIPP'));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['SubscribeSaveMetric', 'SubscribeSaveOffer', 'ReplenishmentBatch', 'ReplenishmentRecommendation', 'ReplenishmentAction', 'ReplenishmentOutcome', 'EconomicsSimulationRun'] LOOP
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