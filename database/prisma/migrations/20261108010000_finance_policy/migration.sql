-- M-P2b-15 财务口径设置。
-- 依据：freeze/models.md M-P2b-15（FinancePolicyVersion）；09 章 9.12 第 2 个页签；permissions.md 第七节第 3 条（发起人与审批人不能是同一人）；14 章 P2b-15。
--
-- 内容：
--   一、新表 FinancePolicyVersion：每次口径修改一行，只追加；状态 PENDING（待审批）、ACTIVE（生效中）、REPLACED（已替换）、REJECTED（驳回或撤回）。
--   二、检查约束（状态与各口径取值、版本号）与行级安全授权（与其他租户表一致）。
-- 不做数据迁移：没有版本时系统用默认口径（下单口径、先进先出、销售日汇率、按销售额分摊），与现有计算一致；
-- 审批通过时由 API 把存货计价同步写入企业设置 finance.inventoryCosting（worker 的利润计价读它），所以本迁移不碰 TenantSetting。
-- 与冻结的出入：冻结没有收入确认口径与店铺级费用分摊两列（9.12 要求有），这里补上；冻结的 feeCategoryMapJson 没有实现（费用分类规则在 api-contracts 里是代码，不是可配置项）；
--   冻结的存货计价写“加权平均/先进先出”，实现沿用利润日表已有的三种（先进先出、移动加权平均、月末加权平均）；冻结的状态是草稿/生效/已替换，这里的“待审批”对应草稿，另加“已驳回或撤回”。
--
-- 回滚方法：见同目录 rollback.sql（删表；口径版本是审批凭证，回滚前请先导出；回滚不会改动企业设置 finance.inventoryCosting）。

-- CreateTable
CREATE TABLE "FinancePolicyVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "revenueRecognition" TEXT NOT NULL,
    "inventoryCostMethod" TEXT NOT NULL,
    "fxRateRule" TEXT NOT NULL DEFAULT 'SALE_DAY',
    "adsAllocationMode" TEXT NOT NULL,
    "storeFeeAllocation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "replacedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancePolicyVersion_uq" ON "FinancePolicyVersion"("tenantId", "versionNo");

-- CreateIndex
CREATE INDEX "FinancePolicyVersion_status_idx" ON "FinancePolicyVersion"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "FinancePolicyVersion" ADD CONSTRAINT "FinancePolicyVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "FinancePolicyVersion" ADD CONSTRAINT "FinancePolicyVersion_status_check" CHECK ("status" IN ('PENDING', 'ACTIVE', 'REPLACED', 'REJECTED'));
ALTER TABLE "FinancePolicyVersion" ADD CONSTRAINT "FinancePolicyVersion_values_check" CHECK (
  "revenueRecognition" IN ('ORDERED', 'SHIPPED', 'SETTLED')
  AND "inventoryCostMethod" IN ('FIFO', 'MOVING_AVG', 'MONTH_AVG')
  AND "fxRateRule" IN ('SALE_DAY')
  AND "adsAllocationMode" IN ('BY_SALES', 'BY_UNITS')
  AND "storeFeeAllocation" IN ('BY_SALES', 'BY_UNITS')
);
ALTER TABLE "FinancePolicyVersion" ADD CONSTRAINT "FinancePolicyVersion_version_check" CHECK ("version" >= 1 AND "versionNo" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['FinancePolicyVersion'] LOOP
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
