-- M-P2a-08 亚马逊仓储分销（AWD，上游仓储）：库存快照、入库订单、入库货件、货件明细。
-- 依据：freeze/models.md M-P2a-08；06 章 6.3；importers.md I-08；14 章 P2a-08。
--
-- 内容：
--   一、新增 4 张表：AwdInventory（库存快照，按店铺 SKU 与日期）、AwdInboundOrder（入库订单：本地草稿 + 亚马逊订单）、AwdInboundShipment、AwdShipmentItem。
--   二、入库订单的 orderId 可空：本地草稿还没有亚马逊订单编号，提交成功后回填（见 CR-031）；version 用于乐观并发。
--   三、检查约束与行级安全、授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除 4 张表；本地草稿与操作结果是业务记录，回滚前请先导出）。
-- 本迁移不修改、不删除任何既有数据。

-- CreateTable
CREATE TABLE "AwdInventory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "onhandQty" INTEGER,
    "availableQty" INTEGER,
    "reservedForReplenishment" INTEGER,
    "inboundToAwdQty" INTEGER,
    "outboundToFbaInTransit" INTEGER,
    "expiryDate" DATE,
    "expirationJson" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AwdInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwdInboundOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "orderId" TEXT,
    "externalReferenceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'LOCAL_DRAFT',
    "pendingAction" TEXT,
    "expectedUnits" INTEGER,
    "receivedUnits" INTEGER,
    "packageDeliveryMode" TEXT,
    "originAddressJson" JSONB,
    "packagesJson" JSONB,
    "preferredRegion" TEXT,
    "destinationRegion" TEXT,
    "draftJson" JSONB,
    "note" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "amazonCreatedAt" TIMESTAMP(3),
    "amazonUpdatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AwdInboundOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwdInboundShipment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderId" TEXT,
    "externalReferenceId" TEXT,
    "status" TEXT NOT NULL,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "destinationRegion" TEXT,
    "destinationAddressJson" JSONB,
    "shipBy" TIMESTAMP(3),
    "warehouseReferenceId" TEXT,
    "labelStatus" TEXT,
    "labelObjectKey" TEXT,
    "labelFetchedAt" TIMESTAMP(3),
    "amazonCreatedAt" TIMESTAMP(3),
    "amazonUpdatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AwdInboundShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwdShipmentItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "expectedQty" INTEGER,
    "receivedQty" INTEGER,
    "unit" TEXT,
    "expiryDate" DATE,
    "prepInfoJson" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AwdShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AwdInventory_store_idx" ON "AwdInventory"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AwdInventory_uq" ON "AwdInventory"("tenantId", "sellerAccountId", "sku", "snapshotDate");

-- CreateIndex
CREATE INDEX "AwdInboundOrder_store_idx" ON "AwdInboundOrder"("sellerAccountId");

-- CreateIndex
CREATE INDEX "AwdInboundOrder_status_idx" ON "AwdInboundOrder"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AwdInboundOrder_uq" ON "AwdInboundOrder"("tenantId", "sellerAccountId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AwdInboundOrder_ref_uq" ON "AwdInboundOrder"("tenantId", "sellerAccountId", "externalReferenceId");

-- CreateIndex
CREATE INDEX "AwdInboundShipment_store_idx" ON "AwdInboundShipment"("sellerAccountId");

-- CreateIndex
CREATE INDEX "AwdInboundShipment_order_idx" ON "AwdInboundShipment"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AwdInboundShipment_uq" ON "AwdInboundShipment"("tenantId", "sellerAccountId", "shipmentId");

-- CreateIndex
CREATE INDEX "AwdShipmentItem_store_idx" ON "AwdShipmentItem"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AwdShipmentItem_uq" ON "AwdShipmentItem"("tenantId", "sellerAccountId", "shipmentId", "sku");

-- AddForeignKey
ALTER TABLE "AwdInventory" ADD CONSTRAINT "AwdInventory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdInventory" ADD CONSTRAINT "AwdInventory_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdInboundOrder" ADD CONSTRAINT "AwdInboundOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdInboundOrder" ADD CONSTRAINT "AwdInboundOrder_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdInboundShipment" ADD CONSTRAINT "AwdInboundShipment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdInboundShipment" ADD CONSTRAINT "AwdInboundShipment_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdShipmentItem" ADD CONSTRAINT "AwdShipmentItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwdShipmentItem" ADD CONSTRAINT "AwdShipmentItem_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "AwdInventory" ADD CONSTRAINT "AwdInventory_qty_check" CHECK (
  ("onhandQty" IS NULL OR "onhandQty" >= 0) AND ("availableQty" IS NULL OR "availableQty" >= 0) AND ("reservedForReplenishment" IS NULL OR "reservedForReplenishment" >= 0)
  AND ("inboundToAwdQty" IS NULL OR "inboundToAwdQty" >= 0) AND ("outboundToFbaInTransit" IS NULL OR "outboundToFbaInTransit" >= 0)
);
ALTER TABLE "AwdInboundOrder" ADD CONSTRAINT "AwdInboundOrder_status_check" CHECK ("status" IN ('LOCAL_DRAFT', 'CREATE_FAILED', 'DRAFT', 'VALIDATING', 'CONFIRMED', 'CLOSED', 'EXPIRED', 'CANCELLED'));
ALTER TABLE "AwdInboundOrder" ADD CONSTRAINT "AwdInboundOrder_pending_check" CHECK ("pendingAction" IS NULL OR "pendingAction" IN ('CREATE', 'UPDATE', 'CONFIRM', 'CANCEL', 'TRANSPORT'));
ALTER TABLE "AwdInboundOrder" ADD CONSTRAINT "AwdInboundOrder_units_check" CHECK (("expectedUnits" IS NULL OR "expectedUnits" >= 0) AND ("receivedUnits" IS NULL OR "receivedUnits" >= 0) AND "version" >= 1);
-- 本地状态（草稿、提交失败）可以没有亚马逊订单编号；除这两种之外必须有
ALTER TABLE "AwdInboundOrder" ADD CONSTRAINT "AwdInboundOrder_order_check" CHECK ("orderId" IS NOT NULL OR "status" IN ('LOCAL_DRAFT', 'CREATE_FAILED', 'CANCELLED'));
ALTER TABLE "AwdInboundShipment" ADD CONSTRAINT "AwdInboundShipment_status_check" CHECK ("status" IN ('CREATED', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'DELIVERED', 'CLOSED', 'CANCELLED', 'UNKNOWN'));
ALTER TABLE "AwdShipmentItem" ADD CONSTRAINT "AwdShipmentItem_qty_check" CHECK (("expectedQty" IS NULL OR "expectedQty" >= 0) AND ("receivedQty" IS NULL OR "receivedQty" >= 0));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AwdInventory', 'AwdInboundOrder', 'AwdInboundShipment', 'AwdShipmentItem'] LOOP
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