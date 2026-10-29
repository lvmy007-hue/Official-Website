-- M-P5-08 成员与角色：字段权限增加“仅负责人可见”一档，角色增加说明，成员记录停用信息并约束状态取值。
-- 依据：09 章 9.10（含 CR-096 补充），14 章 P5-08，freeze/api.md /members*、/roles*。
--
-- 内容：
--   一、FieldPermission 新增 ownerOnly（默认假）：allowed 为真且 ownerOnly 为真表示“仅负责人可见”，只有商品负责人能看到该商品的成本或利润。
--   二、Role 新增 description（可空）：自定义角色的用途说明。
--   三、Membership 新增 disabledAt、disabledReason、disabledBy（可空）：停用成员时记录时间、原因与操作人；
--      状态只允许 ACTIVE、DISABLED。此前只有默认值没有约束；认证只认 ACTIVE，所以不认识的取值本来就不能登录，这里按“已停用”归一（宁可拒绝）。
-- 与冻结的出入：冻结的 models.md 没有列这些列；没有新增表，行级安全与授权沿用现有表，不需要改 regrant.sql。
-- 预设角色的保护触发器只拦 UPDATE 与 DELETE，加列不触发它。
--
-- 回滚方法：见同目录 rollback.sql（删除约束与新增列；“仅负责人可见”的字段权限回滚后按“可见”处理，回滚前先决定是否改成“不可见”）。

ALTER TABLE "FieldPermission" ADD COLUMN "ownerOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Role" ADD COLUMN "description" TEXT;

UPDATE "Membership" SET "status" = 'DISABLED' WHERE "status" NOT IN ('ACTIVE', 'DISABLED');

ALTER TABLE "Membership" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Membership" ADD COLUMN "disabledReason" TEXT;
ALTER TABLE "Membership" ADD COLUMN "disabledBy" TEXT;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED'));
