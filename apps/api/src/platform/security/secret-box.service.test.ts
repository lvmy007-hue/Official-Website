import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../http'
import { MemorySecretBox } from '../../testing/memory-secret-box'

const ROOT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('应用层加密（接口服务）', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    for (const name of ['ENCRYPTION_MASTER_KEYS', 'ENCRYPTION_MASTER_KEY_ACTIVE', 'ENCRYPTION_KEY_PROVIDER']) delete process.env[name]
    process.env.TOKEN_ENCRYPTION_KEY = ROOT
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('令牌密文带数据密钥版本、不含明文；数据库（内存替身）里只有被包裹的数据密钥', async () => {
    const box = new MemorySecretBox()
    const sealed = await box.sealAmazonToken('Atzr|secret-token')
    expect(sealed.startsWith('nk2.1.')).toBe(true)
    expect(sealed).not.toContain('secret-token')
    const rows = await box.memory.list()
    expect(rows.map(row => row.purpose)).toEqual(['amazon-token'])
    expect(JSON.stringify(rows)).not.toContain(ROOT)
  })

  it('接口服务没有任何解密亚马逊令牌与买家信息的入口', () => {
    const box = new MemorySecretBox() as unknown as Record<string, unknown>
    for (const name of ['openAmazonToken', 'openToken', 'openPii', 'sealPii', 'open', 'seal', 'keyring']) expect(box[name], name).toBeUndefined()
  })

  it('多因素认证密钥：加密后可解密；换密钥环的另一份实例用同一份数据密钥也能解', async () => {
    const box = new MemorySecretBox()
    const sealed = await box.sealMfa('JBSWY3DPEHPK3PXP')
    expect(sealed.keyVersion).toBe(1)
    expect(await box.openMfa(sealed.ciphertext)).toBe('JBSWY3DPEHPK3PXP')
    // 令牌用途的密文不能当作多因素密钥打开
    await expect(box.openMfa(await box.sealAmazonToken('x'))).rejects.toThrow()
  })

  it('改造前的多因素密文（HKDF 派生密钥、三段式）仍可解密', async () => {
    const derived = Buffer.from(hkdfSync('sha256', Buffer.from(ROOT, 'hex'), Buffer.alloc(0), 'nova:mfa:v1', 32))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', derived, iv)
    const body = Buffer.concat([cipher.update('OLD-SECRET', 'utf8'), cipher.final()])
    const legacy = [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
    expect(await new MemorySecretBox().openMfa(legacy)).toBe('OLD-SECRET')
  })

  it('主密钥未配置：返回 503 TOKEN_VAULT_NOT_CONFIGURED，不会静默放行', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'short'
    const error = await new MemorySecretBox().sealAmazonToken('x').catch(e => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'TOKEN_VAULT_NOT_CONFIGURED', status: 503 })
  })

  it('启动前检查：三类用途的数据密钥都被创建', async () => {
    const box = new MemorySecretBox()
    await box.prepare()
    expect((await box.memory.list()).map(row => row.purpose).sort()).toEqual(['amazon-token', 'buyer-pii', 'mfa'])
  })
})
