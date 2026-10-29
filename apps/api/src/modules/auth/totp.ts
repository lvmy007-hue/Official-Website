import { createHash, createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto'

// 基于时间的一次性密码（RFC 6238，HMAC-SHA1、30 秒一步、6 位），与常见验证器应用兼容。
// 只做算法本身，不碰数据库与配置，便于用标准测试向量验证。

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const TOTP_STEP_SECONDS = 30

export function base32Encode(data: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error('密钥含有不合法的字符')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** 生成新的密钥（默认 20 字节，即 160 位，Base32 文本 32 位）。 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = digest[digest.length - 1] & 15
  const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export const totpStep = (timeMs: number, stepSeconds = TOTP_STEP_SECONDS) => Math.floor(timeMs / 1000 / stepSeconds)

export function totpAt(secretBase32: string, timeMs: number, digits = 6): string {
  return hotp(base32Decode(secretBase32), totpStep(timeMs), digits)
}

const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export type TotpCheck = { ok: true; step: number } | { ok: false }

/**
 * 校验动态验证码：允许前后各 window 步的时钟误差（默认 1 步，即 ±30 秒）。
 * lastUsedStep：上一次成功验证所在的时间步；不大于它的步一律拒绝，防止同一个验证码被重放。
 */
export function verifyTotp(secretBase32: string, code: string, timeMs: number, options: { window?: number; lastUsedStep?: number | null; digits?: number } = {}): TotpCheck {
  const { window = 1, lastUsedStep = null, digits = 6 } = options
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return { ok: false }
  const secret = base32Decode(secretBase32)
  const current = totpStep(timeMs)
  let matched: number | null = null
  // 不提前返回：每个窗口都比较一遍，避免用耗时差异推断验证码正确的位置
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset
    if (step < 0) continue
    if (sameCode(hotp(secret, step, digits), code) && matched === null) matched = step
  }
  if (matched === null) return { ok: false }
  if (lastUsedStep !== null && matched <= lastUsedStep) return { ok: false }
  return { ok: true, step: matched }
}

/** 验证器应用扫描的绑定链接（otpauth 协议）。 */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`
  return `otpauth://totp/${label}?secret=${input.secret}&issuer=${encodeURIComponent(input.issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`
}

// 恢复码字符表：去掉容易混淆的 0、1、O、I
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateRecoveryCodes(count: number): string[] {
  const part = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')
  return Array.from({ length: count }, () => `${part()}-${part()}`)
}

/** 恢复码只存哈希；比较前统一大写。 */
export const hashRecoveryCode = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
