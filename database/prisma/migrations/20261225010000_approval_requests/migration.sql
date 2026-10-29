-- M-P6-27 审批收件箱：统一的审批记录表
-- 依据：14 章 P6-27；16 章第 1 节；freeze/models.md `ApprovalRequest`。
--
-- 内容：
--   一、新表 ApprovalRequest：各模块原有的审批（财务口径、利润公式与业务口径、关账）与后续接入的人工确认都在这里登记一行；
--       type、status 限定取值；同一对象同一类型至多一条待处理（部分唯一索引）；approverIds / ccIds 是数组；version 是乐观锁；
--       decidedBy、decidedAt 同有或同无；非待处理状态必须有处理人与处理时间（撤销可以没有处理时间之外的信息，但仍须有 decidedAt）；
--   二、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表；收件箱登记丢失，各模块自己的审批状态不受影响）。

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "requesterId" TEXT NOT NULL,
    "approverIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ccIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalRequest_requester_idx" ON "ApprovalRequest"("tenantId", "requesterId", "createdAt");
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("tenantId", "status", "createdAt");
CREATE INDEX "ApprovalRequest_object_idx" ON "ApprovalRequest"("tenantId", "type", "objectType", "objectId");
-- 同一对象同一类型同一时刻至多一条待处理
CREATE UNIQUE INDEX "ApprovalRequest_pending_uq" ON "ApprovalRequest"("tenantId", "type", "objectType", "objectId") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 约束
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_check" CHECK (
  "type" IN ('FINANCE_POLICY', 'PROFIT_FORMULA', 'PERIOD_CLOSE', 'PRICING_RULE_CONFIRM', 'ADS_RULE_CONFIRM', 'BULK_PRICE', 'BULK_BUDGET')
  AND "status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')
  AND length("title") BETWEEN 1 AND 200
  AND length("objectType") BETWEEN 1 AND 60
  AND length("objectId") BETWEEN 1 AND 100
  AND (("decidedBy" IS NULL AND "decidedAt" IS NULL) OR ("decidedAt" IS NOT NULL))
  AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
  AND "version" >= 1
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ApprovalRequest'] LOOP
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
