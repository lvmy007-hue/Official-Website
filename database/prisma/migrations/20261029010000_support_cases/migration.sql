-- M-P2b-04 支持案件。
-- 依据：freeze/models.md M-P2b-04；07 章 7.4；14 章 P2b-04；importers.md I-20。
--
-- 内容：
--   一、新表：SupportCase（亚马逊支持案件，只读同步）、SupportContact（沟通记录，只增不改）。
--   二、检查约束：沟通方向取值、沟通数量非负；行级安全与授权（与其他租户表一致）。
--   案件状态与沟通渠道原样保存亚马逊的取值，不加检查约束（亚马逊新增取值时同步不能失败）。
--
-- 回滚方法：见同目录 rollback.sql（删除两张新表；两张表都是亚马逊数据的只读副本，回滚后下一次同步会重新取回，不丢失我方录入的任何内容）。

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amazonCreatedAt" TIMESTAMP(3) NOT NULL,
    "amazonUpdatedAt" TIMESTAMP(3) NOT NULL,
    "amazonResolvedAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "appointmentsJson" JSONB NOT NULL DEFAULT '[]',
    "contactsForUpdatedAt" TIMESTAMP(3),
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "supportCaseId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "senderName" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "attachmentsJson" JSONB NOT NULL DEFAULT '[]',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_uq" ON "SupportCase"("sellerAccountId", "caseId");

-- CreateIndex
CREATE INDEX "SupportCase_upd_idx" ON "SupportCase"("tenantId", "amazonUpdatedAt");

-- CreateIndex
CREATE INDEX "SupportCase_cre_idx" ON "SupportCase"("tenantId", "amazonCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportContact_uq" ON "SupportContact"("supportCaseId", "contactId");

-- CreateIndex
CREATE INDEX "SupportContact_store_idx" ON "SupportContact"("sellerAccountId");

-- CreateIndex
CREATE INDEX "SupportContact_time_idx" ON "SupportContact"("tenantId", "supportCaseId", "occurredAt");

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportContact" ADD CONSTRAINT "SupportContact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportContact" ADD CONSTRAINT "SupportContact_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportContact" ADD CONSTRAINT "SupportContact_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：沟通方向由我方判断后写入，只有三种取值；沟通数量非负
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_check" CHECK ("contactCount" >= 0);
ALTER TABLE "SupportContact" ADD CONSTRAINT "SupportContact_check" CHECK ("direction" IN ('FROM_AMAZON', 'FROM_SELLER', 'UNKNOWN'));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['SupportCase', 'SupportContact'] LOOP
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
