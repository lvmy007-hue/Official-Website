-- 回滚 M-P6-08 的权限点：把 shipfrom.manage 从预设角色“管理员”“供应链”里去掉（同样要先停用预设角色保护触发器）。
-- 已经保存的发货地址不受影响，但之后没有人能新增、修改、停用或删除地址，直到权限点重新加回。
ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" - 'shipfrom.manage'
WHERE "id" IN ('preset-admin', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system";

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
