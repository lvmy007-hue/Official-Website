import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { CryptoError } from './errors.js'
import type { DataKeyRecord, KeyStore, MasterKeyProvider, SecretPurpose } from './types.js'

// 密钥环（P1-24）：按用途管理数据密钥，负责加密、解密、数据密钥轮换、主密钥轮换后的重新包裹、旧密文迁移。
//
// 密文格式：nk2.<数据密钥版本>.<iv>.<认证标签>.<密文>（各段 base64url）。认证附加数据 = “用途 + 版本”，
// 所以密文换用途、换版本都会解密失败。明文与密钥永远不会出现在错误信息或日志里。
//
// 兼容改造前的老密文（三段 iv.tag.密文，无前缀）：亚马逊令牌与买家信息直接用 TOKEN_ENCRYPTION_KEY 加密，
// 多因素认证密钥用其 HKDF 派生密钥加密。老密文仍可解密，重加密任务会把它们迁到新格式；全部迁完后可去掉兼容（配置 legacyRoot 为空）。

const PREFIX = 'nk2'
const DEFAULT_CACHE_TTL_MS = 60_000

export interface KeyringOptions {
  store: KeyStore
  master: MasterKeyProvider
  /** 老密文的根密钥（TOKEN_ENCRYPTION_KEY）；为空表示不再兼容老密文。 */
  legacyRoot?: Buffer | null
  /** 数据密钥缓存时长：别的进程做了轮换后，本进程最迟在这个时间内改用新版本写入（读取不受影响，遇到未知版本会立即刷新）。 */
  cacheTtlMs?: number
  now?: () => number
}

interface Parsed {
  version: number
  iv: Buffer
  tag: Buffer
  body: Buffer
}

const wrapContext = (purpose: string, version: number) => `nova:dek:${purpose}:${version}`
const aadOf = (purpose: string, version: number) => Buffer.from(`nova:${purpose}:v${version}`)

function parse(ciphertext: string): Parsed | 'legacy' {
  const parts = ciphertext.split('.')
  if (parts.length === 5 && parts[0] === PREFIX) {
    const version = Number(parts[1])
    if (!Number.isInteger(version) || version < 1) throw new CryptoError('CIPHERTEXT_INVALID', '密文格式不正确')
    const [iv, tag, body] = parts.slice(2).map(part => Buffer.from(part, 'base64url'))
    if (iv.length !== 12 || tag.length !== 16 || body.length === 0) throw new CryptoError('CIPHERTEXT_INVALID', '密文格式不正确')
    return { version, iv, tag, body }
  }
  if (parts.length === 3 && parts.every(Boolean)) return 'legacy'
  throw new CryptoError('CIPHERTEXT_INVALID', '密文格式不正确')
}

export class Keyring {
  private readonly store: KeyStore
  private readonly master: MasterKeyProvider
  private readonly legacyRoot: Buffer | null
  private readonly ttl: number
  private readonly now: () => number
  /** 已解开的数据密钥：键是“用途:版本”，签名用于发现被重新包裹或替换。 */
  private readonly unwrapped = new Map<string, { signature: string; key: Buffer }>()
  private active = new Map<string, number>()
  private loadedAt = 0
  private pendingLoad: Promise<void> | null = null

  constructor(options: KeyringOptions) {
    this.store = options.store
    this.master = options.master
    this.legacyRoot = options.legacyRoot ?? null
    this.ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.now = options.now ?? Date.now
  }

  // ---------- 加密与解密 ----------

