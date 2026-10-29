-- M-P6-11 装箱单自动匹配 SKU：外部货号映射与供应商装箱单列映射。
-- 依据：14 章 P6-11，16 章第 5.1 节，freeze/models.md 第二十一节（SkuAlias、PackingListMapping）。
--
-- 内容：
--   一、新表 SkuAlias：供应商装箱单里的外部货号（或条码、品名）对应到我们的 SKU。supplierId 为空是通用映射。
--      唯一键 (tenantId, supplierId, externalCode)；supplierId 为空时 PostgreSQL 把空值视为互不相同，所以另建部分唯一索引兜底（Prisma 模型表达不了）。
--      source = MANUAL 或 IMPORT；version 做乐观锁；sku 是卖家 SKU（属于店铺，同一 SKU 可在多个店铺，所以不加外键）。
--   二、新表 PackingListMapping：每个供应商一份装箱单列映射。columns 是“标准列 → 表头文字”的 JSON 对象，units 是尺寸与重量单位（可空）。
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入这两张表）。
--
-- 回滚方法：见同目录 rollback.sql（删除两张表；已经写进装箱草稿的箱子不受影响）。

-- CreateTable
CREATE TABLE "SkuAlias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT,
    "externalCode" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkuAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackingListMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "units" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackingListMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuAlias_uq" ON "SkuAlias"("tenantId", "supplierId", "externalCode");

-- CreateIndex
CREATE INDEX "SkuAlias_sku_idx" ON "SkuAlias"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "SkuAlias_supplier_idx" ON "SkuAlias"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PackingListMapping_uq" ON "PackingListMapping"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "PackingListMapping_supplier_idx" ON "PackingListMapping"("supplierId");

-- AddForeignKey
ALTER TABLE "SkuAlias" ADD CONSTRAINT "SkuAlias_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuAlias" ADD CONSTRAINT "SkuAlias_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingListMapping" ADD CONSTRAINT "PackingListMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingListMapping" ADD CONSTRAINT "PackingListMapping_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 通用映射（供应商为空）的唯一性：同一企业同一外部货号只能有一条
CREATE UNIQUE INDEX "SkuAlias_global_key" ON "SkuAlias"("tenantId", "externalCode") WHERE "supplierId" IS NULL;

-- 取值与长度约束
ALTER TABLE "SkuAlias" ADD CONSTRAINT "SkuAlias_check" CHECK (
  "source" IN ('MANUAL', 'IMPORT')
  AND char_length("externalCode") BETWEEN 1 AND 120
  AND char_length("sku") BETWEEN 1 AND 120
  AND "version" >= 1);

ALTER TABLE "PackingListMapping" ADD CONSTRAINT "PackingListMapping_check" CHECK (
  jsonb_typeof("columns") = 'object'
  AND ("units" IS NULL OR jsonb_typeof("units") = 'object')
  AND "version" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['SkuAlias', 'PackingListMapping'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', t);
    END IF;
  END LOOP;
END $$;
