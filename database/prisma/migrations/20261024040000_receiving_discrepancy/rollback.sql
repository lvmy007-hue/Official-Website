-- M-P2a-13 回滚：删除货件接收与差异新增的表。
-- 说明：接收差异与不合规问题是同步器按接收数量和报告算出来的，回滚后下一次同步会重新生成；
-- 赔付机会上的人工处理状态（已忽略、已生成案件）不可恢复，回滚前请先导出。
-- 货件证据附件（Attachment.entityType = INBOUND_SHIPMENT）保留在原表，文件本身留在对象存储里。
DROP TABLE IF EXISTS "ReimbursementOpportunity";
DROP TABLE IF EXISTS "ReceivingDiscrepancy";