  async seal(purpose: SecretPurpose, plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
    const version = await this.currentVersion(purpose)
    const key = await this.keyFor(purpose, version)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aadOf(purpose, version))
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return { ciphertext: [PREFIX, String(version), iv, cipher.getAuthTag(), body].map(part => (typeof part === 'string' ? part : part.toString('base64url'))).join('.'), keyVersion: version }
  }

  async open(purpose: SecretPurpose, ciphertext: string): Promise<string> {
    const parsed = parse(ciphertext)
    if (parsed === 'legacy') return this.openLegacy(purpose, ciphertext)
    const key = await this.keyFor(purpose, parsed.version)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv)
      decipher.setAAD(aadOf(purpose, parsed.version))
      decipher.setAuthTag(parsed.tag)
      return Buffer.concat([decipher.update(parsed.body), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new CryptoError('DECRYPT_FAILED', '解密失败（用途不符或数据被改动）', { cause: error })
    }
  }

  private openLegacy(purpose: SecretPurpose, ciphertext: string): string {
    if (!this.legacyRoot) throw new CryptoError('KEY_NOT_FOUND', '这是旧格式密文，而旧格式兼容已关闭')
    const key = purpose === 'mfa' ? Buffer.from(hkdfSync('sha256', this.legacyRoot, Buffer.alloc(0), 'nova:mfa:v1', 32)) : this.legacyRoot
    const [iv, tag, body] = ciphertext.split('.').map(part => Buffer.from(part, 'base64url'))
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new CryptoError('DECRYPT_FAILED', '解密失败（用途不符或数据被改动）', { cause: error })
    }
  }

  // ---------- 轮换与迁移 ----------

  /** 密文是否已经用该用途当前的数据密钥版本加密（老格式密文一律不是）。 */
  async isCurrent(purpose: SecretPurpose, ciphertext: string): Promise<boolean> {
    const parsed = parse(ciphertext)
    if (parsed === 'legacy') return false
    return parsed.version === (await this.currentVersion(purpose))
  }

  /** 迁移一条密文到当前版本；已经是当前版本返回 null（调用方不需要写回）。 */
  async reencrypt(purpose: SecretPurpose, ciphertext: string): Promise<{ ciphertext: string; keyVersion: number } | null> {
    if (await this.isCurrent(purpose, ciphertext)) return null
    return this.seal(purpose, await this.open(purpose, ciphertext))
  }

  /** 数据密钥轮换：生成新版本接手新写入，旧版本退役但仍可解密。返回新版本号。 */
  async rotateDataKey(purpose: SecretPurpose): Promise<number> {
    await this.load(true)
    const latest = Math.max(0, ...[...this.unwrapped.keys()].filter(id => id.startsWith(`${purpose}:`)).map(id => Number(id.split(':')[1])))
    const version = latest + 1
    const dataKey = randomBytes(32)
    const { wrapped, masterKeyId } = await this.master.wrap(dataKey, wrapContext(purpose, version))
    try {
      await this.store.insert({ purpose, version, wrappedKey: wrapped, masterKeyId })
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'KEY_STORE_CONFLICT') {
        // 另一个进程同时轮换：以对方创建的版本为准，不再重复生成
        await this.load(true)
        return this.currentVersion(purpose)
      }
      throw error
    }
    await this.store.retireBefore(purpose, version)
    await this.load(true)
    return version
  }

  /** 主密钥轮换后：用当前主密钥重新包裹所有还由旧主密钥包裹的数据密钥。不改动任何业务密文。返回重新包裹的数量。 */
  async rewrapAll(): Promise<number> {
    const records = await this.store.list()
    let count = 0
    for (const record of records) {
      if (record.masterKeyId === this.master.activeId) continue
      const dataKey = await this.master.unwrap(record.wrappedKey, record.masterKeyId, wrapContext(record.purpose, record.version))
      const { wrapped, masterKeyId } = await this.master.wrap(dataKey, wrapContext(record.purpose, record.version))
      await this.store.updateWrap(record.id, wrapped, masterKeyId)
      count++
    }
    this.loadedAt = 0
    return count
  }

  /** 各用途的数据密钥版本状态（不含任何密钥内容），用于巡检与运维。 */
  async status(): Promise<Array<{ purpose: string; version: number; status: string; masterKeyId: string; createdAt: Date; retiredAt: Date | null }>> {
    return (await this.store.list()).map(({ purpose, version, status, masterKeyId, createdAt, retiredAt }) => ({ purpose, version, status, masterKeyId, createdAt, retiredAt }))
  }

  /** 启动时调用：确保三类用途都有数据密钥，并校验主密钥能解开已有数据密钥（配置错误尽早暴露）。 */
  async prepare(purposes: readonly SecretPurpose[]): Promise<void> {
    await this.load(true)
    for (const purpose of purposes) await this.currentVersion(purpose)
  }

  // ---------- 内部：加载与缓存 ----------

  /** 该用途当前接手新写入的数据密钥版本（尚无数据密钥时会创建第一版）。 */
  async currentVersion(purpose: SecretPurpose): Promise<number> {
    await this.load(false)
    const existing = this.active.get(purpose)
    if (existing) return existing
    // 该用途还没有数据密钥：创建第一版（并发创建时以先成功的为准）
    await this.createFirst(purpose)
    const created = this.active.get(purpose)
    if (!created) throw new CryptoError('KEY_NOT_FOUND', `没有可用的数据密钥：${purpose}`)
    return created
  }

  private async createFirst(purpose: SecretPurpose): Promise<void> {
    const dataKey = randomBytes(32)
    const { wrapped, masterKeyId } = await this.master.wrap(dataKey, wrapContext(purpose, 1))
    try {
      await this.store.insert({ purpose, version: 1, wrappedKey: wrapped, masterKeyId })
    } catch (error) {
      if (!(error instanceof CryptoError && error.code === 'KEY_STORE_CONFLICT')) throw error
    }
    await this.load(true)
  }

  private async keyFor(purpose: SecretPurpose, version: number): Promise<Buffer> {
    await this.load(false)
    let entry = this.unwrapped.get(`${purpose}:${version}`)
    if (!entry) {
      await this.load(true) // 可能是别的进程刚轮换出的新版本
      entry = this.unwrapped.get(`${purpose}:${version}`)
    }
    if (!entry) throw new CryptoError('KEY_NOT_FOUND', `数据密钥不存在：${purpose} v${version}`)
    return entry.key
  }

  private load(force: boolean): Promise<void> {
    if (!force && this.now() - this.loadedAt < this.ttl) return Promise.resolve()
    this.pendingLoad ??= this.reload().finally(() => {
      this.pendingLoad = null
    })
    return this.pendingLoad
  }

  private async reload(): Promise<void> {
    const records = await this.store.list()
    const active = new Map<string, number>()
    const seen = new Set<string>()
    for (const record of records) {
      const id = `${record.purpose}:${record.version}`
      seen.add(id)
      const signature = `${record.masterKeyId}|${record.wrappedKey}`
      const cached = this.unwrapped.get(id)
      if (!cached || cached.signature !== signature) {
        this.unwrapped.set(id, { signature, key: await this.master.unwrap(record.wrappedKey, record.masterKeyId, wrapContext(record.purpose, record.version)) })
      }
      if (record.status === 'ACTIVE') active.set(record.purpose, Math.max(active.get(record.purpose) ?? 0, record.version))
    }
    for (const id of [...this.unwrapped.keys()]) if (!seen.has(id)) this.unwrapped.delete(id)
    this.active = active
    this.loadedAt = this.now()
  }
}

export type { DataKeyRecord }
