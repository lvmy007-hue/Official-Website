-- M-P4-10 刊登质量与合规。
-- 依据：freeze/models.md 八、商品与刊登（M-P4-09 的 ListingSnapshot、ListingIssue、ListingChangeEvent 三张表在 P4-09 没有交付，随本包建立）；05 章 5.4；14 章 P4-10；importers.md I-10、I-11、I-23、R-32、N-08 至 N-12。
--
-- 内容：
--   一、新表：ListingSnapshot（刊登当前状态，一个 店铺 × SKU 一行）、ListingIssue（刊登问题与生命周期）、ListingChangeEvent（商品类型变更与内容变更）、
--       ListingWriteRun（校验预览、修改刊登、批量刊登任务、刊登限制查询的任务记录）。
--   二、检查约束：取值范围、计数与时间先后；行级安全与授权（与其他租户表一致）。
--
-- 与冻结的出入：ListingSnapshot 不是“每日快照”而是当前状态行（带 statusSince），ListingChangeEvent 的唯一键加了 sellerSku、fieldPath、sourceRef，详见 CR-085。
-- 回滚方法：见同目录 rollback.sql（删除四张新表；前三张是亚马逊数据的只读副本，下一次同步会重新取回；ListingWriteRun 里的任务记录会丢失，亚马逊侧的修改不受影响）。

-- CreateTable
CREATE TABLE "ListingSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "sellerSku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "productType" TEXT,
    "conditionType" TEXT,
    "status" TEXT NOT NULL,
    "amazonStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statusSince" TIMESTAMP(3) NOT NULL,
    "itemName" TEXT,
    "mainImageUrl" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "sellerSku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "issueKind" TEXT NOT NULL,
    "issueCode" TEXT NOT NULL,
    "attributeName" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL,
    "impact" TEXT NOT NULL DEFAULT 'NONE',
    "message" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "handlingStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "handlingRunId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingChangeEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "sellerSku" TEXT NOT NULL DEFAULT '',
    "asin" TEXT NOT NULL DEFAULT '',
    "changeKind" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL DEFAULT '',
    "beforeText" TEXT,
    "afterText" TEXT,
    "actorKind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "writeRunId" TEXT,
    "sourceRef" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingWriteRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sellerSku" TEXT,
    "productType" TEXT,
    "requestJson" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL DEFAULT '',
    "previewRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "validation" TEXT,
    "issuesJson" JSONB NOT NULL DEFAULT '[]',
    "resultJson" JSONB,
    "feedId" TEXT,
    "feedDocumentId" TEXT,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "requestedBy" TEXT,
    "requestId" TEXT NOT NULL DEFAULT '',
    "syncJobId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ListingWriteRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ListingSnapshot_uq" ON "ListingSnapshot"("sellerAccountId", "marketplaceId", "sellerSku");

-- CreateIndex
CREATE INDEX "ListingSnapshot_status_idx" ON "ListingSnapshot"("tenantId", "status", "statusSince");

-- CreateIndex
CREATE INDEX "ListingSnapshot_store_idx" ON "ListingSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingIssue_uq" ON "ListingIssue"("sellerAccountId", "sellerSku", "issueKind", "issueCode", "attributeName");

-- CreateIndex
CREATE INDEX "ListingIssue_open_idx" ON "ListingIssue"("tenantId", "resolvedAt", "firstSeenAt");

-- CreateIndex
CREATE INDEX "ListingIssue_sku_idx" ON "ListingIssue"("tenantId", "sellerAccountId", "sellerSku");

-- CreateIndex
CREATE INDEX "ListingIssue_store_idx" ON "ListingIssue"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingChangeEvent_uq" ON "ListingChangeEvent"("sellerAccountId", "sellerSku", "changeKind", "fieldPath", "sourceRef");

-- CreateIndex
CREATE INDEX "ListingChangeEvent_time_idx" ON "ListingChangeEvent"("tenantId", "changeKind", "occurredAt");

-- CreateIndex
CREATE INDEX "ListingChangeEvent_store_idx" ON "ListingChangeEvent"("sellerAccountId");

-- CreateIndex
CREATE INDEX "ListingWriteRun_kind_idx" ON "ListingWriteRun"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ListingWriteRun_sku_idx" ON "ListingWriteRun"("tenantId", "sellerAccountId", "sellerSku", "status");

-- CreateIndex
CREATE INDEX "ListingWriteRun_store_idx" ON "ListingWriteRun"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "ListingSnapshot" ADD CONSTRAINT "ListingSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingSnapshot" ADD CONSTRAINT "ListingSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingChangeEvent" ADD CONSTRAINT "ListingChangeEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingChangeEvent" ADD CONSTRAINT "ListingChangeEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingWriteRun" ADD CONSTRAINT "ListingWriteRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingWriteRun" ADD CONSTRAINT "ListingWriteRun_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：取值范围、版本与计数、解决时间不早于首次出现
ALTER TABLE "ListingSnapshot" ADD CONSTRAINT "ListingSnapshot_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE'));
ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_check" CHECK (
  "issueKind" IN ('ISSUE', 'SEARCH_SUPPRESSED', 'COMPLIANCE')
  AND "severity" IN ('ERROR', 'WARNING')
  AND "impact" IN ('NONE', 'SEARCH_SUPPRESSED', 'ATTRIBUTE_SUPPRESSED', 'LISTING_SUPPRESSED')
  AND "handlingStatus" IN ('OPEN', 'IN_PROGRESS')
  AND "version" >= 1
  AND ("resolvedAt" IS NULL OR "resolvedAt" >= "firstSeenAt")
);
ALTER TABLE "ListingChangeEvent" ADD CONSTRAINT "ListingChangeEvent_check" CHECK ("changeKind" IN ('PRODUCT_TYPE_CHANGE', 'CONTENT_CHANGE') AND "actorKind" IN ('SELF', 'AMAZON', 'OTHER', 'UNKNOWN'));
ALTER TABLE "ListingWriteRun" ADD CONSTRAINT "ListingWriteRun_check" CHECK (
  "kind" IN ('VALIDATE', 'PATCH', 'BATCH', 'RESTRICTIONS')
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
  FOREACH tbl IN ARRAY ARRAY['ListingSnapshot', 'ListingIssue', 'ListingChangeEvent', 'ListingWriteRun'] LOOP
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
