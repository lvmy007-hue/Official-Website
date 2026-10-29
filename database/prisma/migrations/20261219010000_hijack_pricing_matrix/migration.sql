-- M-P6-17 跟卖监控、白名单、定价规则“情形 × 动作”矩阵
-- 依据：14 章 P6-17；16 章第 3.2、9、10 节；freeze/models.md 第二十一节（OfferCompetitor、HijackWhitelist 新增，PricingRule 加 scenarioMatrix）。
--
-- 内容：
--   一、新表 OfferCompetitor：我方 Listing（店铺 × SKU）上出现过的其他报价方；卖家编号只存哈希（与 CompetitiveOffer.offerKey 同一算法）。
--       比冻结稿多一列 goneAt（报价方从摘要里消失的时间），“出现、消失”都能查，不靠猜；
--   二、新表 HijackWhitelist：企业级白名单，卖家编号只存哈希，另存前两位与后两位的提示；
--   三、PricingRule 增加 scenarioMatrix（情形 × 动作矩阵，空表示沿用策略求价）；
--   四、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除两张新表与新增的列；已配置矩阵的规则回滚后改回按策略求价）。

-- AlterTable
ALTER TABLE "PricingRule" ADD COLUMN "scenarioMatrix" JSONB;
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_scenarioMatrix_check" CHECK ("scenarioMatrix" IS NULL OR jsonb_typeof("scenarioMatrix") = 'object');

-- CreateTable
CREATE TABLE "OfferCompetitor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "sellerId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "goneAt" TIMESTAMP(3),
    "price" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isFba" BOOLEAN NOT NULL DEFAULT false,
    "hasBuybox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferCompetitor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HijackWhitelist" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sellerHint" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HijackWhitelist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfferCompetitor_tenantId_sellerAccountId_sku_sellerId_key" ON "OfferCompetitor"("tenantId", "sellerAccountId", "sku", "sellerId");
CREATE INDEX "OfferCompetitor_active_idx" ON "OfferCompetitor"("tenantId", "sellerAccountId", "goneAt", "firstSeenAt");
CREATE INDEX "OfferCompetitor_seller_idx" ON "OfferCompetitor"("tenantId", "sellerId");
CREATE INDEX "OfferCompetitor_store_idx" ON "OfferCompetitor"("sellerAccountId");
CREATE UNIQUE INDEX "HijackWhitelist_tenantId_sellerId_key" ON "HijackWhitelist"("tenantId", "sellerId");

-- AddForeignKey
ALTER TABLE "OfferCompetitor" ADD CONSTRAINT "OfferCompetitor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfferCompetitor" ADD CONSTRAINT "OfferCompetitor_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HijackWhitelist" ADD CONSTRAINT "HijackWhitelist_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 约束：价格非负；时间先后；卖家哈希非空；白名单备注长度
ALTER TABLE "OfferCompetitor" ADD CONSTRAINT "OfferCompetitor_check" CHECK ("price" >= 0 AND length("sellerId") > 0 AND length("sku") > 0 AND "lastSeenAt" >= "firstSeenAt" AND ("goneAt" IS NULL OR "goneAt" >= "firstSeenAt"));
ALTER TABLE "HijackWhitelist" ADD CONSTRAINT "HijackWhitelist_check" CHECK (length("sellerId") > 0 AND ("note" IS NULL OR length("note") <= 200) AND length("sellerHint") <= 20);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['OfferCompetitor', 'HijackWhitelist'] LOOP
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
