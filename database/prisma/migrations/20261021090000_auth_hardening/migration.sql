-- M-P1-17：认证与传输加固。
-- 1. 会话支持刷新凭据轮换：轮换链、上一个会话、重用检测时间、设备指纹、脱敏地址。已有会话各自成为一条只有自己的轮换链。
-- 2. 多因素认证因子表（用户级、不属于任何企业，只允许系统连接访问）。
-- 回滚方法见同目录 rollback.sql（回滚会丢弃新增列与因子表里的内容，请先备份）。

ALTER TABLE "Session" ADD COLUMN "rotationChainId" TEXT;
ALTER TABLE "Session" ADD COLUMN "rotatedFromId" TEXT;
ALTER TABLE "Session" ADD COLUMN "reuseDetectedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "deviceFingerprint" TEXT;
ALTER TABLE "Session" ADD COLUMN "ipMasked" TEXT;
UPDATE "Session" SET "rotationChainId" = "id" WHERE "rotationChainId" IS NULL;
ALTER TABLE "Session" ALTER COLUMN "rotationChainId" SET NOT NULL;
CREATE INDEX "Session_rotationChainId_idx" ON "Session"("rotationChainId");
CREATE INDEX "Session_rotatedFromId_idx" ON "Session"("rotatedFromId");

CREATE TABLE "MfaFactor" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "secretCiphertext" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL DEFAULT 1,
  "verifiedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MfaFactor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfaFactor_kind_check" CHECK ("kind" IN ('TOTP', 'RECOVERY_CODE'))
);
CREATE UNIQUE INDEX "MfaFactor_userId_kind_key" ON "MfaFactor"("userId", "kind");
ALTER TABLE "MfaFactor" ADD CONSTRAINT "MfaFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 授权：与登录会话表一致，只有系统连接可以访问；租户连接账号没有任何权限（默认权限已让系统账号可读写新表）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaFactor" TO nova_system;
  END IF;
END $$;
