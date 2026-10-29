-- 回滚 M-P6-11 的权限点：把 skualias.manage 从预设角色“管理员”“供应链”里去掉（同样要先停用预设角色保护触发器）。
-- 已经保存的外部货号映射与列映射不受影响，但之后没有人能新增、修改、删除它们，直到权限点重新加回。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" - 'skualias.manage'
WHERE "id" IN ('preset-admin', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system";

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
