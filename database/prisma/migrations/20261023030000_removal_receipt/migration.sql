-- M-P2a-09 移除退回件收货核对与仓储限额文件导入的来源标注。
-- 依据：freeze/models.md M-P2a-09；06 章 6.5、6.6；14 章 P2a-09；CR-005（权限点 data.import）。
--
-- 内容：
--   一、新增 RemovalReceipt：人工登记的退回件收货记录（应收取自移除订单的已发货数量，不在本表保存）。
--   二、StorageCapacitySnapshot 增加两列：sourceFileName（导入文件名）、importedBy（导入人用户编号），用于“导入后逐项标注来源、采集日期、导入人”。
--   三、检查约束与行级安全、授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除 RemovalReceipt 与两列；收货登记是人工录入的业务记录，回滚前请先导出）。
-- 本迁移不修改、不删除任何既有数据。

-- CreateTable
CREATE TABLE "RemovalReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "removalOrderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "receivedQty" INTEGER NOT NULL,
    "sellableQty" INTEGER NOT NULL,
    "damagedQty" INTEGER NOT NULL,
    "note" TEXT,
    "receivedAt" DATE NOT NULL,
    "receivedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemovalReceipt_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "StorageCapacitySnapshot" ADD COLUMN "sourceFileName" TEXT,
ADD COLUMN "importedBy" TEXT;

-- CreateIndex
CREATE INDEX "RemovalReceipt_store_idx" ON "RemovalReceipt"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "RemovalReceipt_uq" ON "RemovalReceipt"("tenantId", "sellerAccountId", "removalOrderId", "sku", "receivedAt");

-- AddForeignKey
ALTER TABLE "RemovalReceipt" ADD CONSTRAINT "RemovalReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemovalReceipt" ADD CONSTRAINT "RemovalReceipt_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：数量非负；良品与损坏之和不能超过实收
ALTER TABLE "RemovalReceipt" ADD CONSTRAINT "RemovalReceipt_qty_check" CHECK ("receivedQty" >= 0 AND "sellableQty" >= 0 AND "damagedQty" >= 0 AND "sellableQty" + "damagedQty" <= "receivedQty");

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['RemovalReceipt'] LOOP
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
