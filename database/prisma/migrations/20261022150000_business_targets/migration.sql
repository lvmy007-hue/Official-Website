-- M-P2a-04 经营目标（BusinessTarget）。
-- 依据：freeze/models.md 第七节；04 章 4.4；14 章 P2a-04。
--
-- 内容：
--   一、新增 1 张表：按店铺 × 期间（月/季/年）× 维度（整店/类目/ASIN 组）设置目标值，带版本号。
--      整店目标的 dimensionRef 固定为 'ALL'；类目目标存类目路径；ASIN 组目标存逗号分隔的 ASIN 列表。
--   二、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（只删除这一张表；目标值由人工在页面重新设置，不是派生数据，删除后不可恢复，回滚前请先导出）。
-- 本迁移只新增表，不修改、不删除任何既有对象。

CREATE TABLE "BusinessTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "periodKind" TEXT NOT NULL DEFAULT 'MONTH',
    "periodStart" DATE NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'STORE',
    "dimensionRef" TEXT NOT NULL DEFAULT 'ALL',
    "metric" TEXT NOT NULL,
    "targetValue" DECIMAL(20,6) NOT NULL,
    "paceMode" TEXT NOT NULL DEFAULT 'LINEAR',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessTarget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "business_target_value_check" CHECK ("targetValue" >= 0)
);

CREATE UNIQUE INDEX "business_target_cell_key" ON "BusinessTarget"("tenantId", "sellerAccountId", "periodKind", "periodStart", "dimension", "dimensionRef", "metric");
CREATE INDEX "BusinessTarget_tenantId_sellerAccountId_periodStart_idx" ON "BusinessTarget"("tenantId", "sellerAccountId", "periodStart");
CREATE INDEX "BusinessTarget_sellerAccountId_idx" ON "BusinessTarget"("sellerAccountId");

ALTER TABLE "BusinessTarget" ADD CONSTRAINT "BusinessTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessTarget" ADD CONSTRAINT "BusinessTarget_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['BusinessTarget'] LOOP
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
