import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CryptoError, EnvMasterKeyProvider, KmsMasterKeyProvider, Keyring, MemoryKeyStore, createMasterKeyProvider, parseMasterKeys, type KmsClient, type KeyStore } from './index.js'

const hex = (fill: string) => fill.repeat(64)
const k1 = Buffer.from(hex('1'), 'hex')
const k2 = Buffer.from(hex('2'), 'hex')

function ring(store: KeyStore, keys: Record<string, Buffer>, activeId: string, extra: { legacyRoot?: Buffer | null; now?: () => number; cacheTtlMs?: number } = {}) {
  return new Keyring({ store, master: new EnvMasterKeyProvider(new Map(Object.entries(keys)), activeId), ...extra })
}

describe('加密与解密', () => {
  it('往返一致；每次密文不同；密文不含明文；格式带数据密钥版本', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a')
    const first = await keyring.seal('amazon-token', 'Atzr|refresh-token-明文')
    expect(first.keyVersion).toBe(1)
    expect(first.ciphertext.startsWith('nk2.1.')).toBe(true)
    expect(first.ciphertext).not.toContain('refresh-token')
    expect(await keyring.open('amazon-token', first.ciphertext)).toBe('Atzr|refresh-token-明文')
    expect((await keyring.seal('amazon-token', 'Atzr|refresh-token-明文')).ciphertext).not.toBe(first.ciphertext)
  })

  it('密文绑定用途：拿令牌密文去按其他用途解密一定失败', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a')
    await keyring.prepare(['amazon-token', 'buyer-pii', 'mfa'])
    const { ciphertext } = await keyring.seal('amazon-token', 'secret')
    await expect(keyring.open('buyer-pii', ciphertext)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
    await expect(keyring.open('mfa', ciphertext)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
  })

  it('篡改任意一段、改版本号、截断都解密失败，错误信息不含明文与密文', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a')
    const { ciphertext } = await keyring.seal('mfa', 'PLAINTEXT-SECRET')
    const [prefix, version, iv, tag, body] = ciphertext.split('.')
    const flip = (value: string) => value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA')
    for (const bad of [`${prefix}.${version}.${flip(iv)}.${tag}.${body}`, `${prefix}.${version}.${iv}.${flip(tag)}.${body}`, `${prefix}.${version}.${iv}.${tag}.${flip(body)}`]) {
      await expect(keyring.open('mfa', bad)).rejects.toBeInstanceOf(CryptoError)
    }
    await expect(keyring.open('mfa', `${prefix}.2.${iv}.${tag}.${body}`)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' })
    await expect(keyring.open('mfa', 'garbage')).rejects.toMatchObject({ code: 'CIPHERTEXT_INVALID' })
    await expect(keyring.open('mfa', `${prefix}.1.${iv}.${tag}`)).rejects.toMatchObject({ code: 'CIPHERTEXT_INVALID' })
    try {
      await keyring.open('mfa', `${prefix}.${version}.${iv}.${tag}.${flip(body)}`)
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('PLAINTEXT-SECRET')
      expect(String((error as Error).message)).not.toContain(body)
    }
  })

  it('数据库里只有被主密钥包裹的数据密钥，看不到数据密钥本身', async () => {
    const store = new MemoryKeyStore()
    const keyring = ring(store, { a: k1 }, 'a')
    await keyring.seal('buyer-pii', 'x')
    const [row] = await store.list()
    expect(row.wrappedKey.split('.')).toHaveLength(3)
    expect(row.masterKeyId).toBe('a')
    expect(JSON.stringify(row)).not.toContain(k1.toString('hex'))
  })

  it('另一个进程用同一份存储与主密钥可以解开', async () => {
    const store = new MemoryKeyStore()
    const writer = ring(store, { a: k1 }, 'a')
    const reader = ring(store, { a: k1 }, 'a')
    const { ciphertext } = await writer.seal('amazon-token', 'shared')
    expect(await reader.open('amazon-token', ciphertext)).toBe('shared')
  })

  it('并发首次使用：只会有一个第一版，两边都能解密对方的密文', async () => {
    const store = new MemoryKeyStore()
    const a = ring(store, { a: k1 }, 'a')
    const b = ring(store, { a: k1 }, 'a')
    const [x, y] = await Promise.all([a.seal('mfa', 'from-a'), b.seal('mfa', 'from-b')])
    expect((await store.list()).filter(row => row.purpose === 'mfa')).toHaveLength(1)
    expect(await b.open('mfa', x.ciphertext)).toBe('from-a')
    expect(await a.open('mfa', y.ciphertext)).toBe('from-b')
  })
})

