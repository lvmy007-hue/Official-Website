-- M-P1-27 回滚脚本：把七张分区表还原为普通表，数据原样保留。
-- 手工执行（Prisma 不会自动执行本文件）。执行前请先停止写入，并确认已有数据库备份。
-- 还原后需同步把 database/prisma/schema.prisma 与应用代码回退到分区前的版本，并从 _prisma_migrations 中删除本迁移记录。
-- 分区框架函数（nova_*）保留不删，对普通表无影响；如需一并移除见文末注释。
--
-- 还原时：OrderItem.orderPurchaseDate、AuditEvent.occurredAt 两个新增列随分区新表一起丢弃。

BEGIN;

SELECT nova_retire_table('"AuditEvent"'::regclass, '_part');
SELECT nova_retire_table('"AdsTermMetric"'::regclass, '_part');
SELECT nova_retire_table('"AdsMetric"'::regclass, '_part');
SELECT nova_retire_table('"FbaFeeEvent"'::regclass, '_part');
SELECT nova_retire_table('"FbaFinancialTransaction"'::regclass, '_part');
SELECT nova_retire_table('"OrderItem"'::regclass, '_part');
SELECT nova_retire_table('"Order"'::regclass, '_part');

CREATE TABLE "Order" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "amazonOrderId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL,
  "purchaseDate" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "fulfillment" TEXT,
  "currency" TEXT NOT NULL,
  "amount" DECIMAL(20,6),
  "itemCount" INTEGER,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "piiCiphertext" TEXT,
  "shippedAt" TIMESTAMP(3),
  "piiExpiresAt" TIMESTAMP(3),
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Order_sellerAccountId_amazonOrderId_key" ON "Order"("sellerAccountId", "amazonOrderId");
CREATE INDEX "Order_tenantId_purchaseDate_idx" ON "Order"("tenantId", "purchaseDate");
CREATE INDEX "Order_piiExpiresAt_idx" ON "Order"("piiExpiresAt");
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "Order" SELECT "id","tenantId","sellerAccountId","amazonOrderId","marketplaceId","purchaseDate","status","fulfillment","currency","amount","itemCount","sourceUpdatedAt","sourceRecordId","createdAt","updatedAt","piiCiphertext","shippedAt","piiExpiresAt" FROM "Order_part";

CREATE TABLE "OrderItem" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amazonOrderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "asin" TEXT,
  "sellerSku" TEXT,
  "title" TEXT,
  "quantityOrdered" INTEGER NOT NULL DEFAULT 0,
  "quantityShipped" INTEGER NOT NULL DEFAULT 0,
  "itemPrice" DECIMAL(20,6),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "fulfillmentNetwork" TEXT,
  "condition" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderItem_sellerAccountId_orderItemId_key" ON "OrderItem"("sellerAccountId", "orderItemId");
CREATE INDEX "OrderItem_tenantId_amazonOrderId_idx" ON "OrderItem"("tenantId", "amazonOrderId");
CREATE INDEX "OrderItem_sellerAccountId_sellerSku_idx" ON "OrderItem"("sellerAccountId", "sellerSku");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "OrderItem" SELECT "id","tenantId","sellerAccountId","orderId","amazonOrderId","orderItemId","asin","sellerSku","title","quantityOrdered","quantityShipped","itemPrice","currency","fulfillmentNetwork","condition","sourceUpdatedAt","createdAt","updatedAt" FROM "OrderItem_part";

CREATE TABLE "FbaFinancialTransaction" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "settlementId" TEXT,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "externalTransactionId" TEXT NOT NULL,
  "amazonOrderId" TEXT,
  "transactionType" TEXT,
  "transactionStatus" TEXT,
  "amount" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "postedAt" TIMESTAMP(3) NOT NULL,
  "description" TEXT,
  "raw" JSONB,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaFinancialTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FbaFinancialTransaction_sellerAccountId_externalTransaction_key" ON "FbaFinancialTransaction"("sellerAccountId", "externalTransactionId");
CREATE INDEX "FbaFinancialTransaction_tenantId_postedAt_transactionType_idx" ON "FbaFinancialTransaction"("tenantId", "postedAt", "transactionType");
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FbaSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "FbaFinancialTransaction" SELECT "id","tenantId","sellerAccountId","settlementId","marketplaceId","externalTransactionId","amazonOrderId","transactionType","transactionStatus","amount","currency","postedAt","description","raw","sourceUpdatedAt","createdAt","updatedAt" FROM "FbaFinancialTransaction_part";

CREATE TABLE "FbaFeeEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "settlementId" TEXT,
  "amazonOrderId" TEXT,
  "asin" TEXT,
  "sellerSku" TEXT,
  "eventType" TEXT NOT NULL,
  "amount" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "postedAt" TIMESTAMP(3) NOT NULL,
  "description" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceEventId" TEXT,
  CONSTRAINT "FbaFeeEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FbaFeeEvent_sellerAccountId_sourceEventId_key" ON "FbaFeeEvent"("sellerAccountId", "sourceEventId");
