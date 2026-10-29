-- M-P3-17 广告写入：新增 AdsWriteRun（广告写入记录）。
-- 依据：freeze/models.md M-P3-17、08 章开头“写入开关类别”、09 章 9.13、14 章 P3-17。
--
-- 内容：
--   一、AdsWriteRun：一行 = 一次对一个广告对象的写入（手动、自动规则、分时策略共用同一条流水线）。
--      接口服务受理时建（PENDING），后台任务调用亚马逊后回写（SUCCEEDED / FAILED）；
--      AdsChangeLog.writeRunId、AdsAutomationRun.writeRunId 存这张表的 id。
--   二、检查约束：写入类型、来源、对象类型、状态；状态与完成时间、失败码相配。
--   三、行级安全授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除该表；已写入亚马逊的修改不会撤销，只是丢失本系统里的写入记录）。

-- CreateTable
CREATE TABLE "AdsWriteRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "requestJson" JSONB NOT NULL,
    "beforeValue" TEXT,
    "afterValue" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "syncJobId" TEXT,
    "requestId" TEXT,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AdsWriteRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsWriteRun_tenant_idx" ON "AdsWriteRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AdsWriteRun_profile_idx" ON "AdsWriteRun"("adsProfileId");

-- CreateIndex
CREATE INDEX "AdsWriteRun_entity_idx" ON "AdsWriteRun"("tenantId", "entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_kind_check" CHECK ("kind" IN ('CAMPAIGN_STATE', 'CAMPAIGN_BUDGET', 'CAMPAIGN_BID_STRATEGY', 'CAMPAIGN_PLACEMENT', 'AD_GROUP_STATE', 'AD_GROUP_BID', 'TARGET_STATE', 'TARGET_BID', 'NEGATIVE_ADD', 'KEYWORD_ADD'));
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_source_check" CHECK ("source" IN ('MANUAL', 'AUTO_RULE', 'DAYPARTING'));
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_type_check" CHECK ("entityType" IN ('CAMPAIGN', 'AD_GROUP', 'TARGET'));
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'));
-- 已完成（成功或失败）的才有完成时间；失败码只属于失败
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_finish_check" CHECK (("status" IN ('SUCCEEDED', 'FAILED')) = ("finishedAt" IS NOT NULL));
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_failure_check" CHECK ("failureCode" IS NULL OR "status" = 'FAILED');
ALTER TABLE "AdsWriteRun" ADD CONSTRAINT "AdsWriteRun_request_check" CHECK (jsonb_typeof("requestJson") = 'object');

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AdsWriteRun'] LOOP
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

-- 四、修正写入开关变更记录的动作取值检查（发现于 P3-17 的真实库测试）：
--    接口与后台任务一直写入 ENABLED、DISABLED、AUTO_DISABLED（页面的动作名称表也是这三个），而原检查只允许 ENABLE、DISABLE、AUTO_DISABLE，
--    在真实数据库上开启、关闭、自动关闭开关时记录写入会被拒绝。这里在原取值之外补上代码实际使用的三个。
ALTER TABLE "IntegrationSwitchLog" DROP CONSTRAINT IF EXISTS "IntegrationSwitchLog_action_check";
ALTER TABLE "IntegrationSwitchLog" ADD CONSTRAINT "IntegrationSwitchLog_action_check" CHECK ("action" IN ('ENABLE', 'DISABLE', 'AUTO_DISABLE', 'ENABLED', 'DISABLED', 'AUTO_DISABLED', 'READONLY_ALL', 'EMERGENCY_OFF'));

-- 五、自动规则与分时策略的执行记录增加“已提交（QUEUED）”结果（写入提交后、亚马逊确认前），分时策略执行记录增加写入记录编号：
--    确认成功后改为 APPLIED 并记 executed，失败改为 FAILED；原来的检查（executed 为真则必须 APPLIED）不变。
ALTER TABLE "DaypartingRun" ADD COLUMN "writeRunId" TEXT;
ALTER TABLE "AdsAutomationRun" DROP CONSTRAINT IF EXISTS "AdsAutomationRun_outcome_check";
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_outcome_check" CHECK ("outcome" IN ('SUGGESTED', 'QUEUED', 'APPLIED', 'SKIPPED', 'FAILED'));
ALTER TABLE "DaypartingRun" DROP CONSTRAINT IF EXISTS "DaypartingRun_outcome_check";
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_outcome_check" CHECK ("outcome" IN ('QUEUED', 'APPLIED', 'SKIPPED', 'FAILED'));
CREATE INDEX "AdsAutomationRun_write_idx" ON "AdsAutomationRun"("writeRunId");
CREATE INDEX "DaypartingRun_write_idx" ON "DaypartingRun"("writeRunId");
