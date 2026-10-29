-- M-P6-33 自定义仪表盘
-- 依据：14 章 P6-33；16 章第 2.3 节；freeze/models.md DashboardFolder、Dashboard、DashboardWidget。
--
-- 内容：
--   一、DashboardFolder：个人文件夹树，上级删除时子文件夹一并删除；
--   二、Dashboard：网格布局、是否共享、自动刷新分钟（空表示不刷新，最快 5 分钟）；
--   三、DashboardWidget：七种组件，query 绑定已有数据源；
--   四、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除三张表；已保存的仪表盘丢失）。

CREATE TABLE "DashboardFolder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardFolder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "folderId" TEXT,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "layout" JSONB NOT NULL,
    "refreshMinutes" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DashboardWidget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardWidget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DashboardFolder_name_uq" ON "DashboardFolder"("tenantId", "ownerId", "parentId", "name");
CREATE INDEX "DashboardFolder_parent_idx" ON "DashboardFolder"("parentId");
CREATE INDEX "DashboardFolder_owner_idx" ON "DashboardFolder"("tenantId", "ownerId");
CREATE UNIQUE INDEX "Dashboard_name_uq" ON "Dashboard"("tenantId", "ownerId", "folderId", "name");
CREATE INDEX "Dashboard_folder_idx" ON "Dashboard"("folderId");
CREATE INDEX "Dashboard_owner_idx" ON "Dashboard"("tenantId", "ownerId");
CREATE INDEX "Dashboard_shared_idx" ON "Dashboard"("tenantId", "shared");
CREATE INDEX "DashboardWidget_dash_idx" ON "DashboardWidget"("tenantId", "dashboardId");
CREATE INDEX "DashboardWidget_dashfk_idx" ON "DashboardWidget"("dashboardId");

ALTER TABLE "DashboardFolder" ADD CONSTRAINT "DashboardFolder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardFolder" ADD CONSTRAINT "DashboardFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DashboardFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "DashboardFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DashboardFolder" ADD CONSTRAINT "DashboardFolder_name_check" CHECK (char_length("name") BETWEEN 1 AND 40);
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_name_check" CHECK (char_length("name") BETWEEN 1 AND 40);
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_refresh_check" CHECK ("refreshMinutes" IS NULL OR ("refreshMinutes" >= 5 AND "refreshMinutes" <= 1440));
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_type_check" CHECK ("type" IN ('METRIC_CARD', 'LINE', 'BAR', 'HORIZONTAL_BAR', 'PIE', 'TABLE', 'TEXT'));

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['DashboardFolder', 'Dashboard', 'DashboardWidget'] LOOP
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
