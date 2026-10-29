-- M-P6-19 店铺级费用分摊规则、关账快照的口径版本列
-- 依据：14 章 P6-19；16 章第 7 节；09 章 9.12；freeze/models.md 第二十一节（AllocationRule 新增、PeriodSnapshot 加 metricVersionSnapshotJson）。
--
-- 内容：
--   一、新表 AllocationRule：某费用项（ProfitItem）从某月（当月第一天）起的分摊依据；同一费用项同一生效月只有一条（唯一键），
--       取不晚于所算月份的最近一条生效；basis 限定五种；manualWeights 只在 MANUAL 时有值且必须是 JSON 对象；version 是乐观锁；
--   二、PeriodSnapshot 加 metricVersionSnapshotJson（可空）：关账时各类口径版本的快照，本包先写分摊规则；旧快照为空，表示关账时还没有口径版本；
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除 AllocationRule 与 PeriodSnapshot 的新列；规则与快照里的规则版本丢失，利润日表下次重算后回到“店铺级费用不分摊”）。

-- AlterTable
ALTER TABLE "PeriodSnapshot" ADD COLUMN "metricVersionSnapshotJson" JSONB;
ALTER TABLE "PeriodSnapshot" ADD CONSTRAINT "PeriodSnapshot_metricVersion_check" CHECK ("metricVersionSnapshotJson" IS NULL OR jsonb_typeof("metricVersionSnapshotJson") = 'object');

-- CreateTable
CREATE TABLE "AllocationRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "feeItemId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "manualWeights" JSONB,
    "effectiveMonth" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllocationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AllocationRule_uq" ON "AllocationRule"("tenantId", "feeItemId", "effectiveMonth");
CREATE INDEX "AllocationRule_item_idx" ON "AllocationRule"("feeItemId");

-- AddForeignKey
ALTER TABLE "AllocationRule" ADD CONSTRAINT "AllocationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AllocationRule" ADD CONSTRAINT "AllocationRule_feeItemId_fkey" FOREIGN KEY ("feeItemId") REFERENCES "ProfitItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 约束：依据限定五种；生效月必须是当月第一天；手动比例只在 MANUAL 时有值，且是 JSON 对象；版本号从 1 起
ALTER TABLE "AllocationRule" ADD CONSTRAINT "AllocationRule_check" CHECK (
  "basis" IN ('SALES_AMOUNT', 'SALES_UNITS', 'SHIPMENT_RECEIVED_UNITS', 'REMOVAL_ORDER_SKU', 'MANUAL')
  AND EXTRACT(DAY FROM "effectiveMonth") = 1
  AND (("basis" = 'MANUAL' AND "manualWeights" IS NOT NULL AND jsonb_typeof("manualWeights") = 'object')
       OR ("basis" <> 'MANUAL' AND "manualWeights" IS NULL))
  AND "version" >= 1
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AllocationRule'] LOOP
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
