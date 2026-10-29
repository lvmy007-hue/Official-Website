-- M-P2b-01 订单页：订单详情补充字段与订单关联查询的索引。
-- 依据：07 章 7.1 订单详情身份区“销售渠道、订单项目标记”；importers.md I-01（订单接口新版响应的 programs、salesChannel.channelName）；
--       订单列表与详情按订单号取财务交易、费用明细、替换订单（12 章 12.2 要求查询有索引支撑）。
--
-- 内容：
--   一、Order 增加 2 列：programs（订单项目标记）、salesChannel（销售渠道名称）。Order 是按月分区表，在分区父表上加列会自动覆盖全部分区。
--       既有订单这两列为空（programs 为空数组，salesChannel 为空），下次订单同步（15 分钟补偿或历史回补）会补上；不会编造值。
--   二、3 个索引（都建在分区父表上，自动覆盖全部分区）：
--       FbaFinancialTransaction(tenantId, amazonOrderId)、FbaFeeEvent(tenantId, amazonOrderId)：按订单号取财务交易与费用明细；
--       Order(tenantId, replacedOrderId)：由原订单反查替换订单。
-- 回滚方法：见同目录 rollback.sql。本迁移不修改、不删除任何既有数据。

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "programs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "salesChannel" TEXT;

-- CreateIndex
CREATE INDEX "FbaFinancialTransaction_tenantId_amazonOrderId_idx" ON "FbaFinancialTransaction"("tenantId", "amazonOrderId");

-- CreateIndex
CREATE INDEX "FbaFeeEvent_tenantId_amazonOrderId_idx" ON "FbaFeeEvent"("tenantId", "amazonOrderId");

-- CreateIndex
CREATE INDEX "Order_tenantId_replacedOrderId_idx" ON "Order"("tenantId", "replacedOrderId");
