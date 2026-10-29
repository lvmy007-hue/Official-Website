-- M-P1-28 回滚：移除平台能力新增的表、触发器与函数。
-- 警告：会丢失写入开关与变更记录、汇率历史与手工覆盖、待办与指派、预警规则与实例、站内通知、导出任务记录、保存视图、对象事件与运营日志、评论与关注、
-- 通知订阅与收到的通知记录、数据新鲜度、企业设置项。已生成的导出文件不会随之删除（对象存储中的文件按各自过期时间清理）。
-- 本迁移补建的 AmazonNotificationEvent 分区随表一并删除。
DROP TABLE IF EXISTS "TenantSetting";
DROP TABLE IF EXISTS "DataFreshness";
DROP TABLE IF EXISTS "AmazonNotificationEvent";
DROP TABLE IF EXISTS "NotificationSubscription";
DROP TABLE IF EXISTS "Watch";
DROP TABLE IF EXISTS "Comment";
DROP TABLE IF EXISTS "OperationLog";
DROP TABLE IF EXISTS "EntityEvent";
DROP TABLE IF EXISTS "SavedView";
DROP TABLE IF EXISTS "ExportJob";
DROP TABLE IF EXISTS "Notification";
DROP TABLE IF EXISTS "AlertInstance";
DROP TABLE IF EXISTS "AlertRuleVersion";
DROP TABLE IF EXISTS "AlertRule";
DROP TABLE IF EXISTS "Assignment";
DROP TABLE IF EXISTS "WorkItem";
DROP TABLE IF EXISTS "FxSourceConfig";
DROP TRIGGER IF EXISTS "FxRate_locked" ON "FxRate";
DROP TABLE IF EXISTS "FxRate";
DROP FUNCTION IF EXISTS nova_fx_rate_locked();
DROP TABLE IF EXISTS "IntegrationSwitchLog";
DROP TABLE IF EXISTS "IntegrationSwitch";
