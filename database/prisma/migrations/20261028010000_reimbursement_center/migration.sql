-- M-P2b-03 赔付中心。
-- 依据：freeze/models.md M-P2b-03；07 章 7.3；14 章 P2b-03；变更单 CR-002（官方赔付明细 ReimbursementRecord）。
--
-- 内容：
--   一、新表：ReimbursementCase（赔付案件）、ReimbursementRecord（官方赔付明细）、EvidencePack（证据包快照）。
--   二、赔付机会 ReimbursementOpportunity 加 4 列：sku、qty、note、version（页面直接显示 SKU 与数量，忽略要写原因，忽略与恢复走乐观锁）；
--       入仓差异（P2a-13 产出）的既有机会用编号与接收差异回填 sku 与 qty。
--   三、检查约束：规则与状态取值、金额非负；行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除三张新表、去掉机会的 4 列；案件上的人工处理状态与证据包清单不可恢复，回滚前请先导出）。

-- AlterTable
ALTER TABLE "ReimbursementOpportunity" ADD COLUMN "sku" TEXT,
ADD COLUMN "qty" INTEGER,
ADD COLUMN "note" TEXT,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- 回填：入仓差异机会的 dedupKey 是“货件编号:SKU”，数量取同一货件同一 SKU 的少收差异
UPDATE "ReimbursementOpportunity"
SET "sku" = substr("dedupKey", position(':' in "dedupKey") + 1)
WHERE "ruleCode" = 'INBOUND_DISCREPANCY' AND position(':' in "dedupKey") > 0;

UPDATE "ReimbursementOpportunity" o
SET "qty" = d."qty"
FROM "ReceivingDiscrepancy" d
WHERE o."ruleCode" = 'INBOUND_DISCREPANCY'
  AND d."tenantId" = o."tenantId"
  AND d."sellerAccountId" = o."sellerAccountId"
  AND d."kind" = 'SHORT'
  AND d."sku" = o."sku"
  AND o."dedupKey" = (d."shipmentRef" || ':' || d."sku");

-- CreateTable
CREATE TABLE "ReimbursementCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "caseNo" TEXT NOT NULL,
    "opportunityId" TEXT,
    "ruleCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPPORTUNITY',
    "sku" TEXT,
    "qty" INTEGER,
    "expectedAmount" DECIMAL(20,6),
    "approvedAmount" DECIMAL(20,6),
    "receivedAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "currency" TEXT,
    "ownerId" TEXT NOT NULL,
    "amazonCaseId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "deadlineAt" DATE,
    "evidenceRefsJson" JSONB NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "asin" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "originalOrderId" TEXT,
    "amazonCaseId" TEXT,
    "matchedCaseId" TEXT,
    "matchBasis" TEXT,
    "matchedAt" TIMESTAMP(3),
    "sourceReportJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "exportJobId" TEXT,
    "contentManifestJson" JSONB NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT NOT NULL,

    CONSTRAINT "EvidencePack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementCase_no_uq" ON "ReimbursementCase"("tenantId", "caseNo");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementCase_opp_uq" ON "ReimbursementCase"("opportunityId");

-- CreateIndex
CREATE INDEX "ReimbursementCase_store_idx" ON "ReimbursementCase"("sellerAccountId");

-- CreateIndex
CREATE INDEX "ReimbursementCase_status_idx" ON "ReimbursementCase"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReimbursementCase_amz_idx" ON "ReimbursementCase"("tenantId", "amazonCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementRecord_uq" ON "ReimbursementRecord"("sellerAccountId", "reimbursementId", "sku", "fnsku");

-- CreateIndex
CREATE INDEX "ReimbursementRecord_case_idx" ON "ReimbursementRecord"("matchedCaseId");

-- CreateIndex
CREATE INDEX "ReimbursementRecord_date_idx" ON "ReimbursementRecord"("tenantId", "sellerAccountId", "approvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidencePack_uq" ON "EvidencePack"("caseId", "generatedAt");

-- CreateIndex
CREATE INDEX "EvidencePack_tenant_idx" ON "EvidencePack"("tenantId", "generatedAt");

-- AddForeignKey
ALTER TABLE "ReimbursementCase" ADD CONSTRAINT "ReimbursementCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementCase" ADD CONSTRAINT "ReimbursementCase_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementCase" ADD CONSTRAINT "ReimbursementCase_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "ReimbursementOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementRecord" ADD CONSTRAINT "ReimbursementRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementRecord" ADD CONSTRAINT "ReimbursementRecord_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementRecord" ADD CONSTRAINT "ReimbursementRecord_matchedCaseId_fkey" FOREIGN KEY ("matchedCaseId") REFERENCES "ReimbursementCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReimbursementCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：规则与状态取值、金额与数量非负（赔付明细的金额允许为负：赔付冲回）
ALTER TABLE "ReimbursementCase" ADD CONSTRAINT "ReimbursementCase_check" CHECK (
  "ruleCode" IN ('INBOUND_DISCREPANCY', 'LEDGER_LOST', 'LEDGER_DAMAGED', 'REFUND_NO_RETURN', 'RETURN_DISPOSITION', 'FEE_OVERCHARGE', 'REMOVAL_LOST')
  AND "status" IN ('OPPORTUNITY', 'SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'PARTIAL', 'REJECTED', 'PAID')
  AND ("expectedAmount" IS NULL OR "expectedAmount" >= 0)
  AND ("approvedAmount" IS NULL OR "approvedAmount" >= 0)
  AND "receivedAmount" >= 0
  AND ("qty" IS NULL OR "qty" >= 0)
);
ALTER TABLE "ReimbursementRecord" ADD CONSTRAINT "ReimbursementRecord_check" CHECK (
  "quantity" >= 0
  AND ("matchBasis" IS NULL OR "matchBasis" IN ('CASE_ID', 'ORDER_SKU', 'SKU_REASON'))
  AND (("matchedCaseId" IS NULL) OR ("matchBasis" IS NOT NULL))
);
ALTER TABLE "ReimbursementOpportunity" ADD CONSTRAINT "ReimbursementOpp_qty_check" CHECK ("qty" IS NULL OR "qty" >= 0);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ReimbursementCase', 'ReimbursementRecord', 'EvidencePack'] LOOP
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
