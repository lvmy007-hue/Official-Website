import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { CryptoError } from './errors.js'
import { KmsMasterKeyProvider } from './kms.js'
import type { KmsClient, MasterKeyProvider } from './types.js'

// 主密钥（环境变量方式）。配置：
//   ENCRYPTION_MASTER_KEYS=主密钥编号:64位十六进制,主密钥编号:64位十六进制     可同时配置多把（轮换期间新旧并存）
//   ENCRYPTION_MASTER_KEY_ACTIVE=主密钥编号                                       新包裹使用哪一把；只配一把时可省略
//   TOKEN_ENCRYPTION_KEY=64位十六进制                                             沿用的老变量：未显式配置同名编号时，它作为编号 env-1 的主密钥
//   ENCRYPTION_KEY_PROVIDER=env|kms                                              默认 env；kms 需要部署专项接入云密钥管理客户端
// 主密钥是 32 字节（64 位十六进制）。它只用来包裹数据密钥，不直接加密业务数据（老版本密文除外，见 keyring 的兼容说明）。

type Env = Record<string, string | undefined>

const HEX_KEY = /^[0-9a-fA-F]{64}$/
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/
export const LEGACY_MASTER_KEY_ID = 'env-1'

export interface ParsedMasterKeys {
  keys: Map<string, Buffer>
  activeId: string
  /** 老版本密文（改造前直接用 TOKEN_ENCRYPTION_KEY 加密的）所用的根密钥；没配置则为 null。 */
  legacyRoot: Buffer | null
}

export function parseMasterKeys(env: Env): ParsedMasterKeys {
  const keys = new Map<string, Buffer>()
  const raw = env.ENCRYPTION_MASTER_KEYS?.trim()
  if (raw) {
    for (const item of raw
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)) {
      const index = item.indexOf(':')
      const id = index < 0 ? '' : item.slice(0, index).trim()
      const hex = index < 0 ? '' : item.slice(index + 1).trim()
      if (!KEY_ID.test(id) || !HEX_KEY.test(hex)) throw new CryptoError('KEY_NOT_CONFIGURED', 'ENCRYPTION_MASTER_KEYS 的每一项必须是“编号:64 位十六进制”，编号只能含字母、数字、下划线、短横线')
      if (keys.has(id)) throw new CryptoError('KEY_NOT_CONFIGURED', `ENCRYPTION_MASTER_KEYS 中的主密钥编号重复：${id}`)
      keys.set(id, Buffer.from(hex, 'hex'))
    }
  }
  const legacyHex = env.TOKEN_ENCRYPTION_KEY?.trim() ?? ''
  const legacyRoot = HEX_KEY.test(legacyHex) ? Buffer.from(legacyHex, 'hex') : null
  if (legacyRoot && !keys.has(LEGACY_MASTER_KEY_ID)) keys.set(LEGACY_MASTER_KEY_ID, legacyRoot)
  if (keys.size === 0) throw new CryptoError('KEY_NOT_CONFIGURED', '主密钥未配置：请设置 ENCRYPTION_MASTER_KEYS（或 TOKEN_ENCRYPTION_KEY），格式为 32 字节十六进制')
  const configured = env.ENCRYPTION_MASTER_KEY_ACTIVE?.trim()
  let activeId = configured
  if (!activeId) {
    if (keys.size > 1) throw new CryptoError('KEY_NOT_CONFIGURED', '配置了多把主密钥，必须用 ENCRYPTION_MASTER_KEY_ACTIVE 指定新包裹使用哪一把')
    activeId = [...keys.keys()][0]
  }
  if (!keys.has(activeId)) throw new CryptoError('KEY_NOT_CONFIGURED', `ENCRYPTION_MASTER_KEY_ACTIVE 指定的主密钥 ${activeId} 不在已配置的主密钥中`)
  return { keys, activeId, legacyRoot }
}

export class EnvMasterKeyProvider implements MasterKeyProvider {
  readonly name = 'env' as const
  readonly activeId: string

  constructor(
    private readonly keys: Map<string, Buffer>,
    activeId: string,
  ) {
    if (!keys.has(activeId)) throw new CryptoError('KEY_NOT_CONFIGURED', `主密钥 ${activeId} 未配置`)
    this.activeId = activeId
  }

  async wrap(dataKey: Buffer, context: string): Promise<{ wrapped: string; masterKeyId: string }> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeId)!, iv)
    cipher.setAAD(Buffer.from(context))
    const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()])
    return { wrapped: [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.'), masterKeyId: this.activeId }
  }

  async unwrap(wrapped: string, masterKeyId: string, context: string): Promise<Buffer> {
    const key = this.keys.get(masterKeyId)
    if (!key) throw new CryptoError('KEY_NOT_FOUND', `数据密钥由主密钥 ${masterKeyId} 包裹，但该主密钥不在当前配置中（轮换期间请保留旧主密钥，直到重新包裹完成）`)
    const [iv, tag, encrypted] = wrapped.split('.').map(part => Buffer.from(part, 'base64url'))
    if (!iv || !tag || !encrypted) throw new CryptoError('CIPHERTEXT_INVALID', '被包裹的数据密钥格式不正确')
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()])
    } catch (error) {
      throw new CryptoError('DECRYPT_FAILED', `用主密钥 ${masterKeyId} 解开数据密钥失败（主密钥不对或数据被改动）`, { cause: error })
    }
  }
}

export interface CreateMasterKeyOptions {
  /** 云密钥管理客户端；ENCRYPTION_KEY_PROVIDER=kms 时必须提供。 */
  kms?: KmsClient
}

export function createMasterKeyProvider(env: Env = process.env, options: CreateMasterKeyOptions = {}): { provider: MasterKeyProvider; legacyRoot: Buffer | null } {
  const choice = (env.ENCRYPTION_KEY_PROVIDER ?? 'env').trim().toLowerCase()
  const legacyHex = env.TOKEN_ENCRYPTION_KEY?.trim() ?? ''
  const legacyRoot = HEX_KEY.test(legacyHex) ? Buffer.from(legacyHex, 'hex') : null
  if (choice === 'kms') {
    if (!options.kms) throw new CryptoError('KEY_NOT_CONFIGURED', '云密钥管理服务尚未接入：ENCRYPTION_KEY_PROVIDER=kms 需要部署专项提供客户端；当前请使用 env')
    const keyId = env.KMS_KEY_ID?.trim()
    if (!keyId) throw new CryptoError('KEY_NOT_CONFIGURED', 'ENCRYPTION_KEY_PROVIDER=kms 时必须设置 KMS_KEY_ID')
    return { provider: new KmsMasterKeyProvider(options.kms, keyId), legacyRoot }
  }
  if (choice !== 'env') throw new CryptoError('KEY_NOT_CONFIGURED', 'ENCRYPTION_KEY_PROVIDER 只能是 env 或 kms')
  const parsed = parseMasterKeys(env)
  return { provider: new EnvMasterKeyProvider(parsed.keys, parsed.activeId), legacyRoot: parsed.legacyRoot }
}
