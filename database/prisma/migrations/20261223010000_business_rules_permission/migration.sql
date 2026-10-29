-- M-P6-31 权限点 settings.business.write（修改业务口径：净销售额公式、可用库存组成、周起始日、多站点“今日”的取法）：加进预设角色“管理员”。
-- 依据：freeze/permissions.md 2.10（所有者通配不用改；只有管理员默认拥有）。
--
-- 预设角色受触发器保护（Role_protect_preset 拦所有 UPDATE 与 DELETE），所以这里先停用触发器、只改这一行、再立刻恢复。
-- 只追加这一个权限点，其余权限点原样不动；已经带有该权限点的行（例如重复执行）不重复追加。
-- 企业自己复制出来的自定义角色不受影响：需要管理员在角色编辑器里给他们勾上这个权限点。
--
-- 回滚方法：见同目录 rollback.sql（把该权限点从预设角色里去掉）。

ALTER TABLE "Role" DISABLE TRIGGER "Role_protect_preset";

UPDATE "Role"
SET "permissions" = "permissions" || '["settings.business.write"]'::jsonb
WHERE "id" = 'preset-admin'
  AND "tenantId" IS NULL
  AND "system"
  AND NOT ("permissions" ? 'settings.business.write');

ALTER TABLE "Role" ENABLE TRIGGER "Role_protect_preset";
