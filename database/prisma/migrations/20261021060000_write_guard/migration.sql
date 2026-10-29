-- M-P1-14：写接口横向规则。幂等记录、再次验证身份记录；审计事件扩展（修改前后、来源、再次验证、原因）。
-- 回滚方法见同目录 rollback.sql（本迁移只新增表与列，回滚会丢弃新增列里的内容，请先备份）。

-- 1. 幂等记录：同一企业同一路由同一幂等键 24 小时内只执行一次。
CREATE TABLE "IdempotencyRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "responseStatus" INTEGER,
  "responseJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyRecord_tenantId_key_route_key" ON "IdempotencyRecord"("tenantId", "key", "route");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. 再次验证身份记录：按用户与操作计，有效期 10 分钟。
CREATE TABLE "StepUpVerification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StepUpVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StepUpVerification_method_check" CHECK ("method" IN ('PASSWORD', 'TOTP'))
);
CREATE INDEX "StepUpVerification_tenantId_userId_action_expiresAt_idx" ON "StepUpVerification"("tenantId", "userId", "action", "expiresAt");
CREATE INDEX "StepUpVerification_userId_action_expiresAt_idx" ON "StepUpVerification"("userId", "action", "expiresAt");
ALTER TABLE "StepUpVerification" ADD CONSTRAINT "StepUpVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StepUpVerification" ADD CONSTRAINT "StepUpVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. 审计事件扩展（分区表，直接加列）。
ALTER TABLE "AuditEvent" ADD COLUMN "beforeJson" JSONB;
ALTER TABLE "AuditEvent" ADD COLUMN "afterJson" JSONB;
ALTER TABLE "AuditEvent" ADD COLUMN "ip" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "writeRunId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "stepUpId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "reason" TEXT;
-- 按对象查看变更记录（详情页“变更记录”）。
CREATE INDEX "AuditEvent_tenantId_resourceType_resourceId_idx" ON "AuditEvent"("tenantId", "resourceType", "resourceId");