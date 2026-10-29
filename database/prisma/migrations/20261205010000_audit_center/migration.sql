-- M-P5-09 审计中心：审计事件记录来源与所属页面，并为“个人信息明文查看”视图补一条按动作取数的索引。
-- 依据：09 章 9.11（含 CR-096 补充：按所属页面与来源筛选、系统任务记为“系统”、明文查看专门视图），14 章 P5-09，freeze/api.md /audit*。
--
-- 内容：
--   一、AuditEvent 新增 source（PAGE 页面操作、API 接口调用、SYSTEM 系统任务）与 page（前端页面路径模板），均可空：
--      旧记录不回填（审计日志对应用角色只允许 SELECT 与 INSERT，历史记录不改写）；读取时没有来源且没有操作人的按“系统任务”处理，其余显示“未记录”。
--   二、source 的取值约束（空值允许）。
--   三、索引 (tenantId, action, occurredAt)：个人信息明文查看视图与大量查看预警按动作取数。
-- 分区表：AuditEvent 按 occurredAt 分区，在父表上加列、加约束、建索引会自动应用到全部分区（含之后新建的分区）。
-- 与冻结的出入：冻结的 models.md 没有列这些列；没有新表，行级安全与授权沿用现有表，不需要改 regrant.sql。
--
-- 回滚方法：见同目录 rollback.sql（删除索引、约束与两列；来源与所属页面信息随之丢失，其余审计内容不受影响）。

ALTER TABLE "AuditEvent" ADD COLUMN "source" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "page" TEXT;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_source_check" CHECK ("source" IS NULL OR "source" IN ('PAGE', 'API', 'SYSTEM'));

CREATE INDEX "AuditEvent_tenantId_action_occurredAt_idx" ON "AuditEvent"("tenantId", "action", "occurredAt");
