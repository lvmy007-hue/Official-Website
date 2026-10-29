-- M-P1-26 回滚：移除订单与财务升级新增的表、字段、触发器。
-- 警告：会丢失订单收入费用明细、状态历史、包裹、取消、账户余额快照、新旧通道核对记录，以及各同步表的“同步时间、来源报告任务、来源标识”。
-- 财务交易的交易状态在迁移时已被清空（旧接口没有状态），回滚不会还原旧占位值。
-- 本迁移补建的历史月份分区不删除（分区本身无害，且其中可能已有数据）。
DROP TABLE IF EXISTS "ConnectorParityDiff";
DROP TABLE IF EXISTS "ConnectorParityRun";
DROP TABLE IF EXISTS "ConnectorChannelState";
DROP TABLE IF EXISTS "AccountBalanceSnapshot";
DROP TABLE IF EXISTS "OrderCancellation";
DROP TABLE IF EXISTS "OrderPackage";
DROP TABLE IF EXISTS "OrderStatusHistory";
DROP TABLE IF EXISTS "OrderCharge";

ALTER TABLE "FbaFinancialTransaction" DROP CONSTRAINT IF EXISTS "FbaFinancialTransaction_reconciliationStatus_check";
ALTER TABLE "FbaFinancialTransaction" DROP CONSTRAINT IF EXISTS "FbaFinancialTransaction_transactionStatus_check";
ALTER TABLE "FbaFinancialTransaction" DROP COLUMN IF EXISTS "reconciliationStatus";
ALTER TABLE "FbaFinancialTransaction" DROP COLUMN IF EXISTS "relatedIdentifiers";

ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "itemStatus";
ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "taxAmount";
ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "promotionDiscount";
ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "marketplaceId";

ALTER TABLE "Order" DROP COLUMN IF EXISTS "refundStatus";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "replacementReason";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "replacedOrderId";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "isReplacement";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "cancelledBy";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "latestDelivery";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "earliestDelivery";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "latestShipDate";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "fulfillmentStatus";

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'Order', 'InventorySnapshot', 'FbaProduct', 'FbaInventoryRecord', 'FbaInboundPlan', 'FbaInboundShipment', 'FbaFeeEvent', 'FbaReturnCase',
    'AdsProfile', 'AdsCampaign', 'OrderItem', 'FbaSettlement', 'FbaFinancialTransaction', 'AdsMetric', 'AdsTermMetric'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', tbl || '_touch_synced_at', tbl);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS "syncedAt"', tbl);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS "sourceReportJobId"', tbl);
    IF tbl <> 'Order' THEN
      EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS "sourceRecordId"', tbl);
    END IF;
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS nova_touch_synced_at();
