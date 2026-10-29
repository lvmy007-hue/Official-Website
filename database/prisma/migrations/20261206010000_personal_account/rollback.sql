-- 回滚 M-P5-11：删除 UserPreference 与 Notification 的三个新列（含索引与约束）。
-- 个人的通知偏好与免打扰设置会丢失（回到“全部接收、免打扰关闭”）；已写入的通知本身不受影响，
-- 但免打扰期间收到的通知会失去“免打扰”标记（回滚后会像普通通知一样计入未读数）。
DROP INDEX IF EXISTS "Notification_tenantId_userId_silencedAt_summarizedAt_idx";
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_domain_check";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "summarizedAt";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "silencedAt";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "domain";
DROP TABLE IF EXISTS "UserPreference";
