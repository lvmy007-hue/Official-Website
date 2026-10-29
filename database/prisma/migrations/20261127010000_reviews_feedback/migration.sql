-- M-P4-13 评价与反馈。
-- 依据：freeze/models.md 九、定价、竞品、评价与内容（ReviewMetricSnapshot、ReviewTopic、BrowseNodeReviewTrend、BrowseNodeReturnTrend、SolicitationRequest）；05 章 5.7；14 章 P4-13；importers.md I-15、I-16、F-01。
--
-- 内容：
--   一、新表：ReviewMetricSnapshot（评分文件导入，字段级标注来源）、ReviewTopic（商品评论主题）、BrowseNodeReviewTrend（类目评论主题趋势）、
--         BrowseNodeReturnTrend（类目退货主题趋势）、SolicitationRequest（请求评价记录，每单一次）。
--   二、检查约束、行级安全与授权（与其他租户表一致）。
--
-- 与冻结的出入（详见 CR-088）：
--   ReviewMetricSnapshot 的 sourceFileId 记“导入批次编号”，另加 sourceFileName（导入文件名）；ReviewTopic 多 browseNodeId、browseNodeName、rank；
--   BrowseNodeReviewTrend、BrowseNodeReturnTrend 多 browseNodeName；SolicitationRequest 的状态多一个 QUEUED（已受理、尚未发给亚马逊，用来保证每单只请求一次），
--   并多 asins（受理时订单里的 ASIN）、batchId（后台任务编号）、failureCode、sentAt、marketplaceId。
-- 回滚方法：见同目录 rollback.sql（删除五张新表；评分文件需要重新导入，亚马逊的主题数据下一次同步会重新取回，请求评价的记录会丢失——丢失后同一订单可能被再次请求）。

-- CreateTable
CREATE TABLE "ReviewMetricSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "avgRating" DECIMAL(4,2),
    "ratingCount" INTEGER,
    "distributionJson" JSONB,
    "captureDate" DATE NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'FILE_IMPORT',
    "sourceFileId" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL DEFAULT '',
    "importedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTopic" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "browseNodeId" TEXT,
    "browseNodeName" TEXT,
    "topicKey" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "mentionRange" TEXT,
    "reviewCountBucket" TEXT,
    "snapshotDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowseNodeReviewTrend" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "browseNodeId" TEXT NOT NULL,
    "browseNodeName" TEXT,
    "scope" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "topicKey" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "rate" DECIMAL(10,6) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowseNodeReviewTrend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowseNodeReturnTrend" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "browseNodeId" TEXT NOT NULL,
    "browseNodeName" TEXT,
    "scope" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "returnTopicKey" TEXT NOT NULL,
    "rate" DECIMAL(10,6) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowseNodeReturnTrend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolicitationRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "amazonOrderId" TEXT NOT NULL,
    "asins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "requestedBy" TEXT NOT NULL,
    "writeRunId" TEXT,
    "batchId" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolicitationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewMetricSnapshot_asin_idx" ON "ReviewMetricSnapshot"("tenantId", "sellerAccountId", "asin", "captureDate");

-- CreateIndex
CREATE INDEX "ReviewMetricSnapshot_store_idx" ON "ReviewMetricSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewMetricSnapshot_uq" ON "ReviewMetricSnapshot"("sellerAccountId", "asin", "captureDate");

-- CreateIndex
CREATE INDEX "ReviewTopic_asin_idx" ON "ReviewTopic"("tenantId", "sellerAccountId", "asin", "snapshotDate");

-- CreateIndex
CREATE INDEX "ReviewTopic_store_idx" ON "ReviewTopic"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTopic_uq" ON "ReviewTopic"("sellerAccountId", "asin", "topicKey", "snapshotDate");

-- CreateIndex
CREATE INDEX "BrowseNodeReviewTrend_node_idx" ON "BrowseNodeReviewTrend"("tenantId", "sellerAccountId", "browseNodeId", "month");

