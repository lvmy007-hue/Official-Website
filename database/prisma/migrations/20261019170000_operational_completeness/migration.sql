-- AlterTable
ALTER TABLE "ContactRequest" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "storeBand" TEXT,
ADD COLUMN     "topic" TEXT;

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amazonOrderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "asin" TEXT,
    "sellerSku" TEXT,
    "title" TEXT,
    "quantityOrdered" INTEGER NOT NULL DEFAULT 0,
    "quantityShipped" INTEGER NOT NULL DEFAULT 0,
    "itemPrice" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "fulfillmentNetwork" TEXT,
    "condition" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaSettlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "externalSettlementId" TEXT NOT NULL,
    "settlementStartDate" TIMESTAMP(3),
    "settlementEndDate" TIMESTAMP(3),
    "depositDate" TIMESTAMP(3),
    "totalAmount" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbaSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbaFinancialTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "settlementId" TEXT,
    "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
    "externalTransactionId" TEXT NOT NULL,
    "amazonOrderId" TEXT,
    "transactionType" TEXT,
    "transactionStatus" TEXT,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "postedAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "raw" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FbaFinancialTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsMetric" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "reportJobId" TEXT,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    "externalCampaignId" TEXT,
    "campaignName" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(20,6),
    "sales" DECIMAL(20,6),
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "raw" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalAmount" DECIMAL(20,6),
    "expectedDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "sellerSku" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(20,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'US',
    "kind" TEXT NOT NULL DEFAULT 'FBA',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "address" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT,
    "warehouseId" TEXT,
    "sellerSku" TEXT NOT NULL,
    "asin" TEXT,
    "movementType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderItem_tenantId_amazonOrderId_idx" ON "OrderItem"("tenantId", "amazonOrderId");

-- CreateIndex
CREATE INDEX "OrderItem_sellerAccountId_sellerSku_idx" ON "OrderItem"("sellerAccountId", "sellerSku");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_sellerAccountId_orderItemId_key" ON "OrderItem"("sellerAccountId", "orderItemId");

-- CreateIndex
CREATE INDEX "FbaSettlement_tenantId_depositDate_idx" ON "FbaSettlement"("tenantId", "depositDate");

-- CreateIndex
CREATE UNIQUE INDEX "FbaSettlement_sellerAccountId_externalSettlementId_key" ON "FbaSettlement"("sellerAccountId", "externalSettlementId");

-- CreateIndex
CREATE INDEX "FbaFinancialTransaction_tenantId_postedAt_transactionType_idx" ON "FbaFinancialTransaction"("tenantId", "postedAt", "transactionType");

-- CreateIndex
CREATE UNIQUE INDEX "FbaFinancialTransaction_sellerAccountId_externalTransaction_key" ON "FbaFinancialTransaction"("sellerAccountId", "externalTransactionId");

-- CreateIndex
CREATE INDEX "AdsMetric_tenantId_reportDate_idx" ON "AdsMetric"("tenantId", "reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "AdsMetric_adsProfileId_reportDate_adProduct_externalCampaig_key" ON "AdsMetric"("adsProfileId", "reportDate", "adProduct", "externalCampaignId");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_status_idx" ON "Supplier"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_code_key" ON "Supplier"("tenantId", "code");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_status_createdAt_idx" ON "PurchaseOrder"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_number_key" ON "PurchaseOrder"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_sellerSku_idx" ON "PurchaseOrderLine"("purchaseOrderId", "sellerSku");

-- CreateIndex
CREATE INDEX "Warehouse_tenantId_kind_status_idx" ON "Warehouse"("tenantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_tenantId_code_key" ON "Warehouse"("tenantId", "code");

-- CreateIndex
CREATE INDEX "InventoryMovement_tenantId_sellerSku_occurredAt_idx" ON "InventoryMovement"("tenantId", "sellerSku", "occurredAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_tenantId_movementType_occurredAt_idx" ON "InventoryMovement"("tenantId", "movementType", "occurredAt");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaSettlement" ADD CONSTRAINT "FbaSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaSettlement" ADD CONSTRAINT "FbaSettlement_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FbaSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_reportJobId_fkey" FOREIGN KEY ("reportJobId") REFERENCES "AdsReportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

