-- M-P1-19：租户注册与生命周期（12 章 12.7）。
-- 1. 企业表：数据口径时区默认改为美国太平洋时区；新增企业本地时区与生命周期状态；已有企业原来的时区（默认上海）移到“本地时区”。
-- 2. 新增平台运营账号、开通邀请（系统连接专用），初始化向导进度、限时支持访问（租户可读写），生命周期事件与配额（租户只读）。
-- 回滚方法见同目录 rollback.sql。

-- 1. 企业表
ALTER TABLE "Tenant" ADD COLUMN "localTimezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai';
-- 已有企业：原先的“时区”其实是企业所在地时区，保留为本地时区；数据口径时区统一为美国太平洋时区
UPDATE "Tenant" SET "localTimezone" = "timezone" WHERE "timezone" <> 'America/Los_Angeles';
UPDATE "Tenant" SET "timezone" = 'America/Los_Angeles';
ALTER TABLE "Tenant" ALTER COLUMN "timezone" SET DEFAULT 'America/Los_Angeles';
ALTER TABLE "Tenant" ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Tenant" ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "retentionDays" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "closeStateJson" JSONB;
ALTER TABLE "Tenant" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_lifecycleStatus_check" CHECK ("lifecycleStatus" IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CLOSING', 'CLOSED'));
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_retentionDays_check" CHECK ("retentionDays" IS NULL OR "retentionDays" BETWEEN 1 AND 3650);

-- 企业自己的连接（nova_app）不得修改生命周期相关列：这些列只有平台经系统连接才能改
CREATE FUNCTION nova_guard_tenant_lifecycle() RETURNS trigger AS $$
BEGIN
  IF current_user = 'nova_app' AND (
    NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus"
    OR NEW."lifecycleChangedAt" IS DISTINCT FROM OLD."lifecycleChangedAt"
    OR NEW."retentionDays" IS DISTINCT FROM OLD."retentionDays"
    OR NEW."closeStateJson" IS DISTINCT FROM OLD."closeStateJson"
    OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
  ) THEN
    RAISE EXCEPTION '企业生命周期状态只能由平台修改' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Tenant_lifecycle_guard" BEFORE UPDATE ON "Tenant" FOR EACH ROW EXECUTE FUNCTION nova_guard_tenant_lifecycle();

-- 2. 平台运营账号（系统连接专用）
CREATE TABLE "PlatformAdmin" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "mfaRequired" BOOLEAN NOT NULL DEFAULT true,
  "mfaSecretCiphertext" TEXT,
  "mfaKeyVersion" INTEGER,
  "mfaVerifiedAt" TIMESTAMP(3),
  "mfaLastStep" INTEGER,
  "tokenValidAfter" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformAdmin_role_check" CHECK ("role" IN ('PLATFORM_OWNER', 'PLATFORM_OPS', 'PLATFORM_SUPPORT')),
  CONSTRAINT "PlatformAdmin_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  -- 平台账号的多因素认证恒为必选
  CONSTRAINT "PlatformAdmin_mfaRequired_check" CHECK ("mfaRequired" = true)
);
CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

-- 开通邀请（系统连接专用）：只存令牌哈希
CREATE TABLE "TenantInvitation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdByPlatformAdminId" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantInvitation_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT "TenantInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantInvitation_tokenHash_key" ON "TenantInvitation"("tokenHash");
CREATE INDEX "TenantInvitation_tenantId_status_idx" ON "TenantInvitation"("tenantId", "status");

-- 3. 初始化向导进度
CREATE TABLE "TenantOnboarding" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "step" TEXT NOT NULL DEFAULT 'PROFILE',
  "stepStateJson" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantOnboarding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantOnboarding_step_check" CHECK ("step" IN ('PROFILE', 'ENTITIES', 'SELLER_AUTH', 'ADS_AUTH', 'SYNC_SCOPE', 'FX_COST', 'MEMBERS', 'WRITE_SWITCHES', 'DONE')),
  CONSTRAINT "TenantOnboarding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantOnboarding_tenantId_key" ON "TenantOnboarding"("tenantId");

-- 4. 生命周期事件（租户只读）
CREATE TABLE "TenantLifecycleEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "fromStatus" TEXT NOT NULL,
  "toStatus" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorPlatformAdminId" TEXT,
  "detailJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantLifecycleEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantLifecycleEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TenantLifecycleEvent_tenantId_createdAt_idx" ON "TenantLifecycleEvent"("tenantId", "createdAt");

-- 5. 配额（租户只读）
CREATE TABLE "TenantQuota" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "quotaKey" TEXT NOT NULL,
  "limitValue" INTEGER NOT NULL,
  "usedValue" INTEGER NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantQuota_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantQuota_quotaKey_check" CHECK ("quotaKey" IN ('stores', 'members', 'backfillDays')),
  CONSTRAINT "TenantQuota_limitValue_check" CHECK ("limitValue" >= 0),
  CONSTRAINT "TenantQuota_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantQuota_tenantId_quotaKey_key" ON "TenantQuota"("tenantId", "quotaKey");

-- 6. 限时支持访问授权
CREATE TABLE "PlatformSupportAccess" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "platformAdminId" TEXT,
  "grantedByUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),
  "scope" TEXT NOT NULL DEFAULT 'READ_ONLY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformSupportAccess_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformSupportAccess_scope_check" CHECK ("scope" = 'READ_ONLY'),
  -- 授权期限不超过 7 天
  CONSTRAINT "PlatformSupportAccess_period_check" CHECK ("expiresAt" > "startsAt" AND "expiresAt" - "startsAt" <= INTERVAL '7 days'),
  CONSTRAINT "PlatformSupportAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PlatformSupportAccess_tenantId_expiresAt_idx" ON "PlatformSupportAccess"("tenantId", "expiresAt");

-- 7. 行级安全
-- 向导进度、支持访问授权：本企业可读写
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['TenantOnboarding', 'PlatformSupportAccess'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
  END LOOP;
  -- 生命周期事件、配额：本企业只读（写入只有平台经系统连接）
  FOREACH tbl IN ARRAY ARRAY['TenantLifecycleEvent', 'TenantQuota'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING ("tenantId" = (SELECT nova_current_tenant()))', tbl);
  END LOOP;
END $$;

-- 8. 授权（账号存在才授权）：PlatformAdmin、TenantInvitation 只有系统连接可访问（租户账号没有授权，系统账号靠默认权限获得）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantOnboarding", "PlatformSupportAccess" TO nova_app;
    GRANT SELECT ON "TenantLifecycleEvent", "TenantQuota" TO nova_app;
    REVOKE ALL ON "PlatformAdmin", "TenantInvitation" FROM nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PlatformAdmin", "TenantInvitation", "TenantOnboarding", "TenantLifecycleEvent", "TenantQuota", "PlatformSupportAccess" TO nova_system;
  END IF;
END $$;
