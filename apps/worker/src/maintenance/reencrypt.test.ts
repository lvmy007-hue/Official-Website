import { createCipheriv, randomBytes } from 'node:crypto'
import { EnvMasterKeyProvider, Keyring, MemoryKeyStore } from '@nova/crypto'
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { reencryptAll } from './reencrypt'

const ROOT = Buffer.from('7'.repeat(64), 'hex')
const logger = { info: () => undefined, warn: () => undefined } as never

type Row = Record<string, any>

// 内存版数据表：只实现重加密用到的查询形状（非空、前缀排除、排序、跳过、限量、按键与旧密文比较的更新）
function table(rows: Row[], column: string, order: string[]) {
  const matches = (row: Row, where: Record<string, any>) =>
    Object.entries(where).every(([key, condition]) => {
      if (key === 'NOT') {
        const prefix = (condition as Record<string, { startsWith: string }>)[column]?.startsWith
        return !(typeof row[column] === 'string' && row[column].startsWith(prefix))
      }
      if (condition && typeof condition === 'object' && 'not' in condition) return row[key] !== condition.not
      return row[key] === condition
    })
  return {
    rows,
    findMany: async (args: { where: Record<string, any>; skip?: number; take?: number }) => {
      const found = rows.filter(row => matches(row, args.where)).sort((a, b) => order.map(key => String(a[key]).localeCompare(String(b[key]))).find(Boolean) ?? 0)
      return found.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? found.length)).map(row => ({ ...row }))
    },
    updateMany: async (args: { where: Record<string, any>; data: Row }) => {
      const hit = rows.filter(row => Object.entries(args.where).every(([key, value]) => row[key] === value))
      for (const row of hit) Object.assign(row, args.data)
      return { count: hit.length }
    },
  }
}

const legacy = (key: Buffer, text: string) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
}

function setup() {
  const store = new MemoryKeyStore()
  const keyring = new Keyring({ store, master: new EnvMasterKeyProvider(new Map([['env-1', ROOT]]), 'env-1'), legacyRoot: ROOT, cacheTtlMs: 0 })
  const platformConnection = table([], 'encryptedRefreshToken', ['id'])
  const order = table([], 'piiCiphertext', ['purchaseDate', 'amazonOrderId'])
  const fbaReturnCase = table([], 'customerCommentsCipher', ['id'])
  const mfaFactor = table([], 'secretCiphertext', ['id'])
  const prisma = { platformConnection, order, fbaReturnCase, mfaFactor } as unknown as PrismaClient
  return { keyring, prisma, platformConnection, order, fbaReturnCase, mfaFactor }
}

