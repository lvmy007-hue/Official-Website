import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keyring, createMasterKeyProvider, prismaKeyStore } from '@nova/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { totpAt } from '../modules/auth/totp'
import { SystemPrismaService } from '../platform/prisma.service'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { MIGRATIONS_DIR, insertRow } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

const MIGRATION = '20261021120000_data_encryption_key'

// P1-24 密钥与加密（真实数据库）：数据密钥表的约束与权限、迁移回滚、密钥环在真实表上的轮换与重新包裹、
// 以及通过真实接口走完“绑定多因素认证 → 数据密钥轮换 → 旧密文仍可用”。
describe('密钥与加密（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移：约束、权限、回滚', () => {
    it('版本唯一、状态与版本号受约束；租户连接账号没有任何权限，系统账号可读写', async () => {
      await db.createDatabase('crypto_schema')
      db.migrate('crypto_schema')
      const admin = await db.connect('crypto_schema')
      const app = new Client({ connectionString: db.urlFor('crypto_schema', 'app') })
      const system = new Client({ connectionString: db.urlFor('crypto_schema', 'system') })
      await Promise.all([app.connect(), system.connect()])
      try {
        await insertRow(admin, 'DataEncryptionKey', { id: 'k1', purpose: 'mfa', version: 1, wrappedKey: 'w', masterKeyId: 'env-1' })
        await expect(insertRow(admin, 'DataEncryptionKey', { id: 'k2', purpose: 'mfa', version: 1, wrappedKey: 'w', masterKeyId: 'env-1' })).rejects.toThrow(/DataEncryptionKey_purpose_version_key/)
        await expect(insertRow(admin, 'DataEncryptionKey', { id: 'k3', purpose: 'mfa', version: 2, wrappedKey: 'w', masterKeyId: 'env-1', status: 'DELETED' })).rejects.toThrow(
          /DataEncryptionKey_status_check/,
        )
        await expect(insertRow(admin, 'DataEncryptionKey', { id: 'k4', purpose: 'mfa', version: 0, wrappedKey: 'w', masterKeyId: 'env-1' })).rejects.toThrow(/DataEncryptionKey_version_check/)
        await expect(app.query(`SELECT 1 FROM "DataEncryptionKey" LIMIT 1`)).rejects.toMatchObject({ code: '42501' })
        await expect(app.query(`INSERT INTO "DataEncryptionKey" (id, purpose, version, "wrappedKey", "masterKeyId") VALUES ('x', 'mfa', 9, 'w', 'm')`)).rejects.toMatchObject({ code: '42501' })
        expect((await system.query(`SELECT count(*)::int AS n FROM "DataEncryptionKey"`)).rows[0].n).toBe(1)
        // 系统账号不能删除数据密钥（只增不删，退役靠状态）
        await expect(system.query(`DELETE FROM "DataEncryptionKey"`)).rejects.toMatchObject({ code: '42501' })
        await expect(system.query(`TRUNCATE "DataEncryptionKey"`)).rejects.toMatchObject({ code: '42501' })
      } finally {
        await app.end()
        await system.end()
        await admin.end()
      }
    })

    it('回滚脚本可执行，回滚后可再次升级', async () => {
      await db.createDatabase('crypto_rollback')
      db.migrate('crypto_rollback')
      const admin = await db.connect('crypto_rollback')
      try {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, MIGRATION, 'rollback.sql'), 'utf8'))
        expect((await admin.query(`SELECT to_regclass('"DataEncryptionKey"') AS t`)).rows[0].t).toBeNull()
        await admin.query(readFileSync(join(MIGRATIONS_DIR, MIGRATION, 'migration.sql'), 'utf8'))
        expect((await admin.query(`SELECT to_regclass('"DataEncryptionKey"') AS t`)).rows[0].t).not.toBeNull()
      } finally {
        await admin.end()
      }
    })
  })

  describe('密钥环在真实表上', () => {
    let h: DbTestApp
    let keyring: Keyring
    beforeAll(async () => {
      process.env.TOKEN_ENCRYPTION_KEY = '1'.repeat(64)
      h = await createDbTestApp({ database: 'crypto_ring', db })
      const system = h.app.get(SystemPrismaService)
      const { provider, legacyRoot } = createMasterKeyProvider(process.env)
      keyring = new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: provider, legacyRoot, cacheTtlMs: 0 })
    })
    afterAll(async () => {
      await h?.close()
    })

    it('第一次使用创建第一版；数据库只存被包裹的数据密钥；并发创建只有一条', async () => {
      const [a, b] = await Promise.all([keyring.seal('amazon-token', 'token-a'), keyring.seal('amazon-token', 'token-b')])
      expect(a.keyVersion).toBe(1)
      const rows = (await h.client.query(`SELECT purpose, version, status, "masterKeyId", "wrappedKey" FROM "DataEncryptionKey" WHERE purpose = 'amazon-token'`)).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ version: 1, status: 'ACTIVE', masterKeyId: 'env-1' })
      expect(JSON.stringify(rows)).not.toContain('1'.repeat(64))
      expect(await keyring.open('amazon-token', b.ciphertext)).toBe('token-b')
    })

    it('数据密钥轮换：新版本 ACTIVE、旧版本 RETIRED 且仍可解密', async () => {
      const old = await keyring.seal('amazon-token', 'old-token')
      expect(await keyring.rotateDataKey('amazon-token')).toBe(2)
      const states = (await h.client.query(`SELECT version, status, "retiredAt" IS NOT NULL AS retired FROM "DataEncryptionKey" WHERE purpose = 'amazon-token' ORDER BY version`)).rows
      expect(states).toEqual([
        { version: 1, status: 'RETIRED', retired: true },
        { version: 2, status: 'ACTIVE', retired: false },
      ])
      expect(await keyring.open('amazon-token', old.ciphertext)).toBe('old-token')
      expect((await keyring.seal('amazon-token', 'new-token')).keyVersion).toBe(2)
    })

    it('主密钥轮换：重新包裹后只靠新主密钥即可解开旧密文', async () => {
      const sealed = await keyring.seal('amazon-token', 'keep-me')
      const system = h.app.get(SystemPrismaService)
      const rotating = createMasterKeyProvider({ ...process.env, ENCRYPTION_MASTER_KEYS: `next:${'2'.repeat(64)}`, ENCRYPTION_MASTER_KEY_ACTIVE: 'next' })
      const during = new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: rotating.provider, legacyRoot: rotating.legacyRoot, cacheTtlMs: 0 })
      expect(await during.rewrapAll()).toBeGreaterThanOrEqual(1)
      const ids = (await h.client.query(`SELECT DISTINCT "masterKeyId" FROM "DataEncryptionKey"`)).rows.map(row => row.masterKeyId)
      expect(ids).toEqual(['next'])
      // 只配新主密钥的进程能解开
      const onlyNew = createMasterKeyProvider({ ENCRYPTION_MASTER_KEYS: `next:${'2'.repeat(64)}` })
      const fresh = new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: onlyNew.provider, cacheTtlMs: 0 })
      expect(await fresh.open('amazon-token', sealed.ciphertext)).toBe('keep-me')
      // 还原为 env-1，避免影响后面的用例
      const back = createMasterKeyProvider({ TOKEN_ENCRYPTION_KEY: '1'.repeat(64), ENCRYPTION_MASTER_KEYS: `next:${'2'.repeat(64)}`, ENCRYPTION_MASTER_KEY_ACTIVE: 'env-1' })
      await new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: back.provider, cacheTtlMs: 0 }).rewrapAll()
      expect((await h.client.query(`SELECT DISTINCT "masterKeyId" FROM "DataEncryptionKey"`)).rows.map(row => row.masterKeyId)).toEqual(['env-1'])
    })
  })

  describe('经过真实接口：多因素认证密钥', () => {
    let h: DbTestApp
    beforeAll(async () => {
      process.env.TOKEN_ENCRYPTION_KEY = '3'.repeat(64)
      h = await createDbTestApp({ database: 'crypto_mfa', db })
    })
    afterAll(async () => {
      await h?.close()
    })

    it('绑定后库里是新格式密文（不含明文）；数据密钥轮换后已绑定的验证码仍可验证', async () => {
      const tenant = await h.createTenant('crypto')
      const member = await h.createMember(tenant.tenantId, 'crypto', [])
      const enroll = await h.call(member.token, 'POST', '/auth/mfa/enroll')
      expect(enroll.status).toBe(200)
      const secret = enroll.json.data.secret as string
      const stored = (await h.client.query(`SELECT "secretCiphertext", "keyVersion" FROM "MfaFactor" WHERE "userId" = $1 AND kind = 'TOTP'`, [member.userId])).rows[0]
      expect(stored.secretCiphertext.startsWith('nk2.1.')).toBe(true)
      expect(stored.secretCiphertext).not.toContain(secret)
      expect(stored.keyVersion).toBe(1)
      expect((await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: totpAt(secret, Date.now()) } })).status).toBe(200)

      // 轮换 mfa 的数据密钥：已有密文仍是 v1，必须继续可用
      const system = h.app.get(SystemPrismaService)
      const { provider, legacyRoot } = createMasterKeyProvider(process.env)
      const ring = new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: provider, legacyRoot, cacheTtlMs: 0 })
      expect(await ring.rotateDataKey('mfa')).toBe(2)
      const again = await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: totpAt(secret, Date.now() + 30_000) } })
      expect(again.status).toBe(200)
      expect(again.json.data).toMatchObject({ verified: true, method: 'TOTP' })
    })
  })
})
