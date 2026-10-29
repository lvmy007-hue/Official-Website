-- M-P4-12 竞品监控。
-- 依据：freeze/models.md 九、定价、竞品、评价与内容（WatchedAsin、CompetitorSnapshot）；05 章 5.6；14 章 P4-12；importers.md I-09、I-13（对关注的竞品 ASIN 调用同样的官方接口）。
--
-- 内容：
--   一、新表：WatchedAsin（关注清单：店铺 × 竞品 ASIN × 我方对应 ASIN）、CompetitorSnapshot（竞品快照：标题、品牌、图片数、价格、推荐报价状态、配送方式、会员资格、销售排名）。
--   二、检查约束、行级安全与授权（与其他租户表一致）。
--
-- 与冻结的出入（详见 CR-087）：WatchedAsin 多了 marketplaceId、note，ownAsin 用空串表示“没有指定我方对应商品”（唯一键里的空值在 PostgreSQL 里不算相同）；
--   CompetitorSnapshot 多了 imageCount、currency、rankClassificationId、rankClassificationName，featuredStatus 取 HAS_FEATURED / NONE；来源只有 SEARCH_TERM 与 MANUAL（官方竞争摘要不返回其他 ASIN）。
-- 回滚方法：见同目录 rollback.sql（删除两张新表；快照是亚马逊数据的只读副本，下一次同步会重新留存，但历史趋势会丢失；关注清单会丢失）。
-- CreateTable
CREATE TABLE "WatchedAsin" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "asin" TEXT NOT NULL,
    "ownAsin" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchedAsin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "asin" TEXT NOT NULL,
    "title" TEXT,
    "brand" TEXT,
    "imageCount" INTEGER,
    "price" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "featuredStatus" TEXT,
    "fulfillment" TEXT,
    "memberEligible" BOOLEAN,
    "rank" INTEGER,
    "rankClassificationId" TEXT,
    "rankClassificationName" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WatchedAsin_asin_idx" ON "WatchedAsin"("tenantId", "sellerAccountId", "asin");

-- CreateIndex
CREATE INDEX "WatchedAsin_store_idx" ON "WatchedAsin"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchedAsin_uq" ON "WatchedAsin"("tenantId", "sellerAccountId", "asin", "ownAsin");

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_asin_idx" ON "CompetitorSnapshot"("tenantId", "sellerAccountId", "asin", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_store_idx" ON "CompetitorSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorSnapshot_uq" ON "CompetitorSnapshot"("sellerAccountId", "marketplaceId", "asin", "observedAt");

-- AddForeignKey
ALTER TABLE "WatchedAsin" ADD CONSTRAINT "WatchedAsin_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchedAsin" ADD CONSTRAINT "WatchedAsin_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：关注来源取值、ASIN 为十位大写字母数字、快照取值范围
ALTER TABLE "WatchedAsin" ADD CONSTRAINT "WatchedAsin_check" CHECK (
  "reason" IN ('SEARCH_TERM', 'MANUAL')
  AND "asin" ~ '^[A-Z0-9]{10}$'
  AND ("ownAsin" = '' OR "ownAsin" ~ '^[A-Z0-9]{10}$')
  AND "asin" <> "ownAsin"
);
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_check" CHECK (
  ("price" IS NULL OR "price" > 0)
  AND ("imageCount" IS NULL OR "imageCount" >= 0)
  AND ("rank" IS NULL OR "rank" > 0)
  AND ("featuredStatus" IS NULL OR "featuredStatus" IN ('HAS_FEATURED', 'NONE'))
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['WatchedAsin', 'CompetitorSnapshot'] LOOP
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
