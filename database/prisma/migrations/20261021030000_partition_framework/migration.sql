-- M-P1-27 分区框架
-- 依据：10 章 10.1、12 章 12.4；freeze/models.md 0.3 与第十八节第 1 项。
--
-- 内容：
--   一、分区框架函数（按月范围分区：建分区、批量建分区、全库续建、默认分区、旧表退场）。
--   二、把 Order、OrderItem、FbaFinancialTransaction、FbaFeeEvent、AdsMetric、AdsTermMetric、AuditEvent
--       改为按月分区。步骤：旧表改名退场 → 建分区新表 → 建分区 → 回填 → 核对行数 → 删除旧表。
--       整个迁移在同一事务内执行，任何一步失败（含行数核对不一致）全部回滚。
--
-- 运行要求：分区表较多时迁移与回滚会在同一事务内锁定大量分区与索引，数据库需设置 max_locks_per_transaction >= 512\n--   （docker-compose 与测试数据库已设置；生产环境部署时同样要配置）。\n--\n-- 分区规则：
--   · 分区列：Order.purchaseDate、OrderItem.orderPurchaseDate（新增，取所属订单的 purchaseDate）、
--     FbaFinancialTransaction.postedAt、FbaFeeEvent.postedAt、AdsMetric.reportDate、
--     AdsTermMetric.reportDate、AuditEvent.occurredAt（新增，回填为 createdAt）。
--   · 主键与全部唯一键包含分区列；
--   · 每张分区表带默认分区（<表名>_default），接住超出范围的异常数据，避免写入失败；
--     监控函数 nova_default_partition_rows() 报告默认分区行数，非 0 即需处理；
--   · 分区命名 <表名>_pYYYYMM；提前 3 个月续建由后台任务调用 nova_ensure_all_partitions 完成。
--
-- 回滚方法：见同目录 rollback.sql（把分区表还原为普通表，数据原样保留；不在自动流程中执行）。
-- 大表变更原则“先加后删”：本迁移在同一事务内完成“先建新表、回填、核对、再删旧表”，核对失败则整体回滚。

-- ============================================================
-- 一、分区框架函数
-- ============================================================

-- 取分区表的分区列名（只支持单列范围分区）。
CREATE OR REPLACE FUNCTION nova_partition_key(parent regclass)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  key_name text;
  key_count integer;
BEGIN
  SELECT count(*), min(a.attname)
    INTO key_count, key_name
  FROM pg_partitioned_table p
  JOIN LATERAL unnest(p.partattrs::int2[]) AS k(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = k.attnum
  WHERE p.partrelid = parent AND p.partstrat = 'r';
  IF key_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '% 不是单列范围分区表', parent;
  END IF;
  RETURN key_name;
END
$$;

-- 创建某个月的分区；已存在则不动，返回是否新建。
-- 若默认分区里已有落在该月的数据，先搬出再建分区，建好后写回，保证数据不丢、不重复。
CREATE OR REPLACE FUNCTION nova_ensure_month_partition(parent regclass, month_start date)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_schema text;
  parent_name text;
  key_name text;
  first_day date := date_trunc('month', month_start)::date;
  next_day date := (date_trunc('month', month_start) + interval '1 month')::date;
  part_name text;
  default_name text;
  moved bigint := 0;
BEGIN
  SELECT n.nspname, c.relname INTO parent_schema, parent_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = parent;

  key_name := nova_partition_key(parent);
  part_name := left(parent_name, 63 - 8) || '_p' || to_char(first_day, 'YYYYMM');
  default_name := left(parent_name, 63 - 8) || '_default';

  IF to_regclass(format('%I.%I', parent_schema, part_name)) IS NOT NULL THEN
    RETURN false;
  END IF;

  IF to_regclass(format('%I.%I', parent_schema, default_name)) IS NOT NULL THEN
    EXECUTE 'DROP TABLE IF EXISTS pg_temp.nova_partition_stage';
    EXECUTE format(
      'CREATE TEMP TABLE nova_partition_stage ON COMMIT DROP AS SELECT * FROM %I.%I WHERE %I >= %L AND %I < %L',
      parent_schema, default_name, key_name, first_day::text, key_name, next_day::text);
    GET DIAGNOSTICS moved = ROW_COUNT;
    IF moved > 0 THEN
      EXECUTE format('DELETE FROM %I.%I WHERE %I >= %L AND %I < %L',
        parent_schema, default_name, key_name, first_day::text, key_name, next_day::text);
    END IF;
  END IF;

  EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
    parent_schema, part_name, parent_schema, parent_name, first_day::text, next_day::text);

  IF moved > 0 THEN
    EXECUTE format('INSERT INTO %I.%I SELECT * FROM pg_temp.nova_partition_stage', parent_schema, parent_name);
    EXECUTE 'DROP TABLE pg_temp.nova_partition_stage';
  END IF;
  RETURN true;
