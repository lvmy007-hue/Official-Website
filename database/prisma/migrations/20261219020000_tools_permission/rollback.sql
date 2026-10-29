-- 回滚 M-P6-17 的权限点：把 tools.read、tools.manage 从预设角色里去掉（同样要先停用预设角色保护触发器）。
-- 已经保存的跟卖白名单不受影响，但之后没有人能查看或修改它们，直到权限点重新加回。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = ("permissions" - 'tools.read') - 'tools.manage'
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-ads', 'preset-readonly')
  AND "tenantId" IS NULL
  AND "system";

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
