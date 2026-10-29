-- M-P2a-13 货件接收与差异。
-- 依据：freeze/models.md M-P2a-13；06 章 6.12；07 章 7.3；14 章 P2a-13。
--
-- 内容：
--   一、新表：ReceivingDiscrepancy（接收差异与不合规问题）、ReimbursementOpportunity（赔付机会，本包只产出“入仓差异”一类）。
--   二、检查约束：差异类型与来源、机会规则与状态取值；数量与金额非负。
--   三、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表；两张表都是同步器按接收数据与报告算出来的，回滚后下一次同步会重新生成差异，
-- 但机会上的“已忽略、已生成案件”等人工处理状态不可恢复，回滚前请先导出）。
-- 本迁移不修改、不删除任何既有数据；货件证据附件复用 Attachment（entityType = INBOUND_SHIPMENT），不需要新表。

-- CreateTable
CREATE TABLE "ReceivingDiscrepancy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "planId" TEXT,
    "shipmentRef" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" INTEGER,
    "problemKey" TEXT NOT NULL DEFAULT '',
    "problemType" TEXT,
    "source" TEXT NOT NULL,
    "amount" DECIMAL(20,6),
    "currency" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ReceivingDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementOpportunity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "evidenceRefsJson" JSONB NOT NULL,
    "estimatedAmount" DECIMAL(20,6),
    "currency" TEXT,
    "deadlineAt" DATE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceivingDiscrepancy_store_idx" ON "ReceivingDiscrepancy"("sellerAccountId");

-- CreateIndex
CREATE INDEX "ReceivingDiscrepancy_ship_idx" ON "ReceivingDiscrepancy"("tenantId", "shipmentRef");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingDiscrepancy_uq" ON "ReceivingDiscrepancy"("tenantId", "sellerAccountId", "shipmentRef", "sku", "kind", "problemKey");

-- CreateIndex
CREATE INDEX "ReimbursementOpp_store_idx" ON "ReimbursementOpportunity"("sellerAccountId");

-- CreateIndex
CREATE INDEX "ReimbursementOpp_status_idx" ON "ReimbursementOpportunity"("tenantId", "status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementOpp_uq" ON "ReimbursementOpportunity"("tenantId", "sellerAccountId", "ruleCode", "dedupKey");

-- AddForeignKey
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementOpportunity" ADD CONSTRAINT "ReimbursementOpportunity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementOpportunity" ADD CONSTRAINT "ReimbursementOpportunity_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：取值范围、数量与金额非负
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_check" CHECK (
  "kind" IN ('SHORT', 'OVER', 'NONCOMPLIANCE')
  AND "source" IN ('RECEIPT', 'REPORT')
  AND (("kind" = 'NONCOMPLIANCE') = ("source" = 'REPORT'))
  AND ("qty" IS NULL OR "qty" >= 0)
  AND ("amount" IS NULL OR "amount" >= 0)
  AND ("kind" = 'NONCOMPLIANCE' OR ("qty" IS NOT NULL AND "qty" > 0))
);
ALTER TABLE "ReimbursementOpportunity" ADD CONSTRAINT "ReimbursementOpp_check" CHECK (
  "ruleCode" IN ('INBOUND_DISCREPANCY', 'LEDGER_LOST', 'LEDGER_DAMAGED', 'REFUND_NO_RETURN', 'RETURN_DISPOSITION', 'FEE_OVERCHARGE', 'REMOVAL_LOST')
  AND "status" IN ('PENDING', 'CASE_CREATED', 'IGNORED', 'EXPIRED', 'RESOLVED')
  AND ("estimatedAmount" IS NULL OR "estimatedAmount" >= 0)
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ReceivingDiscrepancy', 'ReimbursementOpportunity'] LOOP
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
