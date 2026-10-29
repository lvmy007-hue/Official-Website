-- M-P2a-12 入仓计划（Fulfillment Inbound v2024-03-20）。
-- 依据：freeze/models.md M-P2a-12；06 章 6.11；01 章 1.7 第 1 条；14 章 P2a-12。
--
-- 内容：
--   一、FbaInboundPlan 加列（我方状态链 stage、来源、待处理操作、已选方案、作废窗口、成本估算、卖家自理成本、版本号）；
--       FbaInboundShipment 加列（货件确认号、首次接收与接收完成时间、承运商、追踪明细）。
--   二、新表：InboundPlanItem、InboundEligibilityCheck、PackingOption、PackingGroup、InboundBox（冻结文档里叫 Box）、PlacementOption、
--           TransportOption、DeliveryWindow、ShipmentItem、TrackingEvent、LabelPrintJob、InboundOperation。
--   三、检查约束：预处理方与贴标方固定为卖家（美国站 2026-01-01 起亚马逊不再提供预处理与贴标）；状态与取值范围；数量非负。
--   四、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表与新增列；回滚前请先导出）。
-- 既有计划：已有亚马逊计划编号的旧计划把 stage 补成 CREATED，其余保持 DRAFT；旧的 status 列不改动。
-- AlterTable
ALTER TABLE "FbaInboundPlan" ADD COLUMN     "costCurrency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "estimateJson" JSONB,
ADD COLUMN     "labelCost" DECIMAL(20,6),
ADD COLUMN     "labelOwner" TEXT NOT NULL DEFAULT 'SELLER',
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "lastErrorMessage" TEXT,
ADD COLUMN     "pendingOp" TEXT,
ADD COLUMN     "prepCost" DECIMAL(20,6),
ADD COLUMN     "prepOwner" TEXT NOT NULL DEFAULT 'SELLER',
ADD COLUMN     "selectedPackingOptionId" TEXT,
ADD COLUMN     "selectedPlacementOptionId" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingMode" TEXT,
ADD COLUMN     "sourceRefId" TEXT,
ADD COLUMN     "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "transportConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "voidDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FbaInboundShipment" ADD COLUMN     "boxCount" INTEGER,
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "receivedDoneAt" TIMESTAMP(3),
ADD COLUMN     "receivedFirstAt" TIMESTAMP(3),
ADD COLUMN     "selectedTransportOptionId" TEXT,
ADD COLUMN     "selectedWindowId" TEXT,
ADD COLUMN     "shipmentConfirmationId" TEXT,
ADD COLUMN     "trackingJson" JSONB;

-- CreateTable
CREATE TABLE "InboundPlanItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT,
    "asin" TEXT,
    "productName" TEXT,
    "quantity" INTEGER NOT NULL,
    "expiry" DATE,
    "prepInstruction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEligibilityCheck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "program" TEXT NOT NULL DEFAULT 'INBOUND',
    "eligible" BOOLEAN NOT NULL,
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEligibilityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackingOption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "packingOptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fees" DECIMAL(20,6),
    "discounts" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "expiresAt" TIMESTAMP(3),
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "configsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackingOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackingGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "packingOptionId" TEXT NOT NULL,
    "packingGroupId" TEXT NOT NULL,
    "itemsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackingGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundBox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "packingGroupId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "weightLb" DECIMAL(12,3) NOT NULL,
    "lengthIn" DECIMAL(12,3) NOT NULL,
    "widthIn" DECIMAL(12,3) NOT NULL,
    "heightIn" DECIMAL(12,3) NOT NULL,
    "contentJson" JSONB NOT NULL,
    "labelStatus" TEXT NOT NULL DEFAULT 'NOT_PRINTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundBox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlacementOption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "placementOptionId" TEXT NOT NULL,
    "shipmentCount" INTEGER NOT NULL,
    "fees" DECIMAL(20,6) NOT NULL,
    "discounts" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "shipmentsJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlacementOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportOption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "transportOptionId" TEXT NOT NULL,
    "carrier" TEXT,
    "mode" TEXT,
    "solution" TEXT,
    "cost" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "etaJson" JSONB,
    "preconditionsJson" JSONB,
    "voidableUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryWindow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "deliveryWindowOptionId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "availabilityType" TEXT,
    "availabilityExpiresAt" TIMESTAMP(3),
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT,
    "shippedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER,
    "discrepancyQty" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT,
    "shipmentRef" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "milestone" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelPrintJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "objectKey" TEXT,
    "pageType" TEXT,
    "errorMessage" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabelPrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "operationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "paramsJson" JSONB,
    "problemsJson" JSONB,
    "errorCode" TEXT,
    "syncJobId" TEXT,
    "writeRunId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "InboundOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundPlanItem_tenant_idx" ON "InboundPlanItem"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "InboundPlanItem_uq" ON "InboundPlanItem"("planId", "sku");

