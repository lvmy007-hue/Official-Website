-- M-P1-19 回滚：移除租户生命周期相关表与企业表的新增列。
-- 警告：会丢失平台运营账号、开通邀请、向导进度、生命周期事件、配额与支持访问授权；
-- 企业的“数据口径时区”不会还原为上海（原默认值本身是缺陷），但会把“本地时区”写回“时区”列之前请先确认。
-- 已处于暂停、停用、注销中、已注销状态的企业，回滚后会全部变为正常使用，必须先确认没有这类企业。
DROP TRIGGER IF EXISTS "Tenant_lifecycle_guard" ON "Tenant";
DROP FUNCTION IF EXISTS nova_guard_tenant_lifecycle();
DROP TABLE IF EXISTS "PlatformSupportAccess";
DROP TABLE IF EXISTS "TenantQuota";
DROP TABLE IF EXISTS "TenantLifecycleEvent";
DROP TABLE IF EXISTS "TenantOnboarding";
DROP TABLE IF EXISTS "TenantInvitation";
DROP TABLE IF EXISTS "PlatformAdmin";
ALTER TABLE "Tenant" DROP CONSTRAINT IF EXISTS "Tenant_retentionDays_check";
ALTER TABLE "Tenant" DROP CONSTRAINT IF EXISTS "Tenant_lifecycleStatus_check";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "closedAt";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "closeStateJson";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "retentionDays";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "lifecycleChangedAt";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "lifecycleStatus";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "localTimezone";
