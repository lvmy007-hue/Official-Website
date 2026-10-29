-- M-P4-05 促销与优惠券。
-- 依据：freeze/models.md M-P4-05；04 章 4.8；14 章 P4-05；importers.md I-17、R-40、R-41。
--
-- 内容：
--   一、新表：Promotion（亚马逊促销，只读同步）、PromotionItem（促销的商品清单）、PromotionMetric（促销绩效报告按 映射编号×ASIN×日 的明细）、
--       CouponMetric（优惠券绩效报告按 映射编号×日 的明细）。
--   二、检查约束：计数非负；行级安全与授权（与其他租户表一致）。
--   促销类型、状态原样保存亚马逊的取值，不加检查约束（亚马逊新增取值时同步不能失败）。
--
-- 回滚方法：见同目录 rollback.sql（删除四张新表；四张表都是亚马逊数据的只读副本，回滚后下一次同步与报告导入会重新取回，不丢失我方录入的任何内容）。

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "promotionType" TEXT NOT NULL,
    "couponType" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "revisionStatus" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "amazonCreatedAt" TIMESTAMP(3),
    "amazonUpdatedAt" TIMESTAMP(3) NOT NULL,
    "mappingId" TEXT,
    "budgetType" TEXT,
    "budgetValue" DECIMAL(20,6),
    "budgetCurrency" TEXT,
    "benefitJson" JSONB,
    "feeJson" JSONB,
    "selectionType" TEXT,
    "selectionId" TEXT,
    "selectionRevision" INTEGER,
    "itemCount" INTEGER,
    "itemsForUpdatedAt" TIMESTAMP(3),
    "itemsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "issuesJson" JSONB NOT NULL DEFAULT '[]',
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "promotionRowId" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "sku" TEXT NOT NULL DEFAULT '',
    "benefitType" TEXT,
    "discountType" TEXT,
    "percentOff" DECIMAL(12,6),
    "amountOff" DECIMAL(20,6),
    "fixedPrice" DECIMAL(20,6),
    "currency" TEXT,
    "perCustomerUses" INTEGER,
    "budgetType" TEXT,
    "budgetValue" DECIMAL(20,6),
    "issuesJson" JSONB NOT NULL DEFAULT '[]',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "metricDate" DATE NOT NULL,
    "units" INTEGER,
    "sales" DECIMAL(20,6),
    "redemptions" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceReportJobId" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "metricDate" DATE NOT NULL,
    "clips" INTEGER,
    "redemptions" INTEGER,
    "budgetSpent" DECIMAL(20,6),
    "sales" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceReportJobId" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_uq" ON "Promotion"("sellerAccountId", "promotionId");

-- CreateIndex
CREATE INDEX "Promotion_start_idx" ON "Promotion"("tenantId", "startAt");

-- CreateIndex
CREATE INDEX "Promotion_status_idx" ON "Promotion"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Promotion_mapping_idx" ON "Promotion"("tenantId", "sellerAccountId", "mappingId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionItem_uq" ON "PromotionItem"("promotionRowId", "asin", "sku");

-- CreateIndex
CREATE INDEX "PromotionItem_store_idx" ON "PromotionItem"("sellerAccountId");

-- CreateIndex
CREATE INDEX "PromotionItem_asin_idx" ON "PromotionItem"("tenantId", "sellerAccountId", "asin");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionMetric_uq" ON "PromotionMetric"("tenantId", "sellerAccountId", "mappingId", "asin", "metricDate");

-- CreateIndex
CREATE INDEX "PromotionMetric_date_idx" ON "PromotionMetric"("tenantId", "sellerAccountId", "metricDate");

-- CreateIndex
CREATE INDEX "PromotionMetric_store_idx" ON "PromotionMetric"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponMetric_uq" ON "CouponMetric"("tenantId", "sellerAccountId", "mappingId", "metricDate");

-- CreateIndex
CREATE INDEX "CouponMetric_date_idx" ON "CouponMetric"("tenantId", "sellerAccountId", "metricDate");

-- CreateIndex
CREATE INDEX "CouponMetric_store_idx" ON "CouponMetric"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItem" ADD CONSTRAINT "PromotionItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItem" ADD CONSTRAINT "PromotionItem_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItem" ADD CONSTRAINT "PromotionItem_promotionRowId_fkey" FOREIGN KEY ("promotionRowId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionMetric" ADD CONSTRAINT "PromotionMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionMetric" ADD CONSTRAINT "PromotionMetric_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponMetric" ADD CONSTRAINT "CouponMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponMetric" ADD CONSTRAINT "CouponMetric_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：计数非负；促销与优惠券的数量列非负
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_check" CHECK ("errorCount" >= 0 AND "warningCount" >= 0 AND ("itemCount" IS NULL OR "itemCount" >= 0));
ALTER TABLE "PromotionMetric" ADD CONSTRAINT "PromotionMetric_check" CHECK (("units" IS NULL OR "units" >= 0) AND ("redemptions" IS NULL OR "redemptions" >= 0));
ALTER TABLE "CouponMetric" ADD CONSTRAINT "CouponMetric_check" CHECK (("clips" IS NULL OR "clips" >= 0) AND ("redemptions" IS NULL OR "redemptions" >= 0));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['Promotion', 'PromotionItem', 'PromotionMetric', 'CouponMetric'] LOOP
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
