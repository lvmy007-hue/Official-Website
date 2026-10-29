-- M-P3-14 广告变更记录：新增 AdsEntitySnapshot（实体快照）与 AdsChangeLog（变更记录）。
-- 依据：freeze/models.md M-P3-14、08 章 8.11、14 章 P3-14。
--
-- 内容：
--   一、AdsEntitySnapshot：worker 定时读已同步的广告实体（活动、广告组、投放对象、关键词、广告组合）里“用户可改的字段”，规整成文字后算哈希；
--      同一对象的哈希变了才新增一行（没变不存），用来识别亚马逊侧或其他工具做的外部变更。entityId 是对象的系统编号。
--   二、AdsChangeLog：一行 = 一个对象的一个字段改了一次。actorKind 取 MANUAL / AUTO_RULE / DAYPARTING / EXTERNAL；
--      前三类随 P3-17 的广告写入记录，EXTERNAL 由快照对比识别（occurredAt 是检测时间，sinceAt 是上一次快照时间）。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：冻结按 adsAccountId 建键，这里按广告档案（AdsProfile.adsAccountId 可空，范围过滤也经档案绑定的店铺），键里多了 tenantId；
--   AdsChangeLog 多了 entityLabel（当时的名称）、actorId（手动变更的操作人）、sinceAt。
--
-- 回滚方法：见同目录 rollback.sql（删除两张表；快照与外部变更记录可由 worker 重新生成，但丢失的历史变更无法找回）。

-- CreateTable
CREATE TABLE "AdsEntitySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "stateJson" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsEntitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsChangeLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "changedField" TEXT NOT NULL,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sinceAt" TIMESTAMP(3),
    "writeRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdsEntitySnapshot_uq" ON "AdsEntitySnapshot"("tenantId", "adsProfileId", "entityType", "entityId", "snapshotAt");

-- CreateIndex
CREATE INDEX "AdsEntitySnapshot_profile_idx" ON "AdsEntitySnapshot"("adsProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsChangeLog_uq" ON "AdsChangeLog"("tenantId", "adsProfileId", "entityType", "entityId", "changedField", "occurredAt");

-- CreateIndex
CREATE INDEX "AdsChangeLog_tenant_idx" ON "AdsChangeLog"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "AdsChangeLog_profile_idx" ON "AdsChangeLog"("adsProfileId");

-- AddForeignKey
ALTER TABLE "AdsEntitySnapshot" ADD CONSTRAINT "AdsEntitySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsEntitySnapshot" ADD CONSTRAINT "AdsEntitySnapshot_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsChangeLog" ADD CONSTRAINT "AdsChangeLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsChangeLog" ADD CONSTRAINT "AdsChangeLog_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "AdsEntitySnapshot" ADD CONSTRAINT "AdsEntitySnapshot_type_check" CHECK ("entityType" IN ('CAMPAIGN', 'AD_GROUP', 'TARGET', 'KEYWORD', 'PORTFOLIO'));
ALTER TABLE "AdsEntitySnapshot" ADD CONSTRAINT "AdsEntitySnapshot_state_check" CHECK (jsonb_typeof("stateJson") = 'object');
ALTER TABLE "AdsEntitySnapshot" ADD CONSTRAINT "AdsEntitySnapshot_hash_check" CHECK (length("hash") > 0);
ALTER TABLE "AdsChangeLog" ADD CONSTRAINT "AdsChangeLog_type_check" CHECK ("entityType" IN ('CAMPAIGN', 'AD_GROUP', 'TARGET', 'KEYWORD', 'PORTFOLIO'));
ALTER TABLE "AdsChangeLog" ADD CONSTRAINT "AdsChangeLog_actor_check" CHECK ("actorKind" IN ('MANUAL', 'AUTO_RULE', 'DAYPARTING', 'EXTERNAL'));
-- 只有手动变更才有操作人；外部变更不知道是谁改的
ALTER TABLE "AdsChangeLog" ADD CONSTRAINT "AdsChangeLog_actor_id_check" CHECK ("actorId" IS NULL OR "actorKind" = 'MANUAL');
-- 上一次快照的时间只属于外部变更，且不晚于检测时间
ALTER TABLE "AdsChangeLog" ADD CONSTRAINT "AdsChangeLog_since_check" CHECK ("sinceAt" IS NULL OR ("actorKind" = 'EXTERNAL' AND "sinceAt" <= "occurredAt"));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AdsEntitySnapshot', 'AdsChangeLog'] LOOP
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
