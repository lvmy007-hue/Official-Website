-- M-P6-29 新品定价试算记录
-- 依据：14 章 P6-29；16 章第 10 节；freeze/models.md `PricingCalcRecord`。
--
-- 内容：
--   一、新表 PricingCalcRecord：采购成本、头程、尺寸重量、售价、品类放在 inputJson，费用与利润放在 resultJson；
--       inputHash 是规范化输入的摘要，24 小时内同样参数复用最近一条（不另用 Redis）；
--       saved 区分缓存行和用户保存的记录（name 可空）；
--   二、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表；已保存的试算记录丢失）。

-- CreateTable
CREATE TABLE "PricingCalcRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "inputHash" TEXT NOT NULL,
    "inputJson" JSONB NOT NULL,
    "resultJson" JSONB NOT NULL,
    "estimatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingCalcRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingCalcRecord_hash_idx" ON "PricingCalcRecord"("tenantId", "inputHash", "estimatedAt");
CREATE INDEX "PricingCalcRecord_owner_idx" ON "PricingCalcRecord"("tenantId", "createdBy", "estimatedAt");

-- AddForeignKey
ALTER TABLE "PricingCalcRecord" ADD CONSTRAINT "PricingCalcRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['PricingCalcRecord'] LOOP
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