describe('数据密钥轮换', () => {
  it('新写入用新版本，旧密文仍可解密；重加密后全部是新版本', async () => {
    const store = new MemoryKeyStore()
    const keyring = ring(store, { a: k1 }, 'a')
    const old = await keyring.seal('amazon-token', 'token-1')
    expect(await keyring.rotateDataKey('amazon-token')).toBe(2)
    const fresh = await keyring.seal('amazon-token', 'token-2')
    expect(fresh.keyVersion).toBe(2)
    expect(await keyring.open('amazon-token', old.ciphertext)).toBe('token-1')
    expect(await keyring.isCurrent('amazon-token', old.ciphertext)).toBe(false)
    expect(await keyring.isCurrent('amazon-token', fresh.ciphertext)).toBe(true)
    const migrated = await keyring.reencrypt('amazon-token', old.ciphertext)
    expect(migrated?.keyVersion).toBe(2)
    expect(await keyring.open('amazon-token', migrated!.ciphertext)).toBe('token-1')
    expect(await keyring.reencrypt('amazon-token', migrated!.ciphertext)).toBeNull()
    const rows = (await store.list()).filter(row => row.purpose === 'amazon-token')
    expect(rows.map(row => [row.version, row.status])).toEqual([
      [1, 'RETIRED'],
      [2, 'ACTIVE'],
    ])
  })

  it('轮换只影响指定用途', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a')
    await keyring.seal('mfa', 'm')
    await keyring.rotateDataKey('amazon-token')
    expect((await keyring.seal('mfa', 'm2')).keyVersion).toBe(1)
  })

  it('别的进程轮换后：读到新版本的密文立即可解；写入最迟在缓存到期后改用新版本', async () => {
    const store = new MemoryKeyStore()
    let now = 1_000_000
    const a = ring(store, { a: k1 }, 'a', { now: () => now, cacheTtlMs: 60_000 })
    const b = ring(store, { a: k1 }, 'a', { now: () => now, cacheTtlMs: 60_000 })
    await a.seal('amazon-token', 'warm')
    await b.rotateDataKey('amazon-token')
    const fromB = await b.seal('amazon-token', 'from-b')
    expect(await a.open('amazon-token', fromB.ciphertext)).toBe('from-b')
    now += 61_000
    expect((await a.seal('amazon-token', 'later')).keyVersion).toBe(2)
  })

  it('并发轮换：只产生一个新版本', async () => {
    const store = new MemoryKeyStore()
    const a = ring(store, { a: k1 }, 'a')
    const b = ring(store, { a: k1 }, 'a')
    await a.seal('amazon-token', 'x')
    await Promise.all([a.rotateDataKey('amazon-token'), b.rotateDataKey('amazon-token')])
    const versions = (await store.list()).filter(row => row.purpose === 'amazon-token').map(row => row.version)
    expect(versions).toEqual([1, 2])
  })
})