CREATE INDEX "FbaFeeEvent_tenantId_postedAt_eventType_idx" ON "FbaFeeEvent"("tenantId", "postedAt", "eventType");
CREATE INDEX "FbaFeeEvent_sellerAccountId_settlementId_idx" ON "FbaFeeEvent"("sellerAccountId", "settlementId");
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "FbaFeeEvent" SELECT "id","tenantId","sellerAccountId","marketplaceId","settlementId","amazonOrderId","asin","sellerSku","eventType","amount","currency","postedAt","description","sourceUpdatedAt","createdAt","sourceEventId" FROM "FbaFeeEvent_part";

CREATE TABLE "AdsMetric" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "reportJobId" TEXT,
  "reportDate" TIMESTAMP(3) NOT NULL,
  "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
  "externalCampaignId" TEXT,
  "campaignName" TEXT,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "cost" DECIMAL(20,6),
  "sales" DECIMAL(20,6),
  "purchases" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "raw" JSONB,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsMetric_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsMetric_adsProfileId_reportDate_adProduct_externalCampaig_key" ON "AdsMetric"("adsProfileId", "reportDate", "adProduct", "externalCampaignId");
CREATE INDEX "AdsMetric_tenantId_reportDate_idx" ON "AdsMetric"("tenantId", "reportDate");
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_reportJobId_fkey" FOREIGN KEY ("reportJobId") REFERENCES "AdsReportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "AdsMetric" SELECT "id","tenantId","adsProfileId","reportJobId","reportDate","adProduct","externalCampaignId","campaignName","impressions","clicks","cost","sales","purchases","currency","raw","sourceUpdatedAt","createdAt","updatedAt" FROM "AdsMetric_part";

CREATE TABLE "AdsTermMetric" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "reportJobId" TEXT,
  "reportDate" TIMESTAMP(3) NOT NULL,
  "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
  "level" TEXT NOT NULL,
  "externalCampaignId" TEXT,
  "campaignName" TEXT,
  "adGroupId" TEXT,
  "adGroupName" TEXT,
  "keywordId" TEXT,
  "keywordText" TEXT,
  "matchType" TEXT,
  "searchTerm" TEXT,
  "rowKey" TEXT NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "cost" DECIMAL(20,6),
  "sales" DECIMAL(20,6),
  "purchases" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "raw" JSONB,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsTermMetric_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsTermMetric_dedupe_key" ON "AdsTermMetric"("adsProfileId", "reportDate", "adProduct", "level", "rowKey");
CREATE INDEX "AdsTermMetric_tenant_date_level_idx" ON "AdsTermMetric"("tenantId", "reportDate", "level");
CREATE INDEX "AdsTermMetric_profile_campaign_idx" ON "AdsTermMetric"("adsProfileId", "externalCampaignId");
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_reportJobId_fkey" FOREIGN KEY ("reportJobId") REFERENCES "AdsReportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "AdsTermMetric" SELECT "id","tenantId","adsProfileId","reportJobId","reportDate","adProduct","level","externalCampaignId","campaignName","adGroupId","adGroupName","keywordId","keywordText","matchType","searchTerm","rowKey","impressions","clicks","cost","sales","purchases","currency","raw","sourceUpdatedAt","createdAt","updatedAt" FROM "AdsTermMetric_part";

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "requestId" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "AuditEvent" SELECT "id","tenantId","actorId","action","resourceType","resourceId","requestId","result","detail","createdAt" FROM "AuditEvent_part";

-- 核对行数，一致才删除分区表
DO $$
DECLARE
  pair record;
  part_count bigint;
  plain_count bigint;
BEGIN
  FOR pair IN SELECT * FROM (VALUES ('Order'), ('OrderItem'), ('FbaFinancialTransaction'), ('FbaFeeEvent'), ('AdsMetric'), ('AdsTermMetric'), ('AuditEvent')) AS t(name) LOOP
    EXECUTE format('SELECT count(*) FROM %I', pair.name || '_part') INTO part_count;
    EXECUTE format('SELECT count(*) FROM %I', pair.name) INTO plain_count;
    IF part_count <> plain_count THEN
      RAISE EXCEPTION '回滚行数不一致：% 分区表 % 行，普通表 % 行', pair.name, part_count, plain_count;
    END IF;
  END LOOP;
END $$;

DROP TABLE "OrderItem_part";
DROP TABLE "Order_part";
DROP TABLE "FbaFinancialTransaction_part";
DROP TABLE "FbaFeeEvent_part";
DROP TABLE "AdsMetric_part";
DROP TABLE "AdsTermMetric_part";
DROP TABLE "AuditEvent_part";

COMMIT;

-- 如需一并移除分区框架函数：
-- DROP FUNCTION nova_default_partition_rows(), nova_ensure_all_partitions(integer),
--   nova_ensure_partitions_around(regclass, timestamp, timestamp, integer), nova_ensure_partitions(regclass, date, date),
--   nova_ensure_default_partition(regclass), nova_ensure_month_partition(regclass, date),
--   nova_partition_key(regclass), nova_retire_table(regclass, text);
