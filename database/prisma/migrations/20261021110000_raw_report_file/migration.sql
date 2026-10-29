-- M-P1-23：原始报告文件登记（models.md `RawReportFile`）。
-- 文件本体放对象存储，库里只登记路径、大小与内容摘要；同一店铺内摘要相同的文件只登记一次。
-- 带 tenantId，启用行级安全并向租户连接授权（与 M-P1-16 一致）。
-- 回滚方法见同目录 rollback.sql（回滚只丢弃登记，对象存储里的文件不受影响，需另行清理）。

CREATE TABLE "RawReportFile" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "storeKey" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "sourceKey" TEXT NOT NULL,
  "reportType" TEXT,
  "reportId" TEXT,
  "objectKey" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL DEFAULT 0,
  "sha256" TEXT NOT NULL,
  "rowCount" INTEGER,
  "periodStart" DATE,
  "periodEnd" DATE,
  "storedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retentionUntil" TIMESTAMP(3),
  CONSTRAINT "RawReportFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RawReportFile_sizeBytes_check" CHECK ("sizeBytes" >= 0)
);
CREATE UNIQUE INDEX "RawReportFile_tenantId_storeKey_sha256_key" ON "RawReportFile"("tenantId", "storeKey", "sha256");
CREATE INDEX "RawReportFile_tenantId_sourceKey_storedAt_idx" ON "RawReportFile"("tenantId", "sourceKey", "storedAt");
CREATE INDEX "RawReportFile_retentionUntil_idx" ON "RawReportFile"("retentionUntil");
ALTER TABLE "RawReportFile" ADD CONSTRAINT "RawReportFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全：只放行当前租户的行（与 M-P1-16 同一规则）。
ALTER TABLE "RawReportFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RawReportFile" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));

-- 授权（账号存在才授权）：租户连接可读写；系统连接用于到期清理。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "RawReportFile" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "RawReportFile" TO nova_system;
  END IF;
END $$;
