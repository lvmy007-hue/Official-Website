-- M-P1-27（续）外键列索引
-- 依据：freeze/models.md 0.2 索引规范第 3 条“外键列单独建索引”。
-- 内容：为阶段 0 之前就存在、尚无索引支撑的 21 处外键补建索引（含分区表 AdsMetric、AdsTermMetric、AuditEvent、OrderItem，
--       分区表上建的索引会自动覆盖所有分区）。
-- 运行要求：本迁移在事务内建索引，会短暂阻塞写入；当前数据量小可接受。若在数据量大的生产库上执行，
--           应先在业务低峰期对大表手工 CREATE INDEX CONCURRENTLY，再执行本迁移（IF NOT EXISTS 会跳过已建好的）。
-- 回滚方法：见同目录 rollback.sql（逐个删除本迁移创建的索引）。

CREATE INDEX IF NOT EXISTS "AdsMetric_reportJobId_idx" ON "AdsMetric"("reportJobId");
CREATE INDEX IF NOT EXISTS "AdsTermMetric_reportJobId_idx" ON "AdsTermMetric"("reportJobId");
CREATE INDEX IF NOT EXISTS "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");
CREATE INDEX IF NOT EXISTS "CommerceOrder_planId_idx" ON "CommerceOrder"("planId");
CREATE INDEX IF NOT EXISTS "FbaFinancialTransaction_settlementId_idx" ON "FbaFinancialTransaction"("settlementId");
CREATE INDEX IF NOT EXISTS "FbaInboundPlan_sellerAccountId_idx" ON "FbaInboundPlan"("sellerAccountId");
CREATE INDEX IF NOT EXISTS "FbaReportJob_createdById_idx" ON "FbaReportJob"("createdById");
CREATE INDEX IF NOT EXISTS "InventoryMovement_warehouseId_idx" ON "InventoryMovement"("warehouseId");
CREATE INDEX IF NOT EXISTS "Membership_roleId_idx" ON "Membership"("roleId");
CREATE INDEX IF NOT EXISTS "OAuthState_connectionId_idx" ON "OAuthState"("connectionId");
CREATE INDEX IF NOT EXISTS "OAuthState_initiatedById_idx" ON "OAuthState"("initiatedById");
CREATE INDEX IF NOT EXISTS "OrderItem_orderId_orderPurchaseDate_idx" ON "OrderItem"("orderId", "orderPurchaseDate");
CREATE INDEX IF NOT EXISTS "PaymentEvent_paymentId_idx" ON "PaymentEvent"("paymentId");
CREATE INDEX IF NOT EXISTS "PlatformConnection_adsProfileId_idx" ON "PlatformConnection"("adsProfileId");
CREATE INDEX IF NOT EXISTS "PlatformConnection_sellerAccountId_idx" ON "PlatformConnection"("sellerAccountId");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");
CREATE INDEX IF NOT EXISTS "RefundRequest_paymentId_idx" ON "RefundRequest"("paymentId");
CREATE INDEX IF NOT EXISTS "SellerAccount_legalEntityId_idx" ON "SellerAccount"("legalEntityId");
CREATE INDEX IF NOT EXISTS "Subscription_orderId_idx" ON "Subscription"("orderId");
CREATE INDEX IF NOT EXISTS "Subscription_planId_idx" ON "Subscription"("planId");
CREATE INDEX IF NOT EXISTS "SyncJob_connectionId_idx" ON "SyncJob"("connectionId");