describe('主密钥轮换', () => {
  it('重新包裹后只靠新主密钥即可解开全部旧密文，业务密文不需要改动', async () => {
    const store = new MemoryKeyStore()
    const before = ring(store, { a: k1 }, 'a')
    const t = await before.seal('amazon-token', 'token')
    const p = await before.seal('buyer-pii', 'pii')
    // 新旧主密钥并存，新包裹用 b
    const during = ring(store, { a: k1, b: k2 }, 'b')
    expect(await during.open('amazon-token', t.ciphertext)).toBe('token')
    expect(await during.rewrapAll()).toBe(2)
    expect((await store.list()).every(row => row.masterKeyId === 'b')).toBe(true)
    expect(await during.rewrapAll()).toBe(0)
    const after = ring(store, { b: k2 }, 'b')
    expect(await after.open('amazon-token', t.ciphertext)).toBe('token')
    expect(await after.open('buyer-pii', p.ciphertext)).toBe('pii')
    // 旧主密钥单独已经打不开
    await expect(ring(store, { a: k1 }, 'a').open('amazon-token', t.ciphertext)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' })
  })

  it('已缓存数据密钥的进程在重新包裹后仍然正常，并且换了主密钥配置的进程能加载', async () => {
    const store = new MemoryKeyStore()
    const keyring = ring(store, { a: k1, b: k2 }, 'a', { cacheTtlMs: 0 })
    const { ciphertext } = await keyring.seal('mfa', 'm')
    const switched = ring(store, { a: k1, b: k2 }, 'b', { cacheTtlMs: 0 })
    await switched.rewrapAll()
    expect(await keyring.open('mfa', ciphertext)).toBe('m')
  })
})

describe('兼容改造前的老密文', () => {
  const seal = (key: Buffer, text: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
  }

  it('令牌与买家信息的老密文（直接用根密钥）可解密，并可迁移到新格式', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a', { legacyRoot: k1 })
    const legacy = seal(k1, 'old-refresh-token')
    expect(await keyring.open('amazon-token', legacy)).toBe('old-refresh-token')
    expect(await keyring.isCurrent('amazon-token', legacy)).toBe(false)
    const migrated = await keyring.reencrypt('amazon-token', legacy)
    expect(migrated!.ciphertext.startsWith('nk2.')).toBe(true)
    expect(await keyring.open('amazon-token', migrated!.ciphertext)).toBe('old-refresh-token')
  })

  it('多因素认证的老密文（HKDF 派生密钥）可解密；用别的用途打不开', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a', { legacyRoot: k1 })
    const derived = Buffer.from(hkdfSync('sha256', k1, Buffer.alloc(0), 'nova:mfa:v1', 32))
    const legacy = seal(derived, 'JBSWY3DPEHPK3PXP')
    expect(await keyring.open('mfa', legacy)).toBe('JBSWY3DPEHPK3PXP')
    await expect(keyring.open('amazon-token', legacy)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
  })

  it('关闭兼容后，老密文报明确错误', async () => {
    const keyring = ring(new MemoryKeyStore(), { a: k1 }, 'a', { legacyRoot: null })
    await expect(keyring.open('amazon-token', seal(k1, 'x'))).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' })
  })
})

