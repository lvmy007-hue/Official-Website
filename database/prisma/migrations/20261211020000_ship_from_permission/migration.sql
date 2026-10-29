-- M-P6-08 权限点 shipfrom.manage（新增、修改、停用、删除发货地址，设置店铺默认地址）：把它加进预设角色“管理员”与“供应链”。
-- 依据：freeze/permissions.md 2.5（所有者、管理员、供应链默认拥有；所有者是通配权限，不用改）。
--
-- 预设角色受触发器保护（Role_protect_preset 拦所有 UPDATE 与 DELETE），所以这里先停用触发器、只改这两行、再立刻恢复。
-- 只追加这一个权限点，其余权限点原样不动；已经带有该权限点的行（例如重复执行）不重复追加。
-- 企业自己复制出来的自定义角色不受影响：要维护发货地址，需要管理员在角色编辑器里给他们勾上这个权限点。
--
-- 回滚方法：见同目录 rollback.sql（把该权限点从这两个预设角色里去掉）。

ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" || '["shipfrom.manage"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'shipfrom.manage');

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
