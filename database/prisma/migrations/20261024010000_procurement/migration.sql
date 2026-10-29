-- M-P2a-10 采购、供应商、国内仓。
-- 依据：freeze/models.md M-P2a-10；06 章 6.7、6.8、6.9；14 章 P2a-10。
--
-- 内容：
--   一、供应商：版本号（乐观锁）与表现指标（准时交付率、质检合格率、平均交期、评级，由系统重算；空值表示样本不足，不是 0）。
--   二、采购单：审批状态、付款状态、已收数量合计、提交时间、下单时间、完成时间；状态取值检查。
--   三、仓库：库存计价方法；库存流水：原因码、占用数量、入库成本、操作人。
--   四、新表：PurchaseReceipt、QualityInspection、PurchasePayment、PurchaseApproval、Attachment、StockCount、CostVersion。
--   五、检查约束、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（删除新表与新增的列；收货、质检、付款、审批、盘点都是人工录入的业务记录，回滚前请先导出）。
-- 本迁移不修改、不删除任何既有数据；既有采购单的新列取默认值（审批 NONE、付款 UNPAID、已收 0）。

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "onTimeRate" DECIMAL(7,4),
ADD COLUMN "qualityPassRate" DECIMAL(7,4),
ADD COLUMN "avgLeadDays" INTEGER,
ADD COLUMN "rating" TEXT,
ADD COLUMN "metricsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
ADD COLUMN "receivedQtyTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "submittedAt" TIMESTAMP(3),
ADD COLUMN "orderedAt" TIMESTAMP(3),
ADD COLUMN "completedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN "costMethod" TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE';

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN "reasonCode" TEXT,
ADD COLUMN "lockedForShipment" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "unitCost" DECIMAL(20,6),
ADD COLUMN "currency" TEXT,
ADD COLUMN "createdBy" TEXT;

-- CreateTable
CREATE TABLE "PurchaseReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "receiptNo" TEXT NOT NULL,
    "receivedAt" DATE NOT NULL,
    "linesJson" JSONB NOT NULL,
    "totalQty" INTEGER NOT NULL,
    "note" TEXT,
    "receivedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityInspection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "receiptId" TEXT,
    "result" TEXT NOT NULL,
    "lotQty" INTEGER NOT NULL,
    "sampleQty" INTEGER NOT NULL,
    "defectQty" INTEGER NOT NULL,
    "handling" TEXT,
    "note" TEXT,
    "inspectorId" TEXT NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "plannedAt" DATE,
    "paidAt" DATE,
    "voucherAttachmentId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "approverId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COUNTING',
    "countedAt" DATE NOT NULL,
    "linesJson" JSONB NOT NULL,
    "note" TEXT,
    "reviewNote" TEXT,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "unitProductCost" DECIMAL(20,6),
    "unitFirstMileCost" DECIMAL(20,6),
    "unitOtherCost" DECIMAL(20,6),
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceDocId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceipt_uq" ON "PurchaseReceipt"("tenantId", "receiptNo");

-- CreateIndex
CREATE INDEX "PurchaseReceipt_po_idx" ON "PurchaseReceipt"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseReceipt_wh_idx" ON "PurchaseReceipt"("warehouseId");

-- CreateIndex
CREATE INDEX "QualityInspection_po_idx" ON "QualityInspection"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "QualityInspection_tenant_idx" ON "QualityInspection"("tenantId", "inspectedAt");

-- CreateIndex
CREATE INDEX "PurchasePayment_po_idx" ON "PurchasePayment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchasePayment_tenant_idx" ON "PurchasePayment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PurchaseApproval_tenant_idx" ON "PurchaseApproval"("tenantId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseApproval_uq" ON "PurchaseApproval"("purchaseOrderId", "step");

-- CreateIndex
CREATE INDEX "Attachment_entity_idx" ON "Attachment"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_uq" ON "Attachment"("tenantId", "entityType", "entityId", "sha256");

-- CreateIndex
CREATE INDEX "StockCount_wh_idx" ON "StockCount"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_uq" ON "StockCount"("tenantId", "warehouseId", "countedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CostVersion_uq" ON "CostVersion"("tenantId", "sku", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "CostVersion_source_uq" ON "CostVersion"("tenantId", "source", "sourceDocId", "sku");

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseApproval" ADD CONSTRAINT "PurchaseApproval_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseApproval" ADD CONSTRAINT "PurchaseApproval_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostVersion" ADD CONSTRAINT "CostVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束：状态取值、数量非负、抽检与不良的大小关系
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'RETURNED_TO_SUPPLIER'));
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approval_check" CHECK ("approvalStatus" IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_payment_check" CHECK ("paymentStatus" IN ('UNPAID', 'PARTIAL', 'PAID'));
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_received_check" CHECK ("receivedQtyTotal" >= 0);
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_costMethod_check" CHECK ("costMethod" IN ('WEIGHTED_AVERAGE', 'FIFO'));
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_metrics_check" CHECK (("onTimeRate" IS NULL OR ("onTimeRate" >= 0 AND "onTimeRate" <= 1)) AND ("qualityPassRate" IS NULL OR ("qualityPassRate" >= 0 AND "qualityPassRate" <= 1)) AND ("avgLeadDays" IS NULL OR "avgLeadDays" >= 0));
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_result_check" CHECK ("result" IN ('PASS', 'CONCESSION', 'FAIL'));
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_qty_check" CHECK ("defectQty" >= 0 AND "defectQty" <= "sampleQty" AND "sampleQty" <= "lotQty");
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_kind_check" CHECK ("kind" IN ('DEPOSIT', 'BALANCE', 'OTHER'));
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_status_check" CHECK ("status" IN ('PLANNED', 'PAID') AND "amount" > 0 AND ("status" <> 'PAID' OR "paidAt" IS NOT NULL));
ALTER TABLE "PurchaseApproval" ADD CONSTRAINT "PurchaseApproval_decision_check" CHECK ("decision" IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_qty_check" CHECK ("totalQty" > 0);
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_size_check" CHECK ("sizeBytes" >= 0);
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_status_check" CHECK ("status" IN ('COUNTING', 'PENDING_APPROVAL', 'POSTED'));
ALTER TABLE "CostVersion" ADD CONSTRAINT "CostVersion_source_check" CHECK ("source" IN ('PURCHASE_RECEIPT', 'FIRST_MILE_ALLOCATION', 'MANUAL', 'FILE_IMPORT') AND "status" IN ('DRAFT', 'ACTIVE', 'REPLACED') AND "versionNo" >= 1);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['PurchaseReceipt', 'QualityInspection', 'PurchasePayment', 'PurchaseApproval', 'Attachment', 'StockCount', 'CostVersion'] LOOP
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
