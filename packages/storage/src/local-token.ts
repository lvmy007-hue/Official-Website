import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { StorageError } from './errors.js'
import { assertStorageKey } from './key.js'

// 本地驱动的短时签名令牌：服务端把“哪个文件、读还是写、何时失效、上传的类型与大小上限”签进令牌，
// 只有持有令牌的人能在有效期内做那一件事；令牌不能用于别的文件，也无法被推算出来。

export interface LocalTokenPayload {
  /** 完整路径 */
  k: string
  op: 'GET' | 'PUT'
  /** 失效时间（秒级时间戳） */
  exp: number
  /** 直传时要求的内容类型 */
  ct?: string
  /** 直传时的大小上限 */
  max?: number
}

const PREFIX = 'v1'
const encode = (buffer: Buffer) => buffer.toString('base64url')

/** 由主密钥派生出本地签名密钥（按用途隔离，签名密钥泄露不影响其他用途）。 */
export function deriveSigningKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'nova-storage', 'local-signed-url', 32))
}

function sign(signingKey: Buffer, body: string): Buffer {
  return createHmac('sha256', signingKey).update(`${PREFIX}.${body}`).digest()
}

export function signLocalToken(signingKey: Buffer, payload: LocalTokenPayload): string {
  assertStorageKey(payload.k)
  const body = encode(Buffer.from(JSON.stringify(payload)))
  return `${PREFIX}.${body}.${encode(sign(signingKey, body))}`
}

/** 验证令牌：格式、签名、有效期。任何一项不满足都抛错；错误信息不区分细节（除了“已过期”）。 */
export function verifyLocalToken(signingKey: Buffer, token: string, now: Date = new Date()): LocalTokenPayload {
  const invalid = () => new StorageError('STORAGE_TOKEN_INVALID', '链接无效')
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3 || parts[0] !== PREFIX || parts[1].length > 4096) throw invalid()
  const given = Buffer.from(parts[2], 'base64url')
  const expected = sign(signingKey, parts[1])
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid()
  let payload: LocalTokenPayload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as LocalTokenPayload
  } catch {
    throw invalid()
  }
  if (!payload || typeof payload.k !== 'string' || (payload.op !== 'GET' && payload.op !== 'PUT') || typeof payload.exp !== 'number') throw invalid()
  assertStorageKey(payload.k)
  if (payload.exp * 1000 <= now.getTime()) throw new StorageError('STORAGE_TOKEN_EXPIRED', '链接已过期，请重新获取')
  return payload
}
