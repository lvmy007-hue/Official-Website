-- M-P6-32 权限点 reports.custom.write、reports.custom.share。
-- 依据：freeze/permissions.md 2.9。所有者通配不用改。
-- write：管理员、运营、广告、财务、供应链。
-- share：管理员、运营、财务。
--
-- 预设角色受触发器保护（Role_protect_preset 拦所有 UPDATE 与 DELETE），所以这里先停用触发器、只改这些行、再立刻恢复。
-- 只追加这两个权限点，其余权限点原样不动；已经带有该权限点的行不重复追加。
-- 企业自己复制出来的自定义角色不受影响。
--
-- 回滚方法：见同目录 rollback.sql。

ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" || '["reports.custom.write","reports.custom.share"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-finance')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'reports.custom.write');

UPDATE "Role"
SET "permissions" = "permissions" || '["reports.custom.share"]'::jsonb
WHERE "id" IN ('preset-admin', 'preset-ops', 'preset-finance')
  AND "tenantId" IS NULL
  AND "system"
  AND ("permissions" ? 'reports.custom.write')
  AND NOT ("permissions" ? 'reports.custom.share');

UPDATE "Role"
SET "permissions" = "permissions" || '["reports.custom.write"]'::jsonb
WHERE "id" IN ('preset-ads', 'preset-supply')
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'reports.custom.write');

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
