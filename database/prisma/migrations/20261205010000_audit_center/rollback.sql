-- M-P5-09 回滚：删除审计事件的来源、所属页面两列与相关约束、索引。
-- 说明：审计内容本身（动作、资源、结果、修改前后、请求编号等）全部保留；只丢失来源与所属页面这两项标注。

DROP INDEX IF EXISTS "AuditEvent_tenantId_action_occurredAt_idx";
ALTER TABLE "AuditEvent" DROP CONSTRAINT IF EXISTS "AuditEvent_source_check";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "page";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "source";
