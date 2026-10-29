-- M-P6-20 预估与自定义费用、利润日表的估算列
-- 依据：14 章 P6-20；16 章第 7 节；freeze/models.md `EstimatedFee`。
--
-- 内容：
--   一、新表 EstimatedFee：某费用项（ProfitItem，自定义项目挂在利润项目字典上）在某范围（店铺、SKU、品类）从 from 到 to（含）的预估口径；
--       scopeType、mode、period、status 限定取值；固定金额不为负、销售额比例在 0 到 100 之间；to 不早于 from；version 是乐观锁；
--   二、ProfitDaily 加 estimatedFee（可空）：这一行里估算计入的花费合计（已包含在各费用列与净利润里，只用来标注“含估算”）；旧行为空，下一次重算（每 6 小时近 45 天）才会补上；
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除 EstimatedFee 与 ProfitDaily.estimatedFee；预估费用丢失，下次重算后利润里不再含估算）。

-- AlterTable
ALTER TABLE "ProfitDaily" ADD COLUMN "estimatedFee" DECIMAL(20,6);
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_estimatedFee_check" CHECK ("estimatedFee" IS NULL OR "estimatedFee" >= 0);

-- CreateTable
CREATE TABLE "EstimatedFee" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "period" TEXT NOT NULL,
    "from" DATE NOT NULL,
    "to" DATE,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EstimatedFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EstimatedFee_scope_idx" ON "EstimatedFee"("tenantId", "scopeType", "scopeId", "from");
CREATE INDEX "EstimatedFee_item_idx" ON "EstimatedFee"("itemId");

-- AddForeignKey
ALTER TABLE "EstimatedFee" ADD CONSTRAINT "EstimatedFee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EstimatedFee" ADD CONSTRAINT "EstimatedFee_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ProfitItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 约束：范围、方式、周期、状态限定取值；金额不为负；比例 0 到 100；币种三位大写字母；截止日不早于起始日；版本号从 1 起
ALTER TABLE "EstimatedFee" ADD CONSTRAINT "EstimatedFee_check" CHECK (
  "scopeType" IN ('STORE', 'SKU', 'CATEGORY')
  AND "mode" IN ('FIXED', 'PERCENT_OF_SALES')
  AND "period" IN ('DAILY', 'MONTHLY')
  AND "status" IN ('ACTIVE', 'INACTIVE')
  AND "value" >= 0
  AND ("mode" <> 'PERCENT_OF_SALES' OR "value" <= 100)
  AND "currency" ~ '^[A-Z]{3}$'
  AND ("to" IS NULL OR "to" >= "from")
  AND "version" >= 1
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['EstimatedFee'] LOOP
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
