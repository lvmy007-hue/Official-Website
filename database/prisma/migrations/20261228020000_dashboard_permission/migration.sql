-- M-P6-33 权限点 dashboard.write、dashboard.share。
-- 依据：freeze/permissions.md 2.9。所有者通配不用改。
-- write：管理员、运营、广告、财务、供应链。
-- share：管理员、运营。
--
-- 预设角色受触发器保护（Role_protect_preset 拦所有 UPDATE 与 DELETE），所以这里先停用触发器、只改这些行、再立刻恢复。
-- 只追加这两个权限点，其余权限点原样不动；已经带有该权限点的行不重复追加。
-- 企业自己复制出来的自定义角色不受影响。
--
-- 回滚方法：见同目录 rollback.sql。

ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" || '["dashboard.write","dashboard.share"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-ops')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'dashboard.write');

UPDATE "Role"
SET "permissions" = "permissions" || '["dashboard.share"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-ops')
  AND "tenantId" IS NULL
  AND "system"
  AND ("permissions" ? 'dashboard.write')
  AND NOT ("permissions" ? 'dashboard.share');

UPDATE "Role"
SET "permissions" = "permissions" || '["dashboard.write"]'::jsonb
WHERE "id" IN ('preset-ads', 'preset-finance', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'dashboard.write');

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
