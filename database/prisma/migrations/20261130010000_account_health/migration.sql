-- M-P5-02 账户健康。
-- 依据：freeze/models.md 账户健康（AccountHealthSnapshot、PolicyIssue）；09 章 9.2；14 章 P5-02；importers.md R-42（卖家表现报告）、N-17（账户状态变更推送）。
--
-- 内容：
--   一、新表：AccountHealthSnapshot（店铺 × 日期 × 指标的快照）、PolicyIssue（政策合规问题，带负责人与处理状态，乐观锁）。
--   二、检查约束、行级安全与授权（与其他租户表一致）。
--
-- 与冻结的出入（详见 CR-092）：AccountHealthSnapshot 多了 marketplaceId、metricGroup、accountStatus、targetCondition、unit、windowDays、detailJson、source；
--   账户状态变更历史不单独建表，由 ACCOUNT_STATUS 快照按日取变化点得到；PolicyIssue 多了 marketplaceId、firstSeenAt、lastSeenAt、resolvedAt、
--   affectedAsinsJson、impactText、detailJson、handlingStatus、handlingNote、amazonCaseId、version（人工处理字段同步时不覆盖）。
-- 回滚方法：见同目录 rollback.sql（删除两张新表；快照与问题是亚马逊数据的只读副本，下一次同步会重新留存，
--   但历史趋势与人工处理记录（负责人、处理状态、备注、关联案件）会丢失）。

-- CreateTable
CREATE TABLE "AccountHealthSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "snapshotDate" DATE NOT NULL,
    "metricKey" TEXT NOT NULL,
    "metricGroup" TEXT NOT NULL,
    "accountStatus" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "value" DECIMAL(20,6),
    "target" DECIMAL(20,6),
    "targetCondition" TEXT,
    "unit" TEXT,
    "windowDays" INTEGER,
    "detailJson" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'REPORT',
    "sourceReportJobId" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "issueId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "affectedAsinsJson" JSONB NOT NULL DEFAULT '[]',
    "impactText" TEXT,
    "detailJson" JSONB NOT NULL DEFAULT '{}',
    "ownerUserId" TEXT,
    "handlingStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "handlingNote" TEXT,
    "amazonCaseId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceReportJobId" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountHealthSnapshot_metric_idx" ON "AccountHealthSnapshot"("tenantId", "sellerAccountId", "metricKey", "snapshotDate");

-- CreateIndex
CREATE INDEX "AccountHealthSnapshot_store_idx" ON "AccountHealthSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountHealthSnapshot_uq" ON "AccountHealthSnapshot"("tenantId", "sellerAccountId", "snapshotDate", "metricKey");

-- CreateIndex
CREATE INDEX "PolicyIssue_status_idx" ON "PolicyIssue"("tenantId", "status", "firstSeenAt");

-- CreateIndex
CREATE INDEX "PolicyIssue_owner_idx" ON "PolicyIssue"("tenantId", "ownerUserId");

-- CreateIndex
CREATE INDEX "PolicyIssue_store_idx" ON "PolicyIssue"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyIssue_uq" ON "PolicyIssue"("tenantId", "sellerAccountId", "issueId");

-- AddForeignKey
ALTER TABLE "AccountHealthSnapshot" ADD CONSTRAINT "AccountHealthSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHealthSnapshot" ADD CONSTRAINT "AccountHealthSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyIssue" ADD CONSTRAINT "PolicyIssue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyIssue" ADD CONSTRAINT "PolicyIssue_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：指标分组、账户状态、指标状态、来源、问题类型与处理状态的取值；窗口天数为正；乐观锁版本从 1 起
ALTER TABLE "AccountHealthSnapshot" ADD CONSTRAINT "AccountHealthSnapshot_check" CHECK (
  "metricGroup" IN ('STATUS', 'RATING', 'ORDER_DEFECT', 'POLICY', 'OTHER')
  AND "accountStatus" IN ('NORMAL', 'AT_RISK', 'DEACTIVATED')
  AND "status" IN ('MET', 'NOT_MET', 'UNKNOWN')
  AND "source" IN ('REPORT', 'PUSH')
  AND ("targetCondition" IS NULL OR "targetCondition" IN ('LT', 'LTE', 'GT', 'GTE', 'EQ'))
  AND ("windowDays" IS NULL OR "windowDays" > 0)
);
ALTER TABLE "PolicyIssue" ADD CONSTRAINT "PolicyIssue_check" CHECK (
  "kind" IN ('IP_COMPLAINT', 'AUTHENTICITY', 'PRODUCT_SAFETY', 'LISTING_POLICY', 'RESTRICTED_PRODUCT', 'REVIEW_POLICY', 'CONDITION', 'OTHER')
  AND "status" IN ('OPEN', 'RESOLVED')
  AND "handlingStatus" IN ('OPEN', 'IN_PROGRESS', 'DONE')
  AND "version" >= 1
  AND ("status" = 'OPEN' OR "resolvedAt" IS NOT NULL)
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AccountHealthSnapshot', 'PolicyIssue'] LOOP
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
