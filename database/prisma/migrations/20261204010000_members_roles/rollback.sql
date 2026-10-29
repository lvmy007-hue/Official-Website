-- M-P5-08 回滚：删除成员状态约束与本包新增的列。
-- 说明：成员行与角色行保留；已停用成员的状态仍是 DISABLED（认证只认 ACTIVE，回滚后他们仍不能登录）；
-- “仅负责人可见”的字段权限回滚前先收成“不可见”（宁可少给，不能因为列没了变成“可见”）；
-- 停用时间、原因、操作人与角色说明丢失（停用记录仍在审计里）。

UPDATE "FieldPermission" SET "allowed" = false WHERE "ownerOnly";
ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_status_check";
ALTER TABLE "Membership" DROP COLUMN IF EXISTS "disabledBy";
ALTER TABLE "Membership" DROP COLUMN IF EXISTS "disabledReason";
ALTER TABLE "Membership" DROP COLUMN IF EXISTS "disabledAt";
ALTER TABLE "Role" DROP COLUMN IF EXISTS "description";
ALTER TABLE "FieldPermission" DROP COLUMN IF EXISTS "ownerOnly";
