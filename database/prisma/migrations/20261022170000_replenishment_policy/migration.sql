-- M-P2a-06 补货策略版本（ReplenishmentPolicy，企业级先行）。
-- 依据：freeze/models.md 第十一节 ReplenishmentPolicy；06 章 6.1“健康规则（规则带版本，不使用固定阈值）”；14 章 P2a-06。
--
-- 内容：
--   一、新增 1 张表：库存健康规则引擎的参数版本（提前期、上游仓储时效、安全库存天数、目标覆盖天数、冗余倍数、计入可售天数的在途类别、库龄风险起算天数）。
--      只增不改：每次保存新增一行，versionNo 递增；当前生效版本 = effectiveFrom 不晚于今天的最大 versionNo。
--      level 预留 TENANT / CATEGORY / SKU 三级（P2a-07 启用品类与 SKU 级），本包只写 TENANT / 'ALL'。
--   二、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（只删除这一张表；策略是人工设置的业务数据，删除后不可恢复，回滚前请先导出）。
-- 本迁移只新增表，不修改、不删除任何既有对象。

CREATE TABLE "ReplenishmentPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'TENANT',
    "levelRef" TEXT NOT NULL DEFAULT 'ALL',
    "versionNo" INTEGER NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "awdLeadTimeDays" INTEGER,
    "safetyDays" INTEGER NOT NULL,
    "coverageDays" INTEGER NOT NULL,
    "redundancyMultiplier" DECIMAL(6,2) NOT NULL,
    "inboundCounted" TEXT[],
    "agingFromDays" INTEGER NOT NULL DEFAULT 271,
    "effectiveFrom" DATE NOT NULL,
    "changeReason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplenishmentPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReplenishmentPolicy_level_check" CHECK ("level" IN ('TENANT', 'CATEGORY', 'SKU')),
    CONSTRAINT "ReplenishmentPolicy_version_check" CHECK ("versionNo" >= 1),
    CONSTRAINT "ReplenishmentPolicy_days_check" CHECK ("leadTimeDays" BETWEEN 1 AND 365 AND "safetyDays" BETWEEN 0 AND 365 AND "coverageDays" BETWEEN 1 AND 730 AND ("awdLeadTimeDays" IS NULL OR "awdLeadTimeDays" BETWEEN 1 AND 365)),
    CONSTRAINT "ReplenishmentPolicy_multiplier_check" CHECK ("redundancyMultiplier" >= 1 AND "redundancyMultiplier" <= 10),
    CONSTRAINT "ReplenishmentPolicy_inbound_check" CHECK ("inboundCounted" <@ ARRAY['WORKING', 'SHIPPED', 'RECEIVING']::TEXT[]),
    CONSTRAINT "ReplenishmentPolicy_aging_check" CHECK ("agingFromDays" IN (181, 271, 366))
);

CREATE UNIQUE INDEX "ReplenishmentPolicy_uq" ON "ReplenishmentPolicy"("tenantId", "level", "levelRef", "versionNo");
CREATE INDEX "ReplenishmentPolicy_effective_idx" ON "ReplenishmentPolicy"("tenantId", "level", "levelRef", "effectiveFrom");

ALTER TABLE "ReplenishmentPolicy" ADD CONSTRAINT "ReplenishmentPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ReplenishmentPolicy'] LOOP
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