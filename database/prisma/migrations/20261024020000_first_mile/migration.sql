-- M-P2a-11 头程物流。
-- 依据：freeze/models.md M-P2a-11；06 章 6.10；14 章 P2a-11。
--
-- 内容：
--   一、新表：FreightForwarder（货代）、FirstMileShipment（头程运单）、FirstMileShipmentItem（运单明细，分摊的依据）、
--           FirstMileCost（费用明细）、FirstMileMilestone（运输节点）、LandedCostAllocation（费用分摊结果）、TransitTimeStat（实际时效统计）。
--   二、检查约束：运输方式、清关状态、费用类型、分摊口径、节点来源取值；数量与金额非负。
--   三、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表；运单、费用、节点、分摊结果都是人工录入或系统计算的业务记录，回滚前请先导出）。
-- 本迁移不修改、不删除任何既有数据；分摊写入的成本版本草稿（CostVersion.source = FIRST_MILE_ALLOCATION）留在原表。

-- CreateTable
CREATE TABLE "FreightForwarder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "defaultMode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreightForwarder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstMileShipment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "forwarderId" TEXT NOT NULL,
    "waybillNo" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "containerNo" TEXT,
    "shipDate" DATE,
    "etaPort" DATE,
    "ataPort" DATE,
    "customsStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "etaDelivery" DATE,
    "ataDelivery" DATE,
    "estimatedCost" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "linkedInboundShipmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warehouseId" TEXT,
    "outboundAt" TIMESTAMP(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstMileShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstMileShipmentItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "quantity" INTEGER NOT NULL,
    "cartons" INTEGER,
    "volumeCbm" DECIMAL(14,4),
    "weightKg" DECIMAL(14,4),
    "goodsValue" DECIMAL(20,6),

    CONSTRAINT "FirstMileShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstMileCost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "incurredAt" DATE NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirstMileCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstMileMilestone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "milestone" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirstMileMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostAllocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firstMileShipmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "allocatedAmount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "costVersionId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransitTimeStat" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "forwarderId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "periodMonth" DATE NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "p50Days" INTEGER NOT NULL,
    "p90Days" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransitTimeStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreightForwarder_uq" ON "FreightForwarder"("tenantId", "name");

-- CreateIndex
CREATE INDEX "FirstMileShipment_fwd_idx" ON "FirstMileShipment"("forwarderId");

-- CreateIndex
CREATE INDEX "FirstMileShipment_wh_idx" ON "FirstMileShipment"("warehouseId");

-- CreateIndex
CREATE INDEX "FirstMileShipment_ship_idx" ON "FirstMileShipment"("tenantId", "shipDate");

-- CreateIndex
CREATE UNIQUE INDEX "FirstMileShipment_uq" ON "FirstMileShipment"("tenantId", "forwarderId", "waybillNo");

-- CreateIndex
CREATE INDEX "FirstMileItem_sku_idx" ON "FirstMileShipmentItem"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "FirstMileItem_po_idx" ON "FirstMileShipmentItem"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "FirstMileItem_uq" ON "FirstMileShipmentItem"("shipmentId", "sku");

-- CreateIndex
CREATE INDEX "FirstMileCost_ship_idx" ON "FirstMileCost"("tenantId", "shipmentId");

-- CreateIndex
CREATE INDEX "FirstMileCost_fk_idx" ON "FirstMileCost"("shipmentId");

-- CreateIndex
CREATE INDEX "FirstMileMilestone_time_idx" ON "FirstMileMilestone"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FirstMileMilestone_uq" ON "FirstMileMilestone"("shipmentId", "milestone", "occurredAt");

-- CreateIndex
CREATE INDEX "LandedCost_sku_idx" ON "LandedCostAllocation"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "LandedCost_cv_idx" ON "LandedCostAllocation"("costVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "LandedCost_uq" ON "LandedCostAllocation"("firstMileShipmentId", "sku", "method");

-- CreateIndex
CREATE INDEX "TransitTimeStat_fwd_idx" ON "TransitTimeStat"("forwarderId");

-- CreateIndex
CREATE UNIQUE INDEX "TransitTimeStat_uq" ON "TransitTimeStat"("tenantId", "forwarderId", "mode", "periodMonth");

-- AddForeignKey
ALTER TABLE "FreightForwarder" ADD CONSTRAINT "FreightForwarder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileShipment" ADD CONSTRAINT "FirstMileShipment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileShipment" ADD CONSTRAINT "FirstMileShipment_forwarderId_fkey" FOREIGN KEY ("forwarderId") REFERENCES "FreightForwarder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileShipment" ADD CONSTRAINT "FirstMileShipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileShipmentItem" ADD CONSTRAINT "FirstMileShipmentItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileShipmentItem" ADD CONSTRAINT "FirstMileShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "FirstMileShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileShipmentItem" ADD CONSTRAINT "FirstMileShipmentItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileCost" ADD CONSTRAINT "FirstMileCost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileCost" ADD CONSTRAINT "FirstMileCost_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "FirstMileShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileMilestone" ADD CONSTRAINT "FirstMileMilestone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstMileMilestone" ADD CONSTRAINT "FirstMileMilestone_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "FirstMileShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_firstMileShipmentId_fkey" FOREIGN KEY ("firstMileShipmentId") REFERENCES "FirstMileShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_costVersionId_fkey" FOREIGN KEY ("costVersionId") REFERENCES "CostVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitTimeStat" ADD CONSTRAINT "TransitTimeStat_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitTimeStat" ADD CONSTRAINT "TransitTimeStat_forwarderId_fkey" FOREIGN KEY ("forwarderId") REFERENCES "FreightForwarder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：取值范围、数量与金额非负
ALTER TABLE "FreightForwarder" ADD CONSTRAINT "FreightForwarder_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE') AND ("defaultMode" IS NULL OR "defaultMode" IN ('SEA', 'AIR', 'EXPRESS')) AND "version" >= 1);
ALTER TABLE "FirstMileShipment" ADD CONSTRAINT "FirstMileShipment_check" CHECK ("mode" IN ('SEA', 'AIR', 'EXPRESS') AND "customsStatus" IN ('NOT_STARTED', 'IN_PROGRESS', 'CLEARED', 'HELD') AND ("estimatedCost" IS NULL OR "estimatedCost" >= 0) AND "version" >= 1);
ALTER TABLE "FirstMileShipmentItem" ADD CONSTRAINT "FirstMileItem_check" CHECK ("quantity" > 0 AND ("cartons" IS NULL OR "cartons" >= 0) AND ("volumeCbm" IS NULL OR "volumeCbm" >= 0) AND ("weightKg" IS NULL OR "weightKg" >= 0) AND ("goodsValue" IS NULL OR "goodsValue" >= 0));
ALTER TABLE "FirstMileCost" ADD CONSTRAINT "FirstMileCost_check" CHECK ("item" IN ('FREIGHT', 'CLEARANCE', 'DUTY', 'DELIVERY', 'SURCHARGE') AND "amount" > 0);
ALTER TABLE "FirstMileMilestone" ADD CONSTRAINT "FirstMileMilestone_check" CHECK ("source" IN ('MANUAL', 'FILE_IMPORT', 'API'));
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCost_check" CHECK ("method" IN ('VOLUME', 'WEIGHT', 'VALUE', 'QTY') AND "quantity" > 0 AND "allocatedAmount" >= 0);
ALTER TABLE "TransitTimeStat" ADD CONSTRAINT "TransitTimeStat_check" CHECK ("mode" IN ('SEA', 'AIR', 'EXPRESS') AND "sampleCount" > 0 AND "p50Days" >= 0 AND "p90Days" >= "p50Days");

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['FreightForwarder', 'FirstMileShipment', 'FirstMileShipmentItem', 'FirstMileCost', 'FirstMileMilestone', 'LandedCostAllocation', 'TransitTimeStat'] LOOP
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
