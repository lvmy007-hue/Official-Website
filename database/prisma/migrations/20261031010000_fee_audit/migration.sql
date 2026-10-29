-- M-P2b-06 费用核查。
-- 依据：freeze/models.md M-P2b-06（FeeAudit）；07 章 7.6；14 章 P2b-06；importers.md R-23、R-24。
--
-- 内容：
--   一、新表：FeeBaseline（费用核查基准快照：R-23 预估配送费报告与 R-24 佣金预览报告每天一行，含亚马逊测量尺寸与尺寸分段）、
--       FeeAudit（核查结果：配送费、佣金、仓储费、入仓配置费四类，一行 = 一个核查对象在一个核查日的结果）。
--   二、检查约束：核查类别与状态取值、金额与次数非负；行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除两张新表。两张表都是派生数据：基准快照由报告每天重新导入，核查结果由后台任务重算；
-- 但“已转为赔付机会”的标记（status = APPEALED、opportunityId）会丢失——赔付机会本身在赔付机会表里不受影响，下一次核查会按去重键重新认出它）。

-- CreateTable
CREATE TABLE "FeeBaseline" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "snapshotDate" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sizeTier" TEXT,
    "prevSizeTier" TEXT,
    "lengthCm" DECIMAL(12,4),
    "widthCm" DECIMAL(12,4),
    "heightCm" DECIMAL(12,4),
    "weightKg" DECIMAL(12,4),
    "salesPrice" DECIMAL(20,6),
    "expectedFulfillmentFee" DECIMAL(20,6),
    "expectedReferralFee" DECIMAL(20,6),
    "sourceReportJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeAudit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "feeKind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "sku" TEXT,
    "asin" TEXT,
    "shipmentRef" TEXT,
    "snapshotDate" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "expectedAmount" DECIMAL(20,6) NOT NULL,
    "actualAmount" DECIMAL(20,6) NOT NULL,
    "diffAmount" DECIMAL(20,6) NOT NULL,
    "overchargeAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "occurrences" INTEGER NOT NULL DEFAULT 0,
    "checkedCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'NORMAL',
    "basisJson" JSONB NOT NULL DEFAULT '{}',
    "opportunityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeBaseline_uq" ON "FeeBaseline"("sellerAccountId", "sku", "snapshotDate");

-- CreateIndex
CREATE INDEX "FeeBaseline_day_idx" ON "FeeBaseline"("tenantId", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "FeeAudit_uq" ON "FeeAudit"("sellerAccountId", "feeKind", "subjectKey", "snapshotDate");

-- CreateIndex
CREATE INDEX "FeeAudit_list_idx" ON "FeeAudit"("tenantId", "snapshotDate", "feeKind");

-- AddForeignKey
ALTER TABLE "FeeBaseline" ADD CONSTRAINT "FeeBaseline_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeBaseline" ADD CONSTRAINT "FeeBaseline_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeAudit" ADD CONSTRAINT "FeeAudit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeAudit" ADD CONSTRAINT "FeeAudit_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "FeeAudit" ADD CONSTRAINT "FeeAudit_kind_check" CHECK ("feeKind" IN ('FULFILLMENT', 'COMMISSION', 'STORAGE', 'INBOUND_PLACEMENT'));
ALTER TABLE "FeeAudit" ADD CONSTRAINT "FeeAudit_status_check" CHECK ("status" IN ('NORMAL', 'SUSPECTED', 'APPEALED'));
ALTER TABLE "FeeAudit" ADD CONSTRAINT "FeeAudit_count_check" CHECK ("occurrences" >= 0 AND "checkedCount" >= 0 AND "overchargeAmount" >= 0);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['FeeBaseline', 'FeeAudit'] LOOP
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
