-- 回滚 M-P5-12：按删除前的结构重建空的 InventorySnapshot（含来源列、同步时间触发器、行级安全与授权）。
-- 已经迁入 InventoryDailySnapshot 的历史行仍在当日快照表里，不会从这里复制回来。
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "available" INTEGER NOT NULL DEFAULT 0,
    "inbound" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventorySnapshot_sellerAccountId_sku_key" ON "InventorySnapshot"("sellerAccountId", "sku");
CREATE INDEX "InventorySnapshot_tenantId_available_idx" ON "InventorySnapshot"("tenantId", "available");

ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "InventorySnapshot_touch_synced_at" BEFORE UPDATE ON "InventorySnapshot" FOR EACH ROW EXECUTE FUNCTION nova_touch_synced_at();

ALTER TABLE "InventorySnapshot" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventorySnapshot" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InventorySnapshot" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InventorySnapshot" TO nova_system;
  END IF;
END $$;
