-- M-P5-07 回滚：删除法律主体在本包里新增的两个检查约束与版本列。
-- 说明：主体行保留；已停用的主体回滚后状态仍是 INACTIVE（旧代码只列 ACTIVE，会看不到它们，回滚前先决定是否改回 ACTIVE）；版本号丢失。

ALTER TABLE "LegalEntity" DROP CONSTRAINT IF EXISTS "LegalEntity_version_check";
ALTER TABLE "LegalEntity" DROP CONSTRAINT IF EXISTS "LegalEntity_status_check";
ALTER TABLE "LegalEntity" DROP COLUMN IF EXISTS "version";