describe('主密钥配置', () => {
  it('只配 TOKEN_ENCRYPTION_KEY：它是编号 env-1 的主密钥，也是老密文的根密钥', () => {
    const parsed = parseMasterKeys({ TOKEN_ENCRYPTION_KEY: hex('3') })
    expect(parsed.activeId).toBe('env-1')
    expect([...parsed.keys.keys()]).toEqual(['env-1'])
    expect(parsed.legacyRoot?.toString('hex')).toBe(hex('3'))
  })

  it('配多把主密钥：必须指定新包裹用哪一把；编号不存在、格式不对、重复都拒绝', () => {
    const keys = `new:${hex('4')},old:${hex('5')}`
    expect(() => parseMasterKeys({ ENCRYPTION_MASTER_KEYS: keys })).toThrow(/ENCRYPTION_MASTER_KEY_ACTIVE/)
    expect(parseMasterKeys({ ENCRYPTION_MASTER_KEYS: keys, ENCRYPTION_MASTER_KEY_ACTIVE: 'new' }).activeId).toBe('new')
    expect(() => parseMasterKeys({ ENCRYPTION_MASTER_KEYS: keys, ENCRYPTION_MASTER_KEY_ACTIVE: 'nope' })).toThrow(/不在已配置/)
    expect(() => parseMasterKeys({ ENCRYPTION_MASTER_KEYS: 'a:short' })).toThrow(/64 位十六进制/)
    expect(() => parseMasterKeys({ ENCRYPTION_MASTER_KEYS: `a:${hex('1')},a:${hex('2')}` })).toThrow(/重复/)
    expect(() => parseMasterKeys({})).toThrow(/主密钥未配置/)
    expect(() => parseMasterKeys({ TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/主密钥未配置/)
  })

  it('旧变量与新变量并存：旧变量仍作为 env-1 保留，已用它包裹的数据密钥不会失效', () => {
    const parsed = parseMasterKeys({ TOKEN_ENCRYPTION_KEY: hex('6'), ENCRYPTION_MASTER_KEYS: `fresh:${hex('7')}`, ENCRYPTION_MASTER_KEY_ACTIVE: 'fresh' })
    expect([...parsed.keys.keys()].sort()).toEqual(['env-1', 'fresh'])
    expect(parsed.activeId).toBe('fresh')
  })
})

describe('云密钥管理接入点', () => {
  // 假的云端：把数据密钥“加密”成带上下文的字符串，验证调用形状
  const fakeKms: KmsClient = {
    async encrypt(plaintext, context) {
      return { ciphertext: `kms:${context}:${plaintext.toString('base64url')}`, keyId: 'kms-key-1' }
    },
    async decrypt(ciphertext, keyId, context) {
      if (keyId !== 'kms-key-1' || !ciphertext.startsWith(`kms:${context}:`)) throw new Error('bad')
      return Buffer.from(ciphertext.slice(`kms:${context}:`.length), 'base64url')
    },
  }

  it('用云端包裹数据密钥，密钥环行为不变', async () => {
    const store = new MemoryKeyStore()
    const keyring = new Keyring({ store, master: new KmsMasterKeyProvider(fakeKms, 'kms-key-1') })
    const { ciphertext } = await keyring.seal('amazon-token', 'via-kms')
    expect((await store.list())[0].masterKeyId).toBe('kms-key-1')
    expect(await new Keyring({ store, master: new KmsMasterKeyProvider(fakeKms, 'kms-key-1') }).open('amazon-token', ciphertext)).toBe('via-kms')
  })

  it('云端调用失败统一为 KMS_UNAVAILABLE', async () => {
    const broken: KmsClient = {
      encrypt: async () => {
        throw new Error('down')
      },
      decrypt: async () => {
        throw new Error('down')
      },
    }
    const keyring = new Keyring({ store: new MemoryKeyStore(), master: new KmsMasterKeyProvider(broken, 'k') })
    await expect(keyring.seal('mfa', 'x')).rejects.toMatchObject({ code: 'KMS_UNAVAILABLE' })
  })

  it('配置为 kms 但没有客户端：明确报“尚未接入”，不会悄悄退回环境变量', () => {
    expect(() => createMasterKeyProvider({ ENCRYPTION_KEY_PROVIDER: 'kms', TOKEN_ENCRYPTION_KEY: hex('1') })).toThrow(/尚未接入/)
    expect(() => createMasterKeyProvider({ ENCRYPTION_KEY_PROVIDER: 'kms' }, { kms: fakeKms })).toThrow(/KMS_KEY_ID/)
    expect(createMasterKeyProvider({ ENCRYPTION_KEY_PROVIDER: 'kms', KMS_KEY_ID: 'kms-key-1' }, { kms: fakeKms }).provider.name).toBe('kms')
    expect(() => createMasterKeyProvider({ ENCRYPTION_KEY_PROVIDER: 'vault', TOKEN_ENCRYPTION_KEY: hex('1') })).toThrow(/env 或 kms/)
  })
})
