-- M-P3-13 广告自动规则：新增 AdsAutomationRule（规则）与 AdsAutomationRun（执行记录）。
-- 依据：freeze/models.md M-P3-13、08 章 8.10、14 章 P3-13。
--
-- 内容：
--   一、AdsAutomationRule：系统自己的数据（同步器从不写）。属于一个广告档案，level 是评估对象的层级（活动、投放词、搜索词），
--      scopeJson / conditionJson / actionJson / guardrailJson 是规则的四块内容（都是 JSON 对象），mode 是建议或自动执行，frequency 是执行频率。
--      lastRunAt、lastEvaluated、lastMatched 由定时评估回写（规则质量页的“最近一次命中率”）。带乐观锁 version。
--   二、AdsAutomationRun：每次定时评估对每个命中的对象一行。executed 表示是否真的写到了亚马逊；outcome 为 SUGGESTED / APPLIED / SKIPPED / FAILED。
--      workItemId 是建议模式生成的待办编号，不加外键（待办可被清理，执行记录要留着）。自动执行写亚马逊随 P3-17，之前没有 APPLIED 行。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：冻结的 AdsAutomationRule 按店铺（storeId）建键，这里按广告档案（档案可能没绑店铺，范围过滤经 AdsProfile.sellerAccountId）；
--   多了 level、frequency、guardrailJson、lastEvaluated、lastMatched、version、createdBy、updatedBy；
--   AdsAutomationRun 的 entityId 叫 entityKey（搜索词没有系统编号），beforeValue 与 afterValue 可空，多了 ruleVersion、entityLabel、actionType、outcome、message、workItemId、evidenceJson。
--
-- 回滚方法：见同目录 rollback.sql（删除两张表；规则是用户配置，回滚前请先导出）。

-- CreateTable
CREATE TABLE "AdsAutomationRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "scopeJson" JSONB NOT NULL,
    "conditionJson" JSONB NOT NULL,
    "actionJson" JSONB NOT NULL,
    "guardrailJson" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastEvaluated" INTEGER,
    "lastMatched" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsAutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsAutomationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "entityKey" TEXT NOT NULL,
    "entityLabel" TEXT,
    "actionType" TEXT NOT NULL,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL,
    "message" TEXT,
    "workItemId" TEXT,
    "evidenceJson" JSONB NOT NULL,
    "writeRunId" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsAutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdsAutomationRule_uq" ON "AdsAutomationRule"("tenantId", "adsProfileId", "name");

-- CreateIndex
CREATE INDEX "AdsAutomationRule_profile_idx" ON "AdsAutomationRule"("adsProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsAutomationRun_uq" ON "AdsAutomationRun"("ruleId", "entityKey", "runAt");

-- CreateIndex
CREATE INDEX "AdsAutomationRun_tenant_idx" ON "AdsAutomationRun"("tenantId", "runAt");

-- CreateIndex
CREATE INDEX "AdsAutomationRun_rule_idx" ON "AdsAutomationRun"("ruleId", "runAt");

-- AddForeignKey
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AdsAutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_level_check" CHECK ("level" IN ('CAMPAIGN', 'TARGET', 'SEARCH_TERM'));
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_mode_check" CHECK ("mode" IN ('SUGGEST', 'AUTO'));
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED'));
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_frequency_check" CHECK ("frequency" IN ('DAILY', 'EVERY_3_DAYS', 'WEEKLY'));
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_version_check" CHECK ("version" >= 1);
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_json_check" CHECK (
  jsonb_typeof("scopeJson") = 'object' AND jsonb_typeof("conditionJson") = 'object' AND jsonb_typeof("actionJson") = 'object' AND jsonb_typeof("guardrailJson") = 'object'
);
ALTER TABLE "AdsAutomationRule" ADD CONSTRAINT "AdsAutomationRule_scan_check" CHECK (
  ("lastEvaluated" IS NULL) = ("lastMatched" IS NULL)
  AND ("lastEvaluated" IS NULL OR ("lastEvaluated" >= 0 AND "lastMatched" >= 0 AND "lastMatched" <= "lastEvaluated"))
);
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_action_check" CHECK ("actionType" IN ('ADJUST_BID', 'ADJUST_BUDGET', 'PAUSE', 'ENABLE', 'NEGATE', 'ADD_KEYWORD'));
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_outcome_check" CHECK ("outcome" IN ('SUGGESTED', 'APPLIED', 'SKIPPED', 'FAILED'));
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_executed_check" CHECK ("executed" = false OR "outcome" = 'APPLIED');
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_evidence_check" CHECK (jsonb_typeof("evidenceJson") = 'object');
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_version_check" CHECK ("ruleVersion" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AdsAutomationRule', 'AdsAutomationRun'] LOOP
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
