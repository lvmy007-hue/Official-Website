CREATE TABLE "FbaProduct" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "asin" TEXT NOT NULL,
  "sellerSku" TEXT NOT NULL,
  "fnsku" TEXT,
  "title" TEXT NOT NULL,
  "brand" TEXT,
  "productType" TEXT,
  "listingStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  "fulfillmentChannel" TEXT NOT NULL DEFAULT 'AFN',
  "sizeTier" TEXT,
  "packageLengthCm" DECIMAL(12,4),
  "packageWidthCm" DECIMAL(12,4),
  "packageHeightCm" DECIMAL(12,4),
  "packageWeightKg" DECIMAL(12,4),
  "price" DECIMAL(20,6),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FbaInventoryRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "asin" TEXT NOT NULL,
  "sellerSku" TEXT NOT NULL,
  "fnsku" TEXT,
  "fulfillableQuantity" INTEGER NOT NULL DEFAULT 0,
  "inboundWorkingQuantity" INTEGER NOT NULL DEFAULT 0,
  "inboundShippedQuantity" INTEGER NOT NULL DEFAULT 0,
  "inboundReceivingQuantity" INTEGER NOT NULL DEFAULT 0,
  "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
  "unfulfillableQuantity" INTEGER NOT NULL DEFAULT 0,
  "researchQuantity" INTEGER NOT NULL DEFAULT 0,
  "daysOfSupply" DECIMAL(12,2),
  "inventoryAgeDays" INTEGER,
  "strandedReason" TEXT,
  "healthStatus" TEXT NOT NULL DEFAULT 'HEALTHY',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaInventoryRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FbaInboundPlan" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "externalPlanId" TEXT,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "sourceAddress" TEXT NOT NULL,
  "placementOption" TEXT,
  "totalUnits" INTEGER NOT NULL DEFAULT 0,
  "shipmentCount" INTEGER NOT NULL DEFAULT 0,
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaInboundPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FbaInboundShipment" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WORKING',
  "destinationFc" TEXT,
  "placementOption" TEXT,
  "transportStatus" TEXT,
  "trackingNumber" TEXT,
  "unitsExpected" INTEGER NOT NULL DEFAULT 0,
  "unitsReceived" INTEGER NOT NULL DEFAULT 0,
  "discrepancyQuantity" INTEGER NOT NULL DEFAULT 0,
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaInboundShipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FbaFeeEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "settlementId" TEXT,
  "amazonOrderId" TEXT,
  "asin" TEXT,
  "sellerSku" TEXT,
  "eventType" TEXT NOT NULL,
  "amount" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "postedAt" TIMESTAMP(3) NOT NULL,
  "description" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FbaFeeEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FbaReturnCase" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  "amazonOrderId" TEXT NOT NULL,
  "returnId" TEXT,
  "asin" TEXT NOT NULL,
  "sellerSku" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "disposition" TEXT,
  "reason" TEXT,
  "refundAmount" DECIMAL(20,6),
  "reimbursementStatus" TEXT NOT NULL DEFAULT 'NOT_REVIEWED',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "returnDate" TIMESTAMP(3) NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FbaReturnCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FbaProduct_sellerAccountId_marketplaceId_sellerSku_key" ON "FbaProduct"("sellerAccountId", "marketplaceId", "sellerSku");
CREATE INDEX "FbaProduct_tenantId_marketplaceId_asin_idx" ON "FbaProduct"("tenantId", "marketplaceId", "asin");
CREATE UNIQUE INDEX "FbaInventoryRecord_sellerAccountId_marketplaceId_sellerSku_key" ON "FbaInventoryRecord"("sellerAccountId", "marketplaceId", "sellerSku");
CREATE INDEX "FbaInventoryRecord_tenantId_healthStatus_daysOfSupply_idx" ON "FbaInventoryRecord"("tenantId", "healthStatus", "daysOfSupply");
CREATE INDEX "FbaInboundPlan_tenantId_status_createdAt_idx" ON "FbaInboundPlan"("tenantId", "status", "createdAt");
CREATE UNIQUE INDEX "FbaInboundShipment_planId_shipmentId_key" ON "FbaInboundShipment"("planId", "shipmentId");
CREATE INDEX "FbaInboundShipment_status_destinationFc_idx" ON "FbaInboundShipment"("status", "destinationFc");
CREATE INDEX "FbaFeeEvent_tenantId_postedAt_eventType_idx" ON "FbaFeeEvent"("tenantId", "postedAt", "eventType");
CREATE INDEX "FbaFeeEvent_sellerAccountId_settlementId_idx" ON "FbaFeeEvent"("sellerAccountId", "settlementId");
CREATE UNIQUE INDEX "FbaReturnCase_sellerAccountId_amazonOrderId_asin_returnDate_key" ON "FbaReturnCase"("sellerAccountId", "amazonOrderId", "asin", "returnDate");
CREATE INDEX "FbaReturnCase_tenantId_status_returnDate_idx" ON "FbaReturnCase"("tenantId", "status", "returnDate");

ALTER TABLE "FbaProduct" ADD CONSTRAINT "FbaProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaProduct" ADD CONSTRAINT "FbaProduct_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaInventoryRecord" ADD CONSTRAINT "FbaInventoryRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaInventoryRecord" ADD CONSTRAINT "FbaInventoryRecord_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaInboundPlan" ADD CONSTRAINT "FbaInboundPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaInboundPlan" ADD CONSTRAINT "FbaInboundPlan_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaInboundShipment" ADD CONSTRAINT "FbaInboundShipment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaFeeEvent" ADD CONSTRAINT "FbaFeeEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaReturnCase" ADD CONSTRAINT "FbaReturnCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbaReturnCase" ADD CONSTRAINT "FbaReturnCase_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
