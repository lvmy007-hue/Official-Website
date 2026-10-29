-- M-P1-24：数据密钥表（密钥分层：主密钥 → 数据密钥 → 机密）。
-- 平台级数据，不属于任何企业，只允许系统连接访问；表里只有被主密钥包裹后的数据密钥。
-- 回滚方法见同目录 rollback.sql（回滚会丢弃数据密钥：此后用这些数据密钥加密的令牌、买家信息与多因素密钥将无法解密，须先确认或先重加密）。

CREATE TABLE "DataEncryptionKey" (
  "id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "wrappedKey" TEXT NOT NULL,
  "masterKeyId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMP(3),
  CONSTRAINT "DataEncryptionKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataEncryptionKey_status_check" CHECK ("status" IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT "DataEncryptionKey_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "DataEncryptionKey_purpose_version_key" ON "DataEncryptionKey"("purpose", "version");

-- 授权：只有系统连接可以访问；租户连接账号没有任何权限。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    -- 只增不删：数据密钥一旦丢失，用它加密的数据永远无法解密，所以连系统账号也不能删除，退役靠状态字段。
    GRANT SELECT, INSERT, UPDATE ON "DataEncryptionKey" TO nova_system;
    REVOKE DELETE, TRUNCATE ON "DataEncryptionKey" FROM nova_system;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    REVOKE ALL ON "DataEncryptionKey" FROM nova_app;
  END IF;
END $$;
