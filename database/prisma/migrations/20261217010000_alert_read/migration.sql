-- M-P6-15 预警已读状态：按用户记录“这条预警我看过了”，与处理状态互不影响。
-- 依据：14 章 P6-15，16 章第 9 节，freeze/models.md 第二十一节（AlertRead；AlertInstance 不新增列，合并计数复用 triggerCount 与 lastTriggeredAt）。
--
-- 内容：
--   一、新表 AlertRead：(alertId, userId) 唯一，一个人对一条预警至多一行；预警删除时连带删除；
--      不对用户设外键（成员被移除后留下的已读记录无害，随预警清理）。
--   二、索引 (tenantId, userId)：顶栏未读数按“我已读的预警编号”做差集时走它。
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表；所有人的已读记录丢失，预警回到“全部未读”，预警本身与处理状态不受影响）。

-- CreateTable
CREATE TABLE "AlertRead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlertRead_alertId_userId_key" ON "AlertRead"("alertId", "userId");
CREATE INDEX "AlertRead_tenantId_userId_idx" ON "AlertRead"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "AlertRead" ADD CONSTRAINT "AlertRead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertRead" ADD CONSTRAINT "AlertRead_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "AlertInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 用户编号不能为空串
ALTER TABLE "AlertRead" ADD CONSTRAINT "AlertRead_check" CHECK (char_length("userId") >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "AlertRead" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "AlertRead" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "AlertRead" TO nova_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "AlertRead" TO nova_system';
  END IF;
END $$;