-- CreateIndex
CREATE INDEX "InboundEligibility_tenant_idx" ON "InboundEligibilityCheck"("tenantId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEligibility_uq" ON "InboundEligibilityCheck"("planId", "sku", "program", "checkedAt");

-- CreateIndex
CREATE INDEX "PackingOption_tenant_idx" ON "PackingOption"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PackingOption_uq" ON "PackingOption"("planId", "packingOptionId");

-- CreateIndex
CREATE INDEX "PackingGroup_tenant_idx" ON "PackingGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PackingGroup_uq" ON "PackingGroup"("planId", "packingOptionId", "packingGroupId");

-- CreateIndex
CREATE INDEX "InboundBox_tenant_idx" ON "InboundBox"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundBox_uq" ON "InboundBox"("planId", "boxId");

-- CreateIndex
CREATE INDEX "PlacementOption_tenant_idx" ON "PlacementOption"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementOption_uq" ON "PlacementOption"("planId", "placementOptionId");

-- CreateIndex
CREATE INDEX "TransportOption_tenant_idx" ON "TransportOption"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportOption_uq" ON "TransportOption"("planId", "shipmentId", "transportOptionId");

-- CreateIndex
CREATE INDEX "DeliveryWindow_tenant_idx" ON "DeliveryWindow"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryWindow_uq" ON "DeliveryWindow"("planId", "shipmentId", "windowStart");

-- CreateIndex
CREATE INDEX "ShipmentItem_tenant_idx" ON "ShipmentItem"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentItem_uq" ON "ShipmentItem"("planId", "shipmentId", "sku");

-- CreateIndex
CREATE INDEX "TrackingEvent_plan_idx" ON "TrackingEvent"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEvent_uq" ON "TrackingEvent"("tenantId", "trackingNumber", "milestone", "occurredAt");

-- CreateIndex
CREATE INDEX "LabelPrintJob_plan_idx" ON "LabelPrintJob"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "LabelPrintJob_tenant_idx" ON "LabelPrintJob"("tenantId");

-- CreateIndex
CREATE INDEX "InboundOperation_plan_idx" ON "InboundOperation"("planId", "startedAt");

-- CreateIndex
CREATE INDEX "InboundOperation_status_idx" ON "InboundOperation"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InboundOperation_uq" ON "InboundOperation"("sellerAccountId", "operationId");

-- CreateIndex
CREATE INDEX "FbaInboundPlan_stage_idx" ON "FbaInboundPlan"("tenantId", "stage", "updatedAt");

-- AddForeignKey
ALTER TABLE "InboundPlanItem" ADD CONSTRAINT "InboundPlanItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundPlanItem" ADD CONSTRAINT "InboundPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEligibilityCheck" ADD CONSTRAINT "InboundEligibilityCheck_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEligibilityCheck" ADD CONSTRAINT "InboundEligibilityCheck_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingOption" ADD CONSTRAINT "PackingOption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingOption" ADD CONSTRAINT "PackingOption_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingGroup" ADD CONSTRAINT "PackingGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingGroup" ADD CONSTRAINT "PackingGroup_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundBox" ADD CONSTRAINT "InboundBox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundBox" ADD CONSTRAINT "InboundBox_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementOption" ADD CONSTRAINT "PlacementOption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementOption" ADD CONSTRAINT "PlacementOption_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportOption" ADD CONSTRAINT "TransportOption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportOption" ADD CONSTRAINT "TransportOption_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryWindow" ADD CONSTRAINT "DeliveryWindow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryWindow" ADD CONSTRAINT "DeliveryWindow_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintJob" ADD CONSTRAINT "LabelPrintJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintJob" ADD CONSTRAINT "LabelPrintJob_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundOperation" ADD CONSTRAINT "InboundOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundOperation" ADD CONSTRAINT "InboundOperation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundOperation" ADD CONSTRAINT "InboundOperation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 既有数据：已在亚马逊创建的旧计划
UPDATE "FbaInboundPlan" SET "stage" = 'CREATED' WHERE "externalPlanId" IS NOT NULL;

-- 检查约束
ALTER TABLE "FbaInboundPlan" ADD CONSTRAINT "FbaInboundPlan_inbound_check" CHECK (
  "stage" IN ('DRAFT', 'ELIGIBILITY', 'CREATED', 'PACKING_CONFIRMED', 'PACKING_INFO_SUBMITTED', 'PLACEMENT_CONFIRMED', 'TRANSPORT_CONFIRMED', 'LABELS_PRINTED', 'SHIPPED', 'RECEIVING', 'DISCREPANCY', 'COMPLETED', 'CANCELLED')
  AND "sourceType" IN ('MANUAL', 'REPLENISHMENT', 'PURCHASE_ORDER')
  AND "prepOwner" = 'SELLER' AND "labelOwner" = 'SELLER'
  AND ("shippingMode" IS NULL OR "shippingMode" IN ('SPD', 'LTL', 'FTL'))
  AND ("prepCost" IS NULL OR "prepCost" >= 0) AND ("labelCost" IS NULL OR "labelCost" >= 0)
  AND "version" >= 1);
ALTER TABLE "FbaInboundShipment" ADD CONSTRAINT "FbaInboundShipment_inbound_check" CHECK ("boxCount" IS NULL OR "boxCount" >= 0);
ALTER TABLE "InboundPlanItem" ADD CONSTRAINT "InboundPlanItem_check" CHECK ("quantity" > 0);
ALTER TABLE "PackingOption" ADD CONSTRAINT "PackingOption_check" CHECK ("status" IN ('OFFERED', 'ACCEPTED', 'EXPIRED') AND ("fees" IS NULL OR "fees" >= 0) AND ("discounts" IS NULL OR "discounts" >= 0));
ALTER TABLE "InboundBox" ADD CONSTRAINT "InboundBox_check" CHECK ("quantity" > 0 AND "weightLb" > 0 AND "lengthIn" > 0 AND "widthIn" > 0 AND "heightIn" > 0 AND "labelStatus" IN ('NOT_PRINTED', 'READY'));
ALTER TABLE "PlacementOption" ADD CONSTRAINT "PlacementOption_check" CHECK ("status" IN ('OFFERED', 'ACCEPTED', 'EXPIRED') AND "shipmentCount" >= 0 AND "fees" >= 0 AND "discounts" >= 0);
ALTER TABLE "TransportOption" ADD CONSTRAINT "TransportOption_check" CHECK ("status" IN ('OFFERED', 'ACCEPTED', 'EXPIRED') AND ("cost" IS NULL OR "cost" >= 0));
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_check" CHECK ("shippedQty" >= 0 AND ("receivedQty" IS NULL OR "receivedQty" >= 0));
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_check" CHECK ("source" IN ('API', 'PUSH', 'FILE', 'MANUAL'));
ALTER TABLE "LabelPrintJob" ADD CONSTRAINT "LabelPrintJob_check" CHECK ("kind" IN ('BOX', 'ITEM') AND "status" IN ('QUEUED', 'GENERATING', 'READY', 'FAILED'));
ALTER TABLE "InboundOperation" ADD CONSTRAINT "InboundOperation_check" CHECK (
  "status" IN ('QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'TIMEOUT')
  AND "operation" IN ('ELIGIBILITY', 'CREATE_PLAN', 'GENERATE_PACKING', 'CONFIRM_PACKING', 'SUBMIT_PACKING_INFO', 'GENERATE_PLACEMENT', 'CONFIRM_PLACEMENT', 'GENERATE_TRANSPORT', 'CONFIRM_TRANSPORT', 'GENERATE_WINDOWS', 'CONFIRM_WINDOW', 'UPDATE_TRACKING', 'CANCEL_PLAN', 'LABELS'));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['InboundPlanItem', 'InboundEligibilityCheck', 'PackingOption', 'PackingGroup', 'InboundBox', 'PlacementOption', 'TransportOption', 'DeliveryWindow', 'ShipmentItem', 'TrackingEvent', 'LabelPrintJob', 'InboundOperation'] LOOP
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