-- M-P2b-13 期间关账。
-- 依据：freeze/models.md M-P2b-13（AccountingPeriod、PeriodSnapshot）；07 章 7.12；09 章 9.12 第 2 条与 9.13（期间关账后汇率锁定）；14 章 P2b-13。
--
-- 内容：
--   一、新表 AccountingPeriod：一个店铺一个自然月一行，状态 OPEN、CLOSING、CLOSED、REOPENED，带版本号（乐观锁），记录检查、审批、关账、重新开账各一步的人与时间。
--   二、新表 PeriodSnapshot：每次关账锁定写一份（利润日表、汇率、成本版本三份快照 + 与上一修订的差异报告），只追加。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 汇率锁定用的是已有的 FxRate.lockedByPeriodId 与触发器 FxRate_locked（M-P1-28），本迁移不改它们。
-- 与冻结的出入：冻结没写审批与检查的留痕列、版本号与关账次数，这里补上；PeriodSnapshot 多了修订号 revision 与差异报告 diffJson（重新开账后可再关账）。
--
-- 回滚方法：见同目录 rollback.sql（删两张表；关账记录与快照是业务凭证，回滚前请先导出；回滚不会解除 FxRate 上已有的 lockedByPeriodId，见说明）。

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "checklistJson" JSONB NOT NULL DEFAULT '{}',
    "checkedBy" TEXT,
    "checkedAt" TIMESTAMP(3),
    "approvalDecision" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalComment" TEXT,
    "closeCount" INTEGER NOT NULL DEFAULT 0,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "reopenedBy" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "profitSnapshotJson" JSONB NOT NULL,
    "fxSnapshotJson" JSONB NOT NULL,
    "costVersionSnapshotJson" JSONB NOT NULL,
    "diffJson" JSONB,
    "lockedBy" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_uq" ON "AccountingPeriod"("tenantId", "sellerAccountId", "periodStart");

-- CreateIndex
CREATE INDEX "AccountingPeriod_store_idx" ON "AccountingPeriod"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodSnapshot_uq" ON "PeriodSnapshot"("periodId", "revision");

-- CreateIndex
CREATE INDEX "PeriodSnapshot_tenant_idx" ON "PeriodSnapshot"("tenantId", "lockedAt");

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodSnapshot" ADD CONSTRAINT "PeriodSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodSnapshot" ADD CONSTRAINT "PeriodSnapshot_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_status_check" CHECK ("status" IN ('OPEN', 'CLOSING', 'CLOSED', 'REOPENED'));
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_range_check" CHECK ("periodEnd" >= "periodStart");
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_version_check" CHECK ("version" >= 1 AND "closeCount" >= 0);
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_decision_check" CHECK ("approvalDecision" IS NULL OR "approvalDecision" IN ('APPROVED', 'REJECTED'));
ALTER TABLE "PeriodSnapshot" ADD CONSTRAINT "PeriodSnapshot_revision_check" CHECK ("revision" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AccountingPeriod', 'PeriodSnapshot'] LOOP
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
