-- M-P2a-14 商品目录同步（ASIN 360 身份区的图片、品牌、类目、父体、销售排名）。
-- 依据：freeze/models.md M-P2a-14；freeze/importers.md I-09；05 章 5.2；14 章 P2a-14。
--
-- 内容：
--   一、FbaProduct 增加 7 列：parentAsin、imageUrl、categoryPath、ownerUserId、tagIds（冻结模型的 5 列）、
--       catalogStatus（目录里找到/找不到该 ASIN，对应 I-09 的 CAT_ASIN_NOT_FOUND“标记待核实”）、catalogSyncedAt（最近一次目录核对时间）。
--   二、新增 ProductVariantRelation（父子变体关系）与 SalesRankSnapshot（销售排名快照，按日留存）。
--   三、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql。本迁移不修改、不删除任何既有数据。

-- AlterTable
ALTER TABLE "FbaProduct" ADD COLUMN "parentAsin" TEXT,
ADD COLUMN "imageUrl" TEXT,
ADD COLUMN "categoryPath" TEXT,
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "tagIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "catalogStatus" TEXT,
ADD COLUMN "catalogSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProductVariantRelation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "parentAsin" TEXT NOT NULL,
    "childAsin" TEXT NOT NULL,
    "variationTheme" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariantRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesRankSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "classificationId" TEXT NOT NULL,
    "classificationName" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesRankSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVariantRelation_store_idx" ON "ProductVariantRelation"("sellerAccountId");

-- CreateIndex
CREATE INDEX "ProductVariantRelation_child_idx" ON "ProductVariantRelation"("tenantId", "sellerAccountId", "childAsin");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariantRelation_uq" ON "ProductVariantRelation"("tenantId", "sellerAccountId", "parentAsin", "childAsin");

-- CreateIndex
CREATE INDEX "SalesRankSnapshot_store_idx" ON "SalesRankSnapshot"("sellerAccountId");

-- CreateIndex
CREATE INDEX "SalesRankSnapshot_asin_idx" ON "SalesRankSnapshot"("tenantId", "sellerAccountId", "asin", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesRankSnapshot_uq" ON "SalesRankSnapshot"("tenantId", "sellerAccountId", "asin", "classificationId", "snapshotDate");

-- AddForeignKey
ALTER TABLE "ProductVariantRelation" ADD CONSTRAINT "ProductVariantRelation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantRelation" ADD CONSTRAINT "ProductVariantRelation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRankSnapshot" ADD CONSTRAINT "SalesRankSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesRankSnapshot" ADD CONSTRAINT "SalesRankSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：目录状态只有两种；排名是正整数；子体不能等于父体
ALTER TABLE "FbaProduct" ADD CONSTRAINT "FbaProduct_catalogStatus_check" CHECK ("catalogStatus" IS NULL OR "catalogStatus" IN ('FOUND', 'NOT_FOUND'));
ALTER TABLE "SalesRankSnapshot" ADD CONSTRAINT "SalesRankSnapshot_rank_check" CHECK ("rank" > 0);
ALTER TABLE "ProductVariantRelation" ADD CONSTRAINT "ProductVariantRelation_self_check" CHECK ("parentAsin" <> "childAsin");

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ProductVariantRelation', 'SalesRankSnapshot'] LOOP
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
