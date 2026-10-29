-- M-P1-20：任务与队列体系（12 章 12.3）。
-- 1. 同步任务扩展：数据域、去重来源、优先级、断点、死信标记（重试次数沿用既有 attempts，见 CR-013）。
-- 2. 流程状态机：WorkflowRun / WorkflowStep；死信：DeadLetterJob；带租约的分布式锁：DistributedLock。
-- 四张新表都带 tenantId，启用行级安全并向租户连接授权（与 M-P1-16 一致）。
-- 回滚方法见同目录 rollback.sql（回滚会丢弃新增列与四张表里的内容，请先备份）。

-- 1. 同步任务扩展
ALTER TABLE "SyncJob" ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "SyncJob" ADD COLUMN "sourceKey" TEXT;
ALTER TABLE "SyncJob" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "SyncJob" ADD COLUMN "checkpointJson" JSONB;
ALTER TABLE "SyncJob" ADD COLUMN "deadLettered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_priority_check" CHECK ("priority" BETWEEN 1 AND 4);
CREATE INDEX "SyncJob_tenantId_domain_status_idx" ON "SyncJob"("tenantId", "domain", "status");
CREATE INDEX "SyncJob_tenantId_sourceKey_idx" ON "SyncJob"("tenantId", "sourceKey");

-- 2. 流程运行
CREATE TABLE "WorkflowRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "dedupeKey" TEXT,
  "intentJson" JSONB NOT NULL,
  "resultJson" JSONB,
  "checkpointJson" JSONB,
  "errorCode" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 3,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "syncJobId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMP(3),
  "lockOwner" TEXT,
  CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkflowRun_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'COMPENSATED', 'CANCELLED')),
  CONSTRAINT "WorkflowRun_priority_check" CHECK ("priority" BETWEEN 1 AND 4)
);
CREATE UNIQUE INDEX "WorkflowRun_tenantId_kind_dedupeKey_key" ON "WorkflowRun"("tenantId", "kind", "dedupeKey");
CREATE INDEX "WorkflowRun_tenantId_kind_status_idx" ON "WorkflowRun"("tenantId", "kind", "status");
CREATE INDEX "WorkflowRun_status_heartbeatAt_idx" ON "WorkflowRun"("status", "heartbeatAt");
CREATE INDEX "WorkflowRun_syncJobId_idx" ON "WorkflowRun"("syncJobId");
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. 流程步骤
CREATE TABLE "WorkflowStep" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestJson" JSONB,
  "responseJson" JSONB,
  "errorCode" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkflowStep_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'COMPENSATED', 'SKIPPED'))
);
CREATE UNIQUE INDEX "WorkflowStep_runId_seq_key" ON "WorkflowStep"("runId", "seq");
CREATE INDEX "WorkflowStep_tenantId_runId_idx" ON "WorkflowStep"("tenantId", "runId");
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. 死信
CREATE TABLE "DeadLetterJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "queue" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "payloadRef" TEXT NOT NULL,
  "errorCode" TEXT NOT NULL,
  "errorDetail" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "runId" TEXT,
  "syncJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "replayedAt" TIMESTAMP(3),
  "replayedBy" TEXT,
  CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeadLetterJob_tenantId_createdAt_idx" ON "DeadLetterJob"("tenantId", "createdAt");
CREATE INDEX "DeadLetterJob_tenantId_queue_replayedAt_idx" ON "DeadLetterJob"("tenantId", "queue", "replayedAt");
ALTER TABLE "DeadLetterJob" ADD CONSTRAINT "DeadLetterJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. 带租约的分布式锁
CREATE TABLE "DistributedLock" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "lockKey" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "fence" INTEGER NOT NULL DEFAULT 1,
  "leaseUntil" TIMESTAMP(3) NOT NULL,
  "renewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DistributedLock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DistributedLock_tenantId_lockKey_key" ON "DistributedLock"("tenantId", "lockKey");
CREATE INDEX "DistributedLock_leaseUntil_idx" ON "DistributedLock"("leaseUntil");
ALTER TABLE "DistributedLock" ADD CONSTRAINT "DistributedLock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. 行级安全：只放行当前租户的行（与 M-P1-16 同一规则）。
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['WorkflowRun', 'WorkflowStep', 'DeadLetterJob', 'DistributedLock'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
  END LOOP;
END $$;

-- 7. 授权（账号存在才授权）：租户连接可读写；系统连接已有默认权限。
DO $$
DECLARE
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    FOREACH tbl IN ARRAY ARRAY['WorkflowRun', 'WorkflowStep', 'DeadLetterJob', 'DistributedLock'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "WorkflowRun", "WorkflowStep", "DeadLetterJob", "DistributedLock" TO nova_system;
  END IF;
END $$;
