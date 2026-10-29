-- M-P4-14 A+ 内容。
-- 依据：freeze/models.md 九、定价、竞品、评价与内容（AplusContent、AplusAsinRelation、AplusReviewEvent）；05 章 5.8；14 章 P4-14；importers.md I-18、I-24。
--
-- 内容：
--   一、新表：AplusContent（A+ 内容，含模块结构 draftJson 与乐观锁 version）、AplusAsinRelation（内容与 ASIN 的关联与上线时间）、
--         AplusReviewEvent（审核状态时间线，含亚马逊给的拒绝原文）、AplusWriteRun（创建、修改、关联、上传图片、提交审核的写入记录，冻结表里没有）。
--   二、检查约束、行级安全与授权（与其他租户表一致）。
--
-- 与冻结的出入（详见 CR-089）：
--   冻结用 storeId，实现沿用本项目的 sellerAccountId，并多一个 marketplaceId；contentReferenceKey 可以为空（本地新建、亚马逊尚未创建成功的草稿），
--   所以唯一键对非空的键生效（PostgreSQL 的唯一约束允许多个空值）；AplusContent 多 locale、version、amazonUpdatedAt、publishedAt、lastSyncedAt、createdBy；
--   AplusAsinRelation 以内容编号（contentId）而不是引用键关联，多 publishedAt（发布记录里的上线时间）与 lastSeenAt；
--   AplusReviewEvent 的状态多一个 PUBLISHED，多 source（SYNC / LOCAL）。
-- 回滚方法：见同目录 rollback.sql（删除四张新表；A+ 内容与关联、审核事件下一次同步会从亚马逊重新取回，本地没有成功创建的草稿与写入记录会丢失）。

-- CreateTable
CREATE TABLE "AplusContent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "contentReferenceKey" TEXT,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'EBC',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "asinCount" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "draftJson" JSONB NOT NULL DEFAULT '{}',
    "amazonUpdatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AplusContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AplusAsinRelation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AplusAsinRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AplusReviewEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SYNC',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AplusReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AplusWriteRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "contentId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestJson" JSONB NOT NULL DEFAULT '{}',
    "resultJson" JSONB,
    "warningsJson" JSONB NOT NULL DEFAULT '[]',
    "failureCode" TEXT,
    "requestedBy" TEXT,
    "requestId" TEXT NOT NULL DEFAULT '',
    "syncJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AplusWriteRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AplusContent_status_idx" ON "AplusContent"("tenantId", "sellerAccountId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AplusContent_store_idx" ON "AplusContent"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AplusContent_uq" ON "AplusContent"("sellerAccountId", "marketplaceId", "contentReferenceKey");

-- CreateIndex
CREATE INDEX "AplusAsinRelation_asin_idx" ON "AplusAsinRelation"("tenantId", "sellerAccountId", "asin");

-- CreateIndex
CREATE INDEX "AplusAsinRelation_store_idx" ON "AplusAsinRelation"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AplusAsinRelation_uq" ON "AplusAsinRelation"("contentId", "asin");

-- CreateIndex
CREATE INDEX "AplusReviewEvent_time_idx" ON "AplusReviewEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AplusReviewEvent_uq" ON "AplusReviewEvent"("contentId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "AplusWriteRun_kind_idx" ON "AplusWriteRun"("tenantId", "sellerAccountId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AplusWriteRun_content_idx" ON "AplusWriteRun"("contentId", "status");

-- CreateIndex
CREATE INDEX "AplusWriteRun_store_idx" ON "AplusWriteRun"("sellerAccountId");

-- AddForeignKey
ALTER TABLE "AplusContent" ADD CONSTRAINT "AplusContent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusContent" ADD CONSTRAINT "AplusContent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusAsinRelation" ADD CONSTRAINT "AplusAsinRelation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusAsinRelation" ADD CONSTRAINT "AplusAsinRelation_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "AplusContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusAsinRelation" ADD CONSTRAINT "AplusAsinRelation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusReviewEvent" ADD CONSTRAINT "AplusReviewEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusReviewEvent" ADD CONSTRAINT "AplusReviewEvent_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "AplusContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusWriteRun" ADD CONSTRAINT "AplusWriteRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusWriteRun" ADD CONSTRAINT "AplusWriteRun_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AplusWriteRun" ADD CONSTRAINT "AplusWriteRun_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "AplusContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：内容状态与类型、版本号与关联数不为负、ASIN 格式；审核事件的状态与来源；写入记录的类型与状态
ALTER TABLE "AplusContent" ADD CONSTRAINT "AplusContent_check" CHECK (
  "status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PUBLISHED')
  AND "contentType" IN ('EBC', 'EMC')
  AND "version" >= 1
  AND "asinCount" >= 0
  AND length("name") > 0
);
ALTER TABLE "AplusAsinRelation" ADD CONSTRAINT "AplusAsinRelation_check" CHECK ("asin" ~ '^[A-Z0-9]{10}$');
ALTER TABLE "AplusReviewEvent" ADD CONSTRAINT "AplusReviewEvent_check" CHECK (
  "status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PUBLISHED')
  AND "source" IN ('SYNC', 'LOCAL')
);
ALTER TABLE "AplusWriteRun" ADD CONSTRAINT "AplusWriteRun_check" CHECK (
  "kind" IN ('CREATE', 'UPDATE', 'ASSOCIATE', 'UPLOAD', 'SUBMIT')
  AND "status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')
  AND ("kind" = 'UPLOAD' OR "contentId" IS NOT NULL)
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AplusContent', 'AplusAsinRelation', 'AplusReviewEvent', 'AplusWriteRun'] LOOP
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
