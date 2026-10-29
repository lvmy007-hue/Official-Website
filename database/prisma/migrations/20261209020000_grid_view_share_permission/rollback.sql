-- 回滚 M-P6-03 的权限点：把 grid.view.share 从预设角色“管理员”“运营”里去掉（同样要先停用预设角色保护触发器）。
-- 已经保存的团队视图不受影响，但之后没有人能新建或修改团队视图，直到权限点重新加回。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" - 'grid.view.share'
WHERE "id" IN ('preset-admin', 'preset-ops')
  AND "tenantId" IS NULL
  AND "system";

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
