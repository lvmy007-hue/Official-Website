-- M-P6-16 预警规则：条件构造器、通知频率、多级升级、汇总批次
-- 依据：14 章 P6-16；16 章第 9 节；freeze/models.md 第二十一节（AlertRule 加三列，新表 AlertDigest）。
--
-- 内容：
--   一、AlertRule 增加 conditionGroups（自定义指标规则的条件）、notifyFrequency（IMMEDIATE / HOURLY / DAILY，默认 IMMEDIATE）、escalation（多级升级，最多 3 级）；
--       旧规则的通知频率自动是“立即”，没有条件、没有升级，行为不变。
--   二、新表 AlertDigest：汇总批次与升级记录；(tenantId, dedupKey) 唯一，多个后台进程同时扫描时靠它认领，每批只发一次、每级升级只发一次。
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表与新增的三列；自定义指标规则会因此丢失条件，请先停用或删除这些规则再回滚）。

-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN "conditionGroups" JSONB;
ALTER TABLE "AlertRule" ADD COLUMN "notifyFrequency" TEXT NOT NULL DEFAULT 'IMMEDIATE';
ALTER TABLE "AlertRule" ADD COLUMN "escalation" JSONB;

ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_notifyFrequency_check" CHECK ("notifyFrequency" IN ('IMMEDIATE', 'HOURLY', 'DAILY'));
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_escalation_check" CHECK ("escalation" IS NULL OR (jsonb_typeof("escalation") = 'array' AND jsonb_array_length("escalation") <= 3));
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_conditionGroups_check" CHECK ("conditionGroups" IS NULL OR jsonb_typeof("conditionGroups") = 'object');

-- CreateTable
CREATE TABLE "AlertDigest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "alertIds" JSONB NOT NULL DEFAULT '[]',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlertDigest_tenantId_dedupKey_key" ON "AlertDigest"("tenantId", "dedupKey");
CREATE INDEX "AlertDigest_tenantId_status_kind_idx" ON "AlertDigest"("tenantId", "status", "kind");
CREATE INDEX "AlertDigest_ruleId_idx" ON "AlertDigest"("ruleId");

-- AddForeignKey
ALTER TABLE "AlertDigest" ADD CONSTRAINT "AlertDigest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertDigest" ADD CONSTRAINT "AlertDigest_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 批次类型、状态与计数的约束
ALTER TABLE "AlertDigest" ADD CONSTRAINT "AlertDigest_kind_check" CHECK ("kind" IN ('FREQUENCY', 'QUIET', 'ESCALATION'));
ALTER TABLE "AlertDigest" ADD CONSTRAINT "AlertDigest_status_check" CHECK ("status" IN ('PENDING', 'SENT'));
ALTER TABLE "AlertDigest" ADD CONSTRAINT "AlertDigest_count_check" CHECK ("itemCount" >= 0 AND jsonb_typeof("alertIds") = 'array');
ALTER TABLE "AlertDigest" ADD CONSTRAINT "AlertDigest_sent_check" CHECK (("status" = 'SENT') = ("sentAt" IS NOT NULL));

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "AlertDigest" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "AlertDigest" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "AlertDigest" TO nova_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "AlertDigest" TO nova_system';
  END IF;
END $$;
