-- M-P4-11 定价与购物车。
-- 依据：freeze/models.md 九、定价、竞品、评价与内容；05 章 5.5；14 章 P4-11；importers.md I-13、I-14、N-05、N-06。
--
-- 内容：
--   一、新表：PriceSnapshot（我方价格快照）、FeaturedOfferExpectedPrice（推荐报价预期价格）、CompetitiveSummarySnapshot（竞争摘要）、CompetitiveOffer（竞争报价）、BuyBoxSnapshot（推荐报价观察）、
--       PriceGuardrail（价格护栏）、PricingRule（定价规则）、PricingRuleRun（规则执行记录）。
--   二、ListingWriteRun 的 kind 检查约束增加 PRICE_VALIDATE、PRICE_PATCH（改价沿用刊登写入记录与任务，不另建写入表）。
--   三、检查约束、行级安全与授权（与其他租户表一致）。
--
-- 与冻结的出入（详见 CR-086）：PriceSnapshot 的 source 取 LISTING_API / WRITE_SUBMITTED，且只在变化或心跳时写入；PricingRule 多了单次调幅上限、每日次数上限与熔断阈值列；PricingRuleRun 多了 outcome、rawPrice 等列。
-- 回滚方法：见同目录 rollback.sql（删除八张新表并还原 ListingWriteRun 的检查约束；价格类快照是亚马逊数据的只读副本，下一次同步会取回；护栏、规则与执行记录会丢失）。
-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "sellerSku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "price" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeaturedOfferExpectedPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "sellerSku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "expectedPrice" DECIMAL(20,6),
    "currentFeaturedPrice" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "resultStatus" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeaturedOfferExpectedPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitiveSummarySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "asin" TEXT NOT NULL,
    "featuredPrice" DECIMAL(20,6),
    "featuredFulfillment" TEXT,
    "featuredIsOwn" BOOLEAN,
    "viewWeightMember" DECIMAL(12,6),
    "viewWeightNonMember" DECIMAL(12,6),
    "referencePrice" DECIMAL(20,6),
    "referencePriceType" TEXT,
    "lowestPrice" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "featuredOfferJson" JSONB NOT NULL DEFAULT '{}',
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitiveSummarySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitiveOffer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "asin" TEXT NOT NULL,
    "offerKey" TEXT NOT NULL,
    "isOwn" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "price" DECIMAL(20,6) NOT NULL,
    "shipping" DECIMAL(20,6),
    "condition" TEXT NOT NULL DEFAULT '',
    "fulfillment" TEXT NOT NULL DEFAULT '',
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitiveOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyBoxSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "asin" TEXT NOT NULL,
    "sellerSku" TEXT NOT NULL DEFAULT '',
    "hasFeaturedOffer" BOOLEAN NOT NULL,
    "ownIsFeatured" BOOLEAN,
    "featuredPrice" DECIMAL(20,6),
    "lostReason" TEXT,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyBoxSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceGuardrail" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT NOT NULL DEFAULT '',
    "minPrice" DECIMAL(20,6),
    "maxPrice" DECIMAL(20,6),
    "minMarginPct" DECIMAL(12,6),
    "maxChangePct" DECIMAL(12,6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceGuardrail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "paramsJson" JSONB NOT NULL DEFAULT '{}',
    "targetScopeJson" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PAUSED',
    "maxChangePct" DECIMAL(12,6) NOT NULL DEFAULT 0.05,
    "dailyLimit" INTEGER NOT NULL DEFAULT 1,
    "breakerFailures" INTEGER NOT NULL DEFAULT 3,
    "breakerConversionDrop" DECIMAL(12,6),
    "breakerMinMargin" DECIMAL(12,6),
    "breakerReason" TEXT,
    "breakerAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRuleRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "currentPrice" DECIMAL(20,6),
    "rawPrice" DECIMAL(20,6),
    "suggestedPrice" DECIMAL(20,6),
    "guardrailResult" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "message" TEXT,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "writeRunId" TEXT,
    "workItemId" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingRuleRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceSnapshot_sku_idx" ON "PriceSnapshot"("tenantId", "sellerAccountId", "sellerSku", "observedAt");

-- CreateIndex
CREATE INDEX "PriceSnapshot_store_idx" ON "PriceSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceSnapshot_uq" ON "PriceSnapshot"("sellerAccountId", "marketplaceId", "sellerSku", "observedAt");

-- CreateIndex
CREATE INDEX "FeaturedOfferExpectedPrice_sku_idx" ON "FeaturedOfferExpectedPrice"("tenantId", "sellerAccountId", "sellerSku", "observedAt");

-- CreateIndex
CREATE INDEX "FeaturedOfferExpectedPrice_store_idx" ON "FeaturedOfferExpectedPrice"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedOfferExpectedPrice_uq" ON "FeaturedOfferExpectedPrice"("sellerAccountId", "marketplaceId", "sellerSku", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitiveSummarySnapshot_asin_idx" ON "CompetitiveSummarySnapshot"("tenantId", "sellerAccountId", "asin", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitiveSummarySnapshot_store_idx" ON "CompetitiveSummarySnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitiveSummarySnapshot_uq" ON "CompetitiveSummarySnapshot"("sellerAccountId", "marketplaceId", "asin", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitiveOffer_asin_idx" ON "CompetitiveOffer"("tenantId", "sellerAccountId", "asin", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitiveOffer_store_idx" ON "CompetitiveOffer"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitiveOffer_uq" ON "CompetitiveOffer"("sellerAccountId", "marketplaceId", "asin", "offerKey", "observedAt");

-- CreateIndex
CREATE INDEX "BuyBoxSnapshot_asin_idx" ON "BuyBoxSnapshot"("tenantId", "sellerAccountId", "asin", "observedAt");

-- CreateIndex
CREATE INDEX "BuyBoxSnapshot_store_idx" ON "BuyBoxSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyBoxSnapshot_uq" ON "BuyBoxSnapshot"("sellerAccountId", "marketplaceId", "asin", "sellerSku", "source", "observedAt");

-- CreateIndex
CREATE INDEX "PriceGuardrail_store_idx" ON "PriceGuardrail"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceGuardrail_uq" ON "PriceGuardrail"("tenantId", "sellerAccountId", "scope", "scopeRef");

-- CreateIndex
CREATE INDEX "PricingRule_status_idx" ON "PricingRule"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PricingRule_store_idx" ON "PricingRule"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRule_uq" ON "PricingRule"("tenantId", "sellerAccountId", "name");

-- CreateIndex
CREATE INDEX "PricingRuleRun_outcome_idx" ON "PricingRuleRun"("tenantId", "outcome", "runAt");

-- CreateIndex
CREATE INDEX "PricingRuleRun_sku_idx" ON "PricingRuleRun"("tenantId", "sellerAccountId", "sku", "runAt");

-- CreateIndex
CREATE INDEX "PricingRuleRun_store_idx" ON "PricingRuleRun"("sellerAccountId");

-- CreateIndex
CREATE INDEX "PricingRuleRun_rule_idx" ON "PricingRuleRun"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingRuleRun_uq" ON "PricingRuleRun"("ruleId", "sku", "runAt");

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedOfferExpectedPrice" ADD CONSTRAINT "FeaturedOfferExpectedPrice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedOfferExpectedPrice" ADD CONSTRAINT "FeaturedOfferExpectedPrice_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitiveSummarySnapshot" ADD CONSTRAINT "CompetitiveSummarySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitiveSummarySnapshot" ADD CONSTRAINT "CompetitiveSummarySnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitiveOffer" ADD CONSTRAINT "CompetitiveOffer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitiveOffer" ADD CONSTRAINT "CompetitiveOffer_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyBoxSnapshot" ADD CONSTRAINT "BuyBoxSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyBoxSnapshot" ADD CONSTRAINT "BuyBoxSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceGuardrail" ADD CONSTRAINT "PriceGuardrail_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceGuardrail" ADD CONSTRAINT "PriceGuardrail_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleRun" ADD CONSTRAINT "PricingRuleRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleRun" ADD CONSTRAINT "PricingRuleRun_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleRun" ADD CONSTRAINT "PricingRuleRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：取值范围、非负与大小关系
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_check" CHECK ("source" IN ('LISTING_API', 'WRITE_SUBMITTED') AND "price" > 0);
ALTER TABLE "FeaturedOfferExpectedPrice" ADD CONSTRAINT "FeaturedOfferExpectedPrice_check" CHECK (("expectedPrice" IS NULL OR "expectedPrice" > 0) AND ("currentFeaturedPrice" IS NULL OR "currentFeaturedPrice" > 0));
ALTER TABLE "CompetitiveSummarySnapshot" ADD CONSTRAINT "CompetitiveSummarySnapshot_check" CHECK (
  ("viewWeightMember" IS NULL OR ("viewWeightMember" >= 0 AND "viewWeightMember" <= 1))
  AND ("viewWeightNonMember" IS NULL OR ("viewWeightNonMember" >= 0 AND "viewWeightNonMember" <= 1))
);
ALTER TABLE "CompetitiveOffer" ADD CONSTRAINT "CompetitiveOffer_check" CHECK ("price" >= 0);
ALTER TABLE "BuyBoxSnapshot" ADD CONSTRAINT "BuyBoxSnapshot_check" CHECK ("source" IN ('SYNC', 'PUSH_ANY_OFFER', 'PUSH_PRICING_HEALTH') AND ("lostReason" IS NULL OR "lostReason" IN ('PRICE')));
ALTER TABLE "PriceGuardrail" ADD CONSTRAINT "PriceGuardrail_check" CHECK (
  "scope" IN ('STORE', 'CATEGORY', 'ASIN', 'SKU')
  AND ("minPrice" IS NULL OR "minPrice" > 0)
  AND ("maxPrice" IS NULL OR "maxPrice" > 0)
  AND ("minPrice" IS NULL OR "maxPrice" IS NULL OR "minPrice" <= "maxPrice")
  AND ("minMarginPct" IS NULL OR ("minMarginPct" >= 0 AND "minMarginPct" <= 0.95))
  AND ("maxChangePct" IS NULL OR ("maxChangePct" > 0 AND "maxChangePct" <= 1))
  AND "version" >= 1
);
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_check" CHECK (
  "mode" IN ('MANUAL', 'AUTO')
  AND "strategy" IN ('FOLLOW_EXPECTED', 'TARGET_MARGIN', 'MATCH_LOWEST')
  AND "status" IN ('ACTIVE', 'PAUSED', 'BREAKER')
  AND "maxChangePct" > 0 AND "maxChangePct" <= 0.5
  AND "dailyLimit" >= 1 AND "dailyLimit" <= 10
  AND "breakerFailures" >= 1 AND "breakerFailures" <= 10
  AND ("breakerConversionDrop" IS NULL OR ("breakerConversionDrop" > 0 AND "breakerConversionDrop" <= 0.9))
  AND ("breakerMinMargin" IS NULL OR ("breakerMinMargin" >= 0 AND "breakerMinMargin" <= 0.9))
  AND "version" >= 1
);
ALTER TABLE "PricingRuleRun" ADD CONSTRAINT "PricingRuleRun_check" CHECK (
  "outcome" IN ('SUGGESTED', 'QUEUED', 'APPLIED', 'FAILED', 'BLOCKED', 'SKIPPED', 'DISMISSED')
  AND "ruleVersion" >= 1
  AND ("suggestedPrice" IS NULL OR "suggestedPrice" > 0)
);

-- 改价沿用刊登写入记录：kind 增加 PRICE_VALIDATE（价格校验预览）与 PRICE_PATCH（修改价格）
ALTER TABLE "ListingWriteRun" DROP CONSTRAINT "ListingWriteRun_check";
ALTER TABLE "ListingWriteRun" ADD CONSTRAINT "ListingWriteRun_check" CHECK (
  "kind" IN ('VALIDATE', 'PATCH', 'BATCH', 'RESTRICTIONS', 'PRICE_VALIDATE', 'PRICE_PATCH')
  AND "status" IN ('PENDING', 'RUNNING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'PARTIAL', 'FAILED')
  AND ("validation" IS NULL OR "validation" IN ('VALID', 'INVALID'))
  AND "pollCount" >= 0
  AND "itemCount" >= 0
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['PriceSnapshot', 'FeaturedOfferExpectedPrice', 'CompetitiveSummarySnapshot', 'CompetitiveOffer', 'BuyBoxSnapshot', 'PriceGuardrail', 'PricingRule', 'PricingRuleRun'] LOOP
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