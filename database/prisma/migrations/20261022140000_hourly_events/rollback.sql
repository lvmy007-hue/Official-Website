-- M-P2a-03 回滚：移除三张小时事件表。
-- 说明：小时事件可由推送样例 / 重放重建；原始通知仍在 AmazonNotificationEvent。
DROP TABLE IF EXISTS "HourlyInventoryEvent";
DROP TABLE IF EXISTS "HourlyTrafficEvent";
DROP TABLE IF EXISTS "HourlySalesEvent";
