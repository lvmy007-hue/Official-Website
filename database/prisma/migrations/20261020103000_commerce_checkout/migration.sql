CREATE TABLE "CommercialPlan" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tagline" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "basePrice" DECIMAL(20,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "billingPeriodMonths" INTEGER NOT NULL DEFAULT 12,
  "taxIncluded" BOOLEAN NOT NULL DEFAULT false,
  "taxRate" DECIMAL(8,6),
  "legalEntityLimit" INTEGER,
  "storeLimit" INTEGER,
  "memberLimit" INTEGER,
  "onlinePurchase" BOOLEAN NOT NULL DEFAULT false,
  "featured" BOOLEAN NOT NULL DEFAULT false,
  "features" JSONB NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceOrder" (
  "id" TEXT NOT NULL,
  "orderNo" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "tenantId" TEXT,
  "companyName" TEXT NOT NULL,
  "creditCode" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "invoiceTitle" TEXT NOT NULL,
  "taxpayerId" TEXT NOT NULL,
  "invoiceEmail" TEXT NOT NULL,
  "subtotal" DECIMAL(20,2) NOT NULL,
  "taxRate" DECIMAL(8,6),
  "taxAmount" DECIMAL(20,2) NOT NULL DEFAULT 0,
  "totalAmount" DECIMAL(20,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "priceSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  "accessTokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "activatedAt" TIMESTAMP(3),
  "serviceStartAt" TIMESTAMP(3),
  "serviceEndAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentRecord" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'ALIPAY',
  "providerTradeNo" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "amount" DECIMAL(20,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "checkoutPayload" JSONB,
  "paidAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "notifyVerifiedAt" TIMESTAMP(3),
  "refundedAmount" DECIMAL(20,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "paymentId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'ALIPAY',
  "eventType" TEXT NOT NULL,
  "providerEventId" TEXT,
  "signatureValid" BOOLEAN NOT NULL DEFAULT false,
  "payloadHash" TEXT NOT NULL,
  "payload" JSONB,
  "processedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefundRequest" (
  "id" TEXT NOT NULL,
  "refundNo" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "paymentId" TEXT,
  "requestedAmount" DECIMAL(20,2) NOT NULL,
  "approvedAmount" DECIMAL(20,2),
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "providerRefundNo" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceRequest" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "invoiceType" TEXT NOT NULL DEFAULT 'VAT_NORMAL',
  "title" TEXT NOT NULL,
  "taxpayerId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "amount" DECIMAL(20,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "invoiceNo" TEXT,
  "invoiceUrl" TEXT,
  "issuedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "autoRenew" BOOLEAN NOT NULL DEFAULT false,
  "entitlementSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceAuditLog" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "detail" JSONB,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommerceAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommercialPlan_code_key" ON "CommercialPlan"("code");
CREATE INDEX "CommercialPlan_status_sortOrder_idx" ON "CommercialPlan"("status", "sortOrder");
CREATE UNIQUE INDEX "CommerceOrder_orderNo_key" ON "CommerceOrder"("orderNo");
CREATE INDEX "CommerceOrder_status_createdAt_idx" ON "CommerceOrder"("status", "createdAt");
CREATE INDEX "CommerceOrder_email_createdAt_idx" ON "CommerceOrder"("email", "createdAt");
CREATE INDEX "CommerceOrder_companyName_createdAt_idx" ON "CommerceOrder"("companyName", "createdAt");
CREATE INDEX "CommerceOrder_tenantId_createdAt_idx" ON "CommerceOrder"("tenantId", "createdAt");
CREATE UNIQUE INDEX "PaymentRecord_providerTradeNo_key" ON "PaymentRecord"("providerTradeNo");
CREATE UNIQUE INDEX "PaymentRecord_idempotencyKey_key" ON "PaymentRecord"("idempotencyKey");
CREATE INDEX "PaymentRecord_orderId_status_idx" ON "PaymentRecord"("orderId", "status");
CREATE INDEX "PaymentRecord_provider_createdAt_idx" ON "PaymentRecord"("provider", "createdAt");
CREATE UNIQUE INDEX "PaymentEvent_provider_payloadHash_key" ON "PaymentEvent"("provider", "payloadHash");
CREATE INDEX "PaymentEvent_orderId_createdAt_idx" ON "PaymentEvent"("orderId", "createdAt");
CREATE INDEX "PaymentEvent_providerEventId_idx" ON "PaymentEvent"("providerEventId");
CREATE UNIQUE INDEX "RefundRequest_refundNo_key" ON "RefundRequest"("refundNo");
CREATE UNIQUE INDEX "RefundRequest_providerRefundNo_key" ON "RefundRequest"("providerRefundNo");
CREATE INDEX "RefundRequest_status_createdAt_idx" ON "RefundRequest"("status", "createdAt");
CREATE INDEX "RefundRequest_orderId_createdAt_idx" ON "RefundRequest"("orderId", "createdAt");
CREATE UNIQUE INDEX "InvoiceRequest_orderId_key" ON "InvoiceRequest"("orderId");
CREATE INDEX "InvoiceRequest_status_createdAt_idx" ON "InvoiceRequest"("status", "createdAt");
CREATE UNIQUE INDEX "Subscription_tenantId_orderId_key" ON "Subscription"("tenantId", "orderId");
CREATE INDEX "Subscription_tenantId_status_endsAt_idx" ON "Subscription"("tenantId", "status", "endsAt");
CREATE INDEX "CommerceAuditLog_orderId_createdAt_idx" ON "CommerceAuditLog"("orderId", "createdAt");

ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommercialPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommercialPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceAuditLog" ADD CONSTRAINT "CommerceAuditLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CommercialPlan" ("id", "code", "name", "tagline", "description", "basePrice", "currency", "billingPeriodMonths", "taxIncluded", "taxRate", "legalEntityLimit", "storeLimit", "memberLimit", "onlinePurchase", "featured", "features", "sortOrder", "status") VALUES
('plan-single-company', 'SINGLE_COMPANY', '单公司起步版', '适合一个经营主体的标准化起步方案', '覆盖订单、退货、商品、库存、FBA入仓、财务和成员权限。', 12800.00, 'CNY', 12, false, NULL, 1, 5, 5, true, false, '["订单与退货","FBA库存与入仓","商品刊登","财务月结","5个成员席位"]'::jsonb, 10, 'ACTIVE'),
('plan-multi-company', 'MULTI_COMPANY', '多公司专业版', '面向多主体、多店铺协同经营团队', '包含单公司起步版全部能力，并增加多主体隔离、20个成员席位和广告只读报表。', 36800.00, 'CNY', 12, false, NULL, 3, 20, 20, true, true, '["单公司起步版全部模块","3个法律主体","20个店铺","20个成员席位","Amazon Ads只读报表"]'::jsonb, 20, 'ACTIVE'),
('plan-enterprise-custom', 'ENTERPRISE_CUSTOM', '企业定制版', '按组织、模块与实施范围形成专属方案', '适用于超过标准范围或需要定制实施的企业，确认方案后由后台生成专属订单。', 68000.00, 'CNY', 12, false, NULL, NULL, NULL, NULL, false, false, '["按方案配置主体与店铺","专属实施范围","可选定制开发","专属订单与合同"]'::jsonb, 30, 'ACTIVE');
