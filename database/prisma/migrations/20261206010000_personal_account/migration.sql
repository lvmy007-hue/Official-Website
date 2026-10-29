-- M-P5-11 个人账号：通知偏好与个人免打扰。
-- 依据：09 章 9.15（含 CR-096 补充：按业务域与严重级别选择通知、个人免打扰时段、严重与升级穿透、结束后发汇总），14 章 P5-11。
--
-- 内容：
--   一、新表 UserPreference：每个成员在每个企业里一行，notifyJson 存通知偏好与免打扰时段，version 做乐观锁；
--      没有记录表示“全部接收、免打扰关闭”。行级安全与授权同其他租户表。
--   二、Notification 新增 domain（业务域，用于筛选与偏好判断）、silencedAt（免打扰期间收到的通知，不计入顶栏未读数）、
--      summarizedAt（时段结束后已并入汇总的时间）；并按通知类型回填旧通知的业务域（预警规则类通知当时没有记录规则的业务域，留空，页面显示“其他”）。
--   三、索引：(tenantId, userId, silencedAt, summarizedAt)，供未读数与免打扰汇总按成员取数。
-- 与冻结的出入：冻结的 models.md 没有 UserPreference（详见 CR-102）；P6-01 的收藏与密度计划在同一行补列。
--
-- 回滚方法：见同目录 rollback.sql（删除新表与新列；个人的通知偏好与免打扰设置会丢失，已写入的通知本身不受影响）。

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notifyJson" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_uq" ON "UserPreference"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 乐观锁版本从 1 起
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_check" CHECK ("version" >= 1);

-- Notification 新列
ALTER TABLE "Notification" ADD COLUMN "domain" TEXT;
ALTER TABLE "Notification" ADD COLUMN "silencedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "summarizedAt" TIMESTAMP(3);

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_domain_check" CHECK (
  "domain" IS NULL OR "domain" IN ('INVENTORY', 'FINANCE', 'AFTER_SALES', 'ADS', 'PRODUCT', 'WORK', 'SYSTEM')
);

-- 回填旧通知的业务域（与 api-contracts 的 notificationDomainOf 一致；预警规则类通知留空）
UPDATE "Notification" SET "domain" = CASE
  WHEN "kind" = 'ALERT_RULE' THEN NULL
  WHEN "kind" IN ('WORK_ASSIGNED', 'MENTION') OR "kind" LIKE 'WORK\_%' OR "kind" LIKE 'EXPORT\_%' THEN 'WORK'
  WHEN "kind" = 'PRICING' THEN 'PRODUCT'
  WHEN "kind" IN ('ADVERTISING', 'ADS_RULE') THEN 'ADS'
  ELSE 'SYSTEM'
END;

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_silencedAt_summarizedAt_idx" ON "Notification"("tenantId", "userId", "silencedAt", "summarizedAt");

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  ALTER TABLE "UserPreference" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "UserPreference" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "UserPreference" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "UserPreference" TO nova_system;
  END IF;
END $$;