describe('重加密（数据密钥轮换后迁移旧密文）', () => {
  it('旧格式与旧版本的密文全部迁到当前版本，明文不变；已是当前版本的不动；没有密文的行不碰', async () => {
    const { keyring, prisma, platformConnection, order, fbaReturnCase, mfaFactor } = setup()
    const v1 = (await keyring.seal('amazon-token', 'token-v1')).ciphertext
    await keyring.rotateDataKey('amazon-token')
    const current = (await keyring.seal('amazon-token', 'token-current')).ciphertext
    platformConnection.rows.push(
      { id: 'c1', encryptedRefreshToken: legacy(ROOT, 'token-legacy') },
      { id: 'c2', encryptedRefreshToken: v1 },
      { id: 'c3', encryptedRefreshToken: current },
      { id: 'c4', encryptedRefreshToken: null },
    )
    order.rows.push(
      { sellerAccountId: 's1', amazonOrderId: 'o1', purchaseDate: '2026-01-01', piiCiphertext: legacy(ROOT, '{"buyerName":"张三"}') },
      { sellerAccountId: 's1', amazonOrderId: 'o2', purchaseDate: '2026-01-02', piiCiphertext: null },
    )
    fbaReturnCase.rows.push({ id: 'r1', customerCommentsCipher: legacy(ROOT, '请寄到 12 Main Street') }, { id: 'r2', customerCommentsCipher: null })
    mfaFactor.rows.push({ id: 'm1', secretCiphertext: legacy(Buffer.from(await hkdf()), 'JBSWY3DPEHPK3PXP'), keyVersion: 1 })

    const summaries = await reencryptAll({ systemPrisma: prisma, keyring, logger, batchSize: 2 })
    expect(summaries.map(item => [item.target, item.migrated, item.failed])).toEqual([
      ['PlatformConnection.encryptedRefreshToken', 2, 0],
      ['Order.piiCiphertext', 1, 0],
      ['FbaReturnCase.customerCommentsCipher', 1, 0],
      ['MfaFactor.secretCiphertext', 1, 0],
    ])
    const tokenVersion = await keyring.currentVersion('amazon-token')
    for (const row of platformConnection.rows.filter(item => item.encryptedRefreshToken)) expect(row.encryptedRefreshToken.startsWith(`nk2.${tokenVersion}.`)).toBe(true)
    expect(await keyring.open('amazon-token', platformConnection.rows[0].encryptedRefreshToken)).toBe('token-legacy')
    expect(await keyring.open('amazon-token', platformConnection.rows[1].encryptedRefreshToken)).toBe('token-v1')
    expect(platformConnection.rows[2].encryptedRefreshToken).toBe(current)
    expect(platformConnection.rows[3].encryptedRefreshToken).toBeNull()
    expect(await keyring.open('buyer-pii', order.rows[0].piiCiphertext)).toBe('{"buyerName":"张三"}')
    expect(order.rows[1].piiCiphertext).toBeNull()
    expect(await keyring.open('buyer-pii', fbaReturnCase.rows[0].customerCommentsCipher)).toBe('请寄到 12 Main Street')
    expect(fbaReturnCase.rows[1].customerCommentsCipher).toBeNull()
    expect(await keyring.open('mfa', mfaFactor.rows[0].secretCiphertext)).toBe('JBSWY3DPEHPK3PXP')
    expect(mfaFactor.rows[0].keyVersion).toBe(await keyring.currentVersion('mfa'))
  })

  it('再运行一次不再有任何迁移（幂等）', async () => {
    const { keyring, prisma, platformConnection } = setup()
    platformConnection.rows.push({ id: 'c1', encryptedRefreshToken: legacy(ROOT, 'a') })
    await reencryptAll({ systemPrisma: prisma, keyring, logger })
    const second = await reencryptAll({ systemPrisma: prisma, keyring, logger })
    expect(second.map(item => item.migrated)).toEqual([0, 0, 0, 0])
  })

  it('解不开的行只记录行编号，不中断也不会无限重试；其余行照常迁移', async () => {
    const { keyring, prisma, platformConnection } = setup()
    platformConnection.rows.push(
      { id: 'bad-1', encryptedRefreshToken: 'garbage' },
      { id: 'good-1', encryptedRefreshToken: legacy(ROOT, 'ok-1') },
      { id: 'bad-2', encryptedRefreshToken: legacy(randomBytes(32), 'someone-elses') },
      { id: 'good-2', encryptedRefreshToken: legacy(ROOT, 'ok-2') },
      { id: 'good-3', encryptedRefreshToken: legacy(ROOT, 'ok-3') },
    )
    const [summary] = await reencryptAll({ systemPrisma: prisma, keyring, logger, batchSize: 2 })
    expect(summary.migrated).toBe(3)
    expect(summary.failed).toBe(2)
    expect(summary.failedIds.sort()).toEqual(['bad-1', 'bad-2'])
    expect(JSON.stringify(summary)).not.toContain('ok-1')
  })

  it('读取之后、写回之前密文被别处改动：不覆盖对方的新值，计为失败待下次处理', async () => {
    const { keyring, prisma, platformConnection } = setup()
    platformConnection.rows.push({ id: 'c1', encryptedRefreshToken: legacy(ROOT, 'old') })
    const racing = (prisma as unknown as { platformConnection: { updateMany: (args: any) => Promise<{ count: number }> } }).platformConnection
    const original = racing.updateMany
    racing.updateMany = async args => {
      platformConnection.rows[0].encryptedRefreshToken = 'changed-by-someone-else'
      return original(args)
    }
    const [summary] = await reencryptAll({ systemPrisma: prisma, keyring, logger })
    expect(summary).toMatchObject({ migrated: 0, failed: 1, failedIds: ['c1'] })
    expect(platformConnection.rows[0].encryptedRefreshToken).toBe('changed-by-someone-else')
  })
})

async function hkdf() {
  const { hkdfSync } = await import('node:crypto')
  return hkdfSync('sha256', ROOT, Buffer.alloc(0), 'nova:mfa:v1', 32)
}
