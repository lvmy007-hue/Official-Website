-- M-P1-13 回滚：手工执行；同时需从 _prisma_migrations 删除本迁移记录，并回退 schema.prisma。
-- 注意：
--   1. 回滚会删除预设角色与字段权限、成员邀请；若已有成员使用预设角色，需先把他们改回自建角色，否则外键阻止删除。
--   2. 旧权限展开是只增不减的数据变更（旧点位本身保留），回滚后角色里多出的新点位无害，不做反向删除；
--      如需完全还原，请从迁移前的备份恢复 "Role"."permissions"。
DROP TRIGGER IF EXISTS "FieldPermission_protect_preset" ON "FieldPermission";
ALTER TABLE "Role" ALTER COLUMN "version" SET DEFAULT 1;
DROP TRIGGER IF EXISTS "Role_protect_preset" ON "Role";
DROP FUNCTION IF EXISTS nova_protect_preset_roles();
DROP TABLE IF EXISTS "MemberInvitation";
DROP TABLE IF EXISTS "FieldPermission";
-- 触发器已删除，此时可以删除预设角色
DELETE FROM "Role" WHERE "tenantId" IS NULL AND "system" AND "id" LIKE 'preset-%';
