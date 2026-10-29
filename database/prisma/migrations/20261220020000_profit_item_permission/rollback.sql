-- 回滚 M-P6-18 的权限点：把 finance.profititem.manage 从预设角色里去掉（同样要先停用预设角色保护触发器）。
-- 已经保存的利润项目字典不受影响，但之后没有人能修改它，直到权限点重新加回。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" - 'finance.profititem.manage'
WHERE "id" IN ('preset-admin', 'preset-finance')
  AND "tenantId" IS NULL
  AND "system";

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
