-- M-P6-17 权限点 tools.read（跟卖监控）与 tools.manage（管理跟卖白名单）：加进预设角色。
-- 依据：freeze/permissions.md 2.3（所有者通配不用改；tools.read 给管理员、运营、广告、只读；tools.manage 给管理员、运营、广告）。
--
-- 预设角色受触发器保护（Role_protect_preset 拦所有 UPDATE 与 DELETE），所以这里先停用触发器、只改这几行、再立刻恢复。
-- 只追加这两个权限点，其余权限点原样不动；已经带有该权限点的行（例如重复执行）不重复追加。
-- 企业自己复制出来的自定义角色不受影响：需要管理员在角色编辑器里给他们勾上这两个权限点。
--
-- 回滚方法：见同目录 rollback.sql（把这两个权限点从预设角色里去掉）。

ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" || '["tools.read"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-ads', 'preset-readonly')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'tools.read');

UPDATE "Role"
SET "permissions" = "permissions" || '["tools.manage"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-ads')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'tools.manage');

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