-- CreateIndex
CREATE INDEX "BrowseNodeReviewTrend_store_idx" ON "BrowseNodeReviewTrend"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowseNodeReviewTrend_uq" ON "BrowseNodeReviewTrend"("sellerAccountId", "browseNodeId", "scope", "month", "topicKey");

-- CreateIndex
CREATE INDEX "BrowseNodeReturnTrend_node_idx" ON "BrowseNodeReturnTrend"("tenantId", "sellerAccountId", "browseNodeId", "month");

-- CreateIndex
CREATE INDEX "BrowseNodeReturnTrend_store_idx" ON "BrowseNodeReturnTrend"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowseNodeReturnTrend_uq" ON "BrowseNodeReturnTrend"("sellerAccountId", "browseNodeId", "scope", "month", "returnTopicKey");

-- CreateIndex
CREATE INDEX "SolicitationRequest_status_idx" ON "SolicitationRequest"("tenantId", "sellerAccountId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "SolicitationRequest_batch_idx" ON "SolicitationRequest"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "SolicitationRequest_store_idx" ON "SolicitationRequest"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SolicitationRequest_uq" ON "SolicitationRequest"("sellerAccountId", "amazonOrderId");

-- AddForeignKey
ALTER TABLE "ReviewMetricSnapshot" ADD CONSTRAINT "ReviewMetricSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewMetricSnapshot" ADD CONSTRAINT "ReviewMetricSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewTopic" ADD CONSTRAINT "ReviewTopic_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewTopic" ADD CONSTRAINT "ReviewTopic_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowseNodeReviewTrend" ADD CONSTRAINT "BrowseNodeReviewTrend_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowseNodeReviewTrend" ADD CONSTRAINT "BrowseNodeReviewTrend_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowseNodeReturnTrend" ADD CONSTRAINT "BrowseNodeReturnTrend_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowseNodeReturnTrend" ADD CONSTRAINT "BrowseNodeReturnTrend_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitationRequest" ADD CONSTRAINT "SolicitationRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitationRequest" ADD CONSTRAINT "SolicitationRequest_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：来源只有文件导入；星级 1 到 5；评分数不为负；星级与评分数至少有一个；主题情感与范围取值；请求状态取值
ALTER TABLE "ReviewMetricSnapshot" ADD CONSTRAINT "ReviewMetricSnapshot_check" CHECK (
  "sourceKind" = 'FILE_IMPORT'
  AND "asin" ~ '^[A-Z0-9]{10}$'
  AND ("avgRating" IS NULL OR ("avgRating" >= 1 AND "avgRating" <= 5))
  AND ("ratingCount" IS NULL OR "ratingCount" >= 0)
  AND ("avgRating" IS NOT NULL OR "ratingCount" IS NOT NULL)
);
ALTER TABLE "ReviewTopic" ADD CONSTRAINT "ReviewTopic_check" CHECK (
  "sentiment" IN ('POSITIVE', 'NEGATIVE')
  AND "rank" >= 1
  AND length("topicKey") > 0
);
ALTER TABLE "BrowseNodeReviewTrend" ADD CONSTRAINT "BrowseNodeReviewTrend_check" CHECK (
  "scope" IN ('ALL', 'TOP25')
  AND "sentiment" IN ('POSITIVE', 'NEGATIVE')
  AND "rate" >= 0
);
ALTER TABLE "BrowseNodeReturnTrend" ADD CONSTRAINT "BrowseNodeReturnTrend_check" CHECK (
  "scope" IN ('ALL', 'TOP25')
  AND "rate" >= 0
);
ALTER TABLE "SolicitationRequest" ADD CONSTRAINT "SolicitationRequest_check" CHECK (
  "status" IN ('QUEUED', 'REQUESTED', 'UNAVAILABLE', 'WINDOW_CLOSED', 'FAILED')
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ReviewMetricSnapshot', 'ReviewTopic', 'BrowseNodeReviewTrend', 'BrowseNodeReturnTrend', 'SolicitationRequest'] LOOP
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
