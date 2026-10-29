-- M-P6-18 权限点 finance.profititem.manage（维护利润项目字典与交易类型映射）：加进预设角色“管理员”与“财务”。
-- 依据：freeze/permissions.md 2.7（所有者通配不用改；管理员、财务默认拥有）。
--
-- 预设角色受触发器保护（Role_protect_preset 拦所有 UPDATE 与 DELETE），所以这里先停用触发器、只改这两行、再立刻恢复。
-- 只追加这一个权限点，其余权限点原样不动；已经带有该权限点的行（例如重复执行）不重复追加。
-- 企业自己复制出来的自定义角色不受影响：需要管理员在角色编辑器里给他们勾上这个权限点。
--
-- 回滚方法：见同目录 rollback.sql（把该权限点从预设角色里去掉）。

ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" || '["finance.profititem.manage"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-finance')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'finance.profititem.manage');

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