END
$$;

-- 创建默认分区（已存在则不动）。
CREATE OR REPLACE FUNCTION nova_ensure_default_partition(parent regclass)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_schema text;
  parent_name text;
  default_name text;
BEGIN
  SELECT n.nspname, c.relname INTO parent_schema, parent_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = parent;
  default_name := left(parent_name, 63 - 8) || '_default';
  IF to_regclass(format('%I.%I', parent_schema, default_name)) IS NOT NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I DEFAULT', parent_schema, default_name, parent_schema, parent_name);
  RETURN true;
END
$$;

-- 创建 first_month 至 last_month（含）之间每个月的分区，返回新建个数。
CREATE OR REPLACE FUNCTION nova_ensure_partitions(parent regclass, first_month date, last_month date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  cursor_month date := date_trunc('month', first_month)::date;
  end_month date := date_trunc('month', last_month)::date;
  created integer := 0;
BEGIN
  IF end_month < cursor_month THEN
    RAISE EXCEPTION '结束月份不能早于开始月份';
  END IF;
  IF ((extract(year FROM end_month) - extract(year FROM cursor_month)) * 12 + (extract(month FROM end_month) - extract(month FROM cursor_month))) > 600 THEN
    RAISE EXCEPTION '一次最多创建 600 个月的分区';
  END IF;
  WHILE cursor_month <= end_month LOOP
    IF nova_ensure_month_partition(parent, cursor_month) THEN
      created := created + 1;
    END IF;
    cursor_month := (cursor_month + interval '1 month')::date;
  END LOOP;
  RETURN created;
END
$$;

-- 按数据范围建分区：从“最早数据所在月（与当前月取较早者）”到“最晚数据所在月（与当前月取较晚者）再往后 months_ahead 个月”。
CREATE OR REPLACE FUNCTION nova_ensure_partitions_around(parent regclass, lo timestamp, hi timestamp, months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- 最多向前补建 120 个月，更早的异常数据由默认分区接住，避免异常日期造成成百上千个空分区
  first_month date := GREATEST(date_trunc('month', LEAST(COALESCE(lo, timezone('UTC', now())), timezone('UTC', now())))::date, (date_trunc('month', timezone('UTC', now())) - interval '120 months')::date);
  last_month date := (date_trunc('month', GREATEST(COALESCE(hi, timezone('UTC', now())), timezone('UTC', now()))) + make_interval(months => months_ahead))::date;
BEGIN
  PERFORM nova_ensure_default_partition(parent);
  RETURN nova_ensure_partitions(parent, first_month, last_month);
END
$$;

-- 全库续建：对 public 模式下全部单列范围分区表，保证当前月起往后 months_ahead 个月的分区存在。
-- 由后台任务每日调用；也可手工执行。返回每张表新建的分区数。
CREATE OR REPLACE FUNCTION nova_ensure_all_partitions(months_ahead integer DEFAULT 3)
RETURNS TABLE(parent_table text, created_count integer)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  item record;
  current_month date := date_trunc('month', timezone('UTC', now()))::date;
BEGIN
  FOR item IN
    SELECT p.partrelid::regclass AS parent, c.relname::text AS name
    FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND p.partstrat = 'r'
    ORDER BY c.relname
  LOOP
    parent_table := item.name;
    PERFORM nova_ensure_default_partition(item.parent);
    created_count := nova_ensure_partitions(item.parent, current_month, (current_month + make_interval(months => months_ahead))::date);
    RETURN NEXT;
  END LOOP;
END
$$;

-- 监控：默认分区里的行数。非 0 表示有数据落在已建分区范围之外，需要补建分区或排查来源。
CREATE OR REPLACE FUNCTION nova_default_partition_rows()
RETURNS TABLE(parent_table text, row_count bigint)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.relname::text AS parent_name, d.oid::regclass AS default_table
    FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhparent = p.partrelid
    JOIN pg_class d ON d.oid = i.inhrelid
    WHERE n.nspname = 'public' AND p.partstrat = 'r'
      AND pg_get_expr(d.relpartbound, d.oid) = 'DEFAULT'
    ORDER BY c.relname
  LOOP
    parent_table := item.parent_name;
    EXECUTE format('SELECT count(*) FROM %s', item.default_table) INTO row_count;
    RETURN NEXT;
  END LOOP;
END
$$;

-- 旧表退场：表、约束、索引统一加后缀，腾出原名给分区新表。
CREATE OR REPLACE FUNCTION nova_retire_table(tbl regclass, suffix text DEFAULT '_legacy')
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  tbl_schema text;
  tbl_name text;
  item record;
BEGIN
  SELECT n.nspname, c.relname INTO tbl_schema, tbl_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = tbl;

  -- 先改约束（主键、唯一约束的索引随之改名），再改独立索引
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = tbl ORDER BY conname LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', tbl, item.conname, left(item.conname, 63 - length(suffix)) || suffix);
  END LOOP;
  FOR item IN
    SELECT ic.relname AS index_name
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = tbl AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
    ORDER BY ic.relname
  LOOP
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', tbl_schema, item.index_name, left(item.index_name, 63 - length(suffix)) || suffix);
  END LOOP;
  EXECUTE format('ALTER TABLE %s RENAME TO %I', tbl, left(tbl_name, 63 - length(suffix)) || suffix);
END
$$;

-- ============================================================
-- 二、Order（分区列 purchaseDate）
-- ============================================================

SELECT nova_retire_table('"Order"'::regclass);

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
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id", "purchaseDate")
) PARTITION BY RANGE ("purchaseDate");

CREATE UNIQUE INDEX "Order_sellerAccountId_amazonOrderId_purchaseDate_key" ON "Order"("sellerAccountId", "amazonOrderId", "purchaseDate");
CREATE INDEX "Order_tenantId_purchaseDate_idx" ON "Order"("tenantId", "purchaseDate");
CREATE INDEX "Order_piiExpiresAt_idx" ON "Order"("piiExpiresAt");
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min("purchaseDate"), max("purchaseDate") INTO lo, hi FROM "Order_legacy";
  PERFORM nova_ensure_partitions_around('"Order"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "Order" ("id","tenantId","sellerAccountId","amazonOrderId","marketplaceId","purchaseDate","status","fulfillment","currency","amount","itemCount","sourceUpdatedAt","sourceRecordId","createdAt","updatedAt","piiCiphertext","shippedAt","piiExpiresAt")
SELECT "id","tenantId","sellerAccountId","amazonOrderId","marketplaceId","purchaseDate","status","fulfillment","currency","amount","itemCount","sourceUpdatedAt","sourceRecordId","createdAt","updatedAt","piiCiphertext","shippedAt","piiExpiresAt"
FROM "Order_legacy";

-- ============================================================
-- 三、OrderItem（分区列 orderPurchaseDate，等于所属订单的 purchaseDate；外键为 (orderId, orderPurchaseDate)）
-- ============================================================

SELECT nova_retire_table('"OrderItem"'::regclass);

CREATE TABLE "OrderItem" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderPurchaseDate" TIMESTAMP(3) NOT NULL,
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
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id", "orderPurchaseDate")
) PARTITION BY RANGE ("orderPurchaseDate");

CREATE UNIQUE INDEX "OrderItem_sellerAccountId_orderItemId_orderPurchaseDate_key" ON "OrderItem"("sellerAccountId", "orderItemId", "orderPurchaseDate");
CREATE INDEX "OrderItem_tenantId_amazonOrderId_idx" ON "OrderItem"("tenantId", "amazonOrderId");
CREATE INDEX "OrderItem_sellerAccountId_sellerSku_idx" ON "OrderItem"("sellerAccountId", "sellerSku");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_orderPurchaseDate_fkey" FOREIGN KEY ("orderId", "orderPurchaseDate") REFERENCES "Order"("id", "purchaseDate") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min(o."purchaseDate"), max(o."purchaseDate") INTO lo, hi
  FROM "OrderItem_legacy" i JOIN "Order" o ON o."id" = i."orderId";
  PERFORM nova_ensure_partitions_around('"OrderItem"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "OrderItem" ("id","tenantId","sellerAccountId","orderId","orderPurchaseDate","amazonOrderId","orderItemId","asin","sellerSku","title","quantityOrdered","quantityShipped","itemPrice","currency","fulfillmentNetwork","condition","sourceUpdatedAt","createdAt","updatedAt")
SELECT i."id", i."tenantId", i."sellerAccountId", i."orderId", o."purchaseDate", i."amazonOrderId", i."orderItemId", i."asin", i."sellerSku", i."title", i."quantityOrdered", i."quantityShipped", i."itemPrice", i."currency", i."fulfillmentNetwork", i."condition", i."sourceUpdatedAt", i."createdAt", i."updatedAt"
FROM "OrderItem_legacy" i
JOIN "Order" o ON o."id" = i."orderId";

-- ============================================================
-- 四、FbaFinancialTransaction（分区列 postedAt）
-- ============================================================

SELECT nova_retire_table('"FbaFinancialTransaction"'::regclass);

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
  CONSTRAINT "FbaFinancialTransaction_pkey" PRIMARY KEY ("id", "postedAt")
) PARTITION BY RANGE ("postedAt");

CREATE UNIQUE INDEX "FbaFinancialTransaction_dedupe_key" ON "FbaFinancialTransaction"("sellerAccountId", "externalTransactionId", "postedAt");
CREATE INDEX "FbaFinancialTransaction_tenantId_postedAt_transactionType_idx" ON "FbaFinancialTransaction"("tenantId", "postedAt", "transactionType");
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FbaSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min("postedAt"), max("postedAt") INTO lo, hi FROM "FbaFinancialTransaction_legacy";
  PERFORM nova_ensure_partitions_around('"FbaFinancialTransaction"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "FbaFinancialTransaction" ("id","tenantId","sellerAccountId","settlementId","marketplaceId","externalTransactionId","amazonOrderId","transactionType","transactionStatus","amount","currency","postedAt","description","raw","sourceUpdatedAt","createdAt","updatedAt")
SELECT "id","tenantId","sellerAccountId","settlementId","marketplaceId","externalTransactionId","amazonOrderId","transactionType","transactionStatus","amount","currency","postedAt","description","raw","sourceUpdatedAt","createdAt","updatedAt"
FROM "FbaFinancialTransaction_legacy";

-- ============================================================
-- 五、FbaFeeEvent（分区列 postedAt）
-- ============================================================

SELECT nova_retire_table('"FbaFeeEvent"'::regclass);

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
  CONSTRAINT "FbaFeeEvent_pkey" PRIMARY KEY ("id", "postedAt")
) PARTITION BY RANGE ("postedAt");

CREATE UNIQUE INDEX "FbaFeeEvent_sellerAccountId_sourceEventId_postedAt_key" ON "FbaFeeEvent"("sellerAccountId", "sourceEventId", "postedAt");
CREATE INDEX "FbaFeeEvent_tenantId_postedAt_eventType_idx" ON "FbaFeeEvent"("tenantId", "postedAt", "eventType");
CREATE INDEX "FbaFeeEvent_sellerAccountId_settlementId_idx" ON "FbaFeeEvent"("sellerAccountId", "settlementId");
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min("postedAt"), max("postedAt") INTO lo, hi FROM "FbaFeeEvent_legacy";
  PERFORM nova_ensure_partitions_around('"FbaFeeEvent"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "FbaFeeEvent" ("id","tenantId","sellerAccountId","marketplaceId","settlementId","amazonOrderId","asin","sellerSku","eventType","amount","currency","postedAt","description","sourceUpdatedAt","createdAt","sourceEventId")
SELECT "id","tenantId","sellerAccountId","marketplaceId","settlementId","amazonOrderId","asin","sellerSku","eventType","amount","currency","postedAt","description","sourceUpdatedAt","createdAt","sourceEventId"
FROM "FbaFeeEvent_legacy";

-- ============================================================
-- 六、AdsMetric（分区列 reportDate）
-- ============================================================

SELECT nova_retire_table('"AdsMetric"'::regclass);

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
  CONSTRAINT "AdsMetric_pkey" PRIMARY KEY ("id", "reportDate")
) PARTITION BY RANGE ("reportDate");

CREATE UNIQUE INDEX "AdsMetric_adsProfileId_reportDate_adProduct_externalCampaig_key" ON "AdsMetric"("adsProfileId", "reportDate", "adProduct", "externalCampaignId");
CREATE INDEX "AdsMetric_tenantId_reportDate_idx" ON "AdsMetric"("tenantId", "reportDate");
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_reportJobId_fkey" FOREIGN KEY ("reportJobId") REFERENCES "AdsReportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min("reportDate"), max("reportDate") INTO lo, hi FROM "AdsMetric_legacy";
  PERFORM nova_ensure_partitions_around('"AdsMetric"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "AdsMetric" ("id","tenantId","adsProfileId","reportJobId","reportDate","adProduct","externalCampaignId","campaignName","impressions","clicks","cost","sales","purchases","currency","raw","sourceUpdatedAt","createdAt","updatedAt")
SELECT "id","tenantId","adsProfileId","reportJobId","reportDate","adProduct","externalCampaignId","campaignName","impressions","clicks","cost","sales","purchases","currency","raw","sourceUpdatedAt","createdAt","updatedAt"
FROM "AdsMetric_legacy";

-- ============================================================
-- 七、AdsTermMetric（分区列 reportDate）
-- ============================================================

SELECT nova_retire_table('"AdsTermMetric"'::regclass);

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
  CONSTRAINT "AdsTermMetric_pkey" PRIMARY KEY ("id", "reportDate")
) PARTITION BY RANGE ("reportDate");

CREATE UNIQUE INDEX "AdsTermMetric_dedupe_key" ON "AdsTermMetric"("adsProfileId", "reportDate", "adProduct", "level", "rowKey");
CREATE INDEX "AdsTermMetric_tenant_date_level_idx" ON "AdsTermMetric"("tenantId", "reportDate", "level");
CREATE INDEX "AdsTermMetric_profile_campaign_idx" ON "AdsTermMetric"("adsProfileId", "externalCampaignId");
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_reportJobId_fkey" FOREIGN KEY ("reportJobId") REFERENCES "AdsReportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min("reportDate"), max("reportDate") INTO lo, hi FROM "AdsTermMetric_legacy";
  PERFORM nova_ensure_partitions_around('"AdsTermMetric"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "AdsTermMetric" ("id","tenantId","adsProfileId","reportJobId","reportDate","adProduct","level","externalCampaignId","campaignName","adGroupId","adGroupName","keywordId","keywordText","matchType","searchTerm","rowKey","impressions","clicks","cost","sales","purchases","currency","raw","sourceUpdatedAt","createdAt","updatedAt")
SELECT "id","tenantId","adsProfileId","reportJobId","reportDate","adProduct","level","externalCampaignId","campaignName","adGroupId","adGroupName","keywordId","keywordText","matchType","searchTerm","rowKey","impressions","clicks","cost","sales","purchases","currency","raw","sourceUpdatedAt","createdAt","updatedAt"
FROM "AdsTermMetric_legacy";

-- ============================================================
-- 八、AuditEvent（分区列 occurredAt，新增，回填为 createdAt）
-- ============================================================

SELECT nova_retire_table('"AuditEvent"'::regclass);

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
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id", "occurredAt")
) PARTITION BY RANGE ("occurredAt");

CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");
CREATE INDEX "AuditEvent_tenantId_occurredAt_idx" ON "AuditEvent"("tenantId", "occurredAt");
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
DECLARE lo timestamp; hi timestamp;
BEGIN
  SELECT min("createdAt"), max("createdAt") INTO lo, hi FROM "AuditEvent_legacy";
  PERFORM nova_ensure_partitions_around('"AuditEvent"'::regclass, lo, hi, 3);
END $$;

INSERT INTO "AuditEvent" ("id","tenantId","actorId","action","resourceType","resourceId","requestId","result","detail","occurredAt","createdAt")
SELECT "id","tenantId","actorId","action","resourceType","resourceId","requestId","result","detail","createdAt","createdAt"
FROM "AuditEvent_legacy";

-- ============================================================
-- 九、核对行数并删除旧表（任何不一致都会让整个迁移回滚）
-- ============================================================

DO $$
DECLARE
  pair record;
  old_count bigint;
  new_count bigint;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('Order'), ('OrderItem'), ('FbaFinancialTransaction'), ('FbaFeeEvent'),
      ('AdsMetric'), ('AdsTermMetric'), ('AuditEvent')
    ) AS t(name)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', pair.name || '_legacy') INTO old_count;
    EXECUTE format('SELECT count(*) FROM %I', pair.name) INTO new_count;
    IF old_count <> new_count THEN
      RAISE EXCEPTION '分区迁移行数不一致：% 旧表 % 行，新表 % 行', pair.name, old_count, new_count;
    END IF;
  END LOOP;
END $$;

-- 先删子表再删父表（旧 OrderItem 引用旧 Order）
DROP TABLE "OrderItem_legacy";
DROP TABLE "Order_legacy";
DROP TABLE "FbaFinancialTransaction_legacy";
DROP TABLE "FbaFeeEvent_legacy";
DROP TABLE "AdsMetric_legacy";
DROP TABLE "AdsTermMetric_legacy";
DROP TABLE "AuditEvent_legacy";
