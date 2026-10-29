-- M-P6-03 表格视图：服务端保存的视图与筛选方案（取代 P6-02 的“隐藏列只存本机”）。
-- 依据：14 章 P6-03，15 章第 6 节，freeze/models.md 第二十一节（GridView，P6-04 的筛选方案共用本表）。
--
-- 内容：
--   一、新表 GridView：每行是一个视图（kind=VIEW）或筛选方案（kind=FILTER）。
--      scope=SYSTEM 系统视图（租户成员只读，由迁移或系统任务写入）、USER 个人（ownerUserId 为本人）、TEAM 团队共享（需要 grid.view.share 才能写）。
--      config 存列显示、顺序、列宽、固定、排序、筛选、维度；version 做乐观锁；createdBy 记创建人（团队视图展示用，不参与权限）。
--   二、约束：kind、scope、名称长度、版本；“USER 必有所有者、其他必无所有者”的一致性检查。
--   三、部分唯一索引：
--      个人视图同表格同类型同名唯一；团队与系统视图同表格同类型同名唯一；
--      每人每个表格每类型至多一个个人默认；每个表格每类型至多一个团队默认、至多一个系统默认。
--   四、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入 GridView）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表；所有人保存的视图会丢失，各表格回到页面自带的默认列）。

-- CreateTable
CREATE TABLE "GridView" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "gridId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'VIEW',
    "scope" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "createdBy" TEXT,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GridView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GridView_tenantId_gridId_kind_idx" ON "GridView"("tenantId", "gridId", "kind");

-- AddForeignKey
ALTER TABLE "GridView" ADD CONSTRAINT "GridView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 取值与一致性约束
ALTER TABLE "GridView" ADD CONSTRAINT "GridView_kind_check" CHECK ("kind" IN ('VIEW', 'FILTER'));
ALTER TABLE "GridView" ADD CONSTRAINT "GridView_scope_check" CHECK ("scope" IN ('SYSTEM', 'USER', 'TEAM'));
ALTER TABLE "GridView" ADD CONSTRAINT "GridView_owner_check" CHECK (("scope" = 'USER' AND "ownerUserId" IS NOT NULL) OR ("scope" <> 'USER' AND "ownerUserId" IS NULL));
ALTER TABLE "GridView" ADD CONSTRAINT "GridView_name_check" CHECK (char_length("name") BETWEEN 1 AND 40);
ALTER TABLE "GridView" ADD CONSTRAINT "GridView_version_check" CHECK ("version" >= 1);

-- 同名唯一（部分唯一索引：Prisma 模型表达不了，migrate diff 不比较部分索引）
CREATE UNIQUE INDEX "GridView_user_name_key" ON "GridView"("tenantId", "gridId", "kind", "ownerUserId", "name") WHERE "scope" = 'USER';
CREATE UNIQUE INDEX "GridView_shared_name_key" ON "GridView"("tenantId", "gridId", "kind", "scope", "name") WHERE "scope" <> 'USER';

-- 至多一个默认
CREATE UNIQUE INDEX "GridView_user_default_key" ON "GridView"("tenantId", "gridId", "kind", "ownerUserId") WHERE "scope" = 'USER' AND "isDefault";
CREATE UNIQUE INDEX "GridView_shared_default_key" ON "GridView"("tenantId", "gridId", "kind", "scope") WHERE "scope" <> 'USER' AND "isDefault";

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  ALTER TABLE "GridView" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "GridView" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "GridView" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "GridView" TO nova_system;
  END IF;
END $$;
