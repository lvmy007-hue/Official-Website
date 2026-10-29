-- M-P2b-07 结算交易。
-- 依据：freeze/models.md M-P2b-07（FbaSettlement 补列、Reconciliation、ReconciliationException）；07 章 7.7；14 章 P2b-07；importers.md R-28。
--
-- 内容：
--   一、FbaSettlement 补列：期初余额、打款金额、报告明细条数、对账状态、差额、各类别合计、列表排序时间（旧行回填为打款日，没有则周期结束日，再没有则建立时间）。
--   二、新表：SettlementLine（结算报告明细，一行一笔金额）、Reconciliation（一张结算单一份核对结果）、ReconciliationException（核对出的异常）。
--   三、检查约束与行级安全授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删三张新表、去掉 FbaSettlement 的补列。三张新表与补列都是由结算报告与后台核对重新生成的数据，
-- 但原始结算报告文件只保留在对象存储里，回滚后需要重新导入；“已对账”标记（FbaFeeEvent、FbaFinancialTransaction 里由系统账号写入的）不在回滚里还原）。

-- AlterTable
ALTER TABLE "FbaSettlement"
  ADD COLUMN "openingBalance" DECIMAL(20,6),
  ADD COLUMN "disbursementAmount" DECIMAL(20,6),
  ADD COLUMN "txnCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "diffAmount" DECIMAL(20,6),
  ADD COLUMN "summaryJson" JSONB,
  ADD COLUMN "sortAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "FbaSettlement" SET "sortAt" = COALESCE("depositDate", "settlementEndDate", "createdAt");

ALTER TABLE "FbaSettlement" ADD CONSTRAINT "FbaSettlement_reconciliation_check" CHECK ("reconciliationStatus" IN ('PENDING', 'MATCHED', 'DISCREPANCY'));

-- CreateTable
CREATE TABLE "SettlementLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "transactionType" TEXT NOT NULL DEFAULT '',
    "amountType" TEXT NOT NULL DEFAULT '',
    "amountDescription" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "amazonOrderId" TEXT,
    "shipmentId" TEXT,
    "sku" TEXT,
    "quantity" INTEGER,
    "postedAt" TIMESTAMP(3),
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceReportJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL DEFAULT 'SETTLEMENT',
    "settlementId" TEXT,
    "rangeStart" DATE NOT NULL,
    "rangeEnd" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "officialAmount" DECIMAL(20,6) NOT NULL,
    "systemAmount" DECIMAL(20,6) NOT NULL,
    "diffAmount" DECIMAL(20,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pendingReason" TEXT,
    "detailJson" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationException" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "amazonOrderId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reportAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "apiAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "amount" DECIMAL(20,6) NOT NULL,
    "absAmount" DECIMAL(20,6) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FbaSettlement_sort_idx" ON "FbaSettlement"("tenantId", "sortAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLine_uq" ON "SettlementLine"("settlementId", "lineNo");

-- CreateIndex
CREATE INDEX "SettlementLine_order_idx" ON "SettlementLine"("tenantId", "amazonOrderId");

-- CreateIndex
CREATE INDEX "SettlementLine_store_idx" ON "SettlementLine"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_settlementId_key" ON "Reconciliation"("settlementId");

-- CreateIndex
CREATE INDEX "Reconciliation_range_idx" ON "Reconciliation"("tenantId", "scopeKind", "rangeStart");

-- CreateIndex
CREATE INDEX "Reconciliation_store_idx" ON "Reconciliation"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationException_uq" ON "ReconciliationException"("reconciliationId", "refKey");

-- CreateIndex
CREATE INDEX "ReconciliationException_list_idx" ON "ReconciliationException"("tenantId", "reconciliationId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationException_sort_idx" ON "ReconciliationException"("reconciliationId", "absAmount");

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FbaSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FbaSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "Reconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_category_check" CHECK ("category" IN ('INCOME', 'FEE', 'REFUND', 'REIMBURSEMENT', 'ADJUSTMENT', 'RESERVE'));
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_scope_check" CHECK ("scopeKind" IN ('DATE', 'SETTLEMENT'));
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_status_check" CHECK ("status" IN ('PENDING', 'MATCHED', 'DISCREPANCY'));
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_kind_check" CHECK ("kind" IN ('AMOUNT_MISMATCH', 'REPORT_ONLY', 'API_ONLY', 'ORDER_MISSING', 'SELF_CHECK'));
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_category_check" CHECK ("category" IN ('TIMING', 'ATTRIBUTION', 'SCOPE', 'UNEXPLAINED'));
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED'));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['SettlementLine', 'Reconciliation', 'ReconciliationException'] LOOP
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
