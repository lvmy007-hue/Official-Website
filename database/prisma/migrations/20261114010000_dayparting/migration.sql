-- M-P3-12 分时策略：新增 DaypartingStrategy（策略）与 DaypartingRun（执行记录）。
-- 依据：freeze/models.md M-P3-12、08 章 8.9、14 章 P3-12。
--
-- 内容：
--   一、DaypartingStrategy：系统自己的数据（同步器从不写）。属于一个广告档案，作用对象是同档案下的活动或广告组（scopeJson.ids 是系统编号），
--      hourlyMultipliersJson 是 168 个数（周一 0 点起，7 × 24 个小时格）：竞价系数策略取 0.1 至 3，启停策略取 1（启用）或 0（暂停）。带乐观锁 version。
--   二、DaypartingRun：每次调度对每个对象一行。executed 表示是否真的写到了亚马逊；outcome 为 APPLIED / SKIPPED / FAILED。
--      本迁移之后没有任何程序写这张表（执行器随 P3-17 广告写入接入），表是空的。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：冻结的 DaypartingStrategy 按店铺（storeId）建键，这里按广告档案（档案可能没绑店铺，范围过滤经 AdsProfile.sellerAccountId）；
--   多了 kind、targetLevel、baseBid、version、createdBy、updatedBy；DaypartingRun 的 campaignId 改成 entityId（活动或广告组系统编号），多了 outcome、message。
--
-- 回滚方法：见同目录 rollback.sql（删除两张表；策略是用户配置，回滚前请先导出）。

-- CreateTable
CREATE TABLE "DaypartingStrategy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetLevel" TEXT NOT NULL,
    "scopeJson" JSONB NOT NULL,
    "hourlyMultipliersJson" JSONB NOT NULL,
    "baseBid" DECIMAL(20,6),
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DaypartingStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DaypartingRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "appliedMultiplier" DECIMAL(8,4) NOT NULL,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL,
    "message" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaypartingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DaypartingStrategy_uq" ON "DaypartingStrategy"("tenantId", "adsProfileId", "name");

-- CreateIndex
CREATE INDEX "DaypartingStrategy_profile_idx" ON "DaypartingStrategy"("adsProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "DaypartingRun_uq" ON "DaypartingRun"("strategyId", "entityId", "runAt");

-- CreateIndex
CREATE INDEX "DaypartingRun_tenant_idx" ON "DaypartingRun"("tenantId", "runAt");

-- AddForeignKey
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "DaypartingStrategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_kind_check" CHECK ("kind" IN ('BID_MULTIPLIER', 'ON_OFF'));
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_level_check" CHECK ("targetLevel" IN ('CAMPAIGN', 'AD_GROUP'));
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED'));
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_version_check" CHECK ("version" >= 1);
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_grid_check" CHECK (
  jsonb_typeof("hourlyMultipliersJson") = 'array' AND jsonb_array_length("hourlyMultipliersJson") = 168
);
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_scope_check" CHECK (jsonb_typeof("scopeJson") = 'object');
ALTER TABLE "DaypartingStrategy" ADD CONSTRAINT "DaypartingStrategy_base_check" CHECK (
  "baseBid" IS NULL OR ("baseBid" > 0 AND "kind" = 'BID_MULTIPLIER')
);
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_outcome_check" CHECK ("outcome" IN ('APPLIED', 'SKIPPED', 'FAILED'));
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_hour_check" CHECK ("hour" >= 0 AND "hour" <= 23);
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_executed_check" CHECK ("executed" = false OR "outcome" = 'APPLIED');

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['DaypartingStrategy', 'DaypartingRun'] LOOP
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
