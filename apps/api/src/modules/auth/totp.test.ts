import { describe, expect, it } from 'vitest'
import { RECOVERY_CODE_PATTERN } from '@nova/api-contracts'
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, hotp, otpauthUri, totpAt, totpStep, verifyTotp } from './totp'

// RFC 6238 附录 B 的标准测试向量（SHA1，密钥为 ASCII "12345678901234567890"，8 位）
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('动态验证码（RFC 6238）', () => {
  it.each(RFC_VECTORS)('标准测试向量：时间 %i 秒 → %s', (seconds, expected) => {
    expect(totpAt(RFC_SECRET, seconds * 1000, 8)).toBe(expected)
  })

  it('HOTP 标准测试向量（RFC 4226）', () => {
    const secret = Buffer.from('12345678901234567890')
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(counter => hotp(secret, counter))).toEqual(['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'])
  })

  it('Base32 编码与解码互为逆运算，兼容小写、空格与连字符', () => {
    const data = Buffer.from('hello, nova erp')
    expect(base32Decode(base32Encode(data)).equals(data)).toBe(true)
    expect(base32Encode(Buffer.from('abcdefghij'))).toBe('MFRGGZDFMZTWQ2LK')
    expect(base32Decode('mfrg gzdf-mztw q2lk==').toString()).toBe('abcdefghij')
    expect(() => base32Decode('ABC1')).toThrow()
  })

  it('新密钥是 32 位 Base32 文本，两次生成不同', () => {
    const first = generateTotpSecret()
    expect(first).toMatch(/^[A-Z2-7]{32}$/)
    expect(generateTotpSecret()).not.toBe(first)
  })

  it('验证：当前步与前后各一步的验证码通过，两步之外拒绝', () => {
    const secret = generateTotpSecret()
    const now = 1_800_000_000_000
    const at = (offset: number) => totpAt(secret, now + offset * 30_000)
    expect(verifyTotp(secret, at(0), now)).toEqual({ ok: true, step: totpStep(now) })
    expect(verifyTotp(secret, at(-1), now).ok).toBe(true)
    expect(verifyTotp(secret, at(1), now).ok).toBe(true)
    expect(verifyTotp(secret, at(-2), now).ok).toBe(false)
    expect(verifyTotp(secret, at(2), now).ok).toBe(false)
  })

  it('防重放：不大于上一次成功所在步的验证码一律拒绝', () => {
    const secret = generateTotpSecret()
    const now = 1_800_000_000_000
    const code = totpAt(secret, now)
    const first = verifyTotp(secret, code, now)
    expect(first.ok).toBe(true)
    const lastUsedStep = first.ok ? first.step : null
    expect(verifyTotp(secret, code, now, { lastUsedStep }).ok).toBe(false)
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now + 30_000, { lastUsedStep }).ok).toBe(true)
  })

  it('格式不对（长度、字母、空串）直接拒绝', () => {
    const secret = generateTotpSecret()
    for (const code of ['', '12345', '1234567', 'abcdef', '12 456']) expect(verifyTotp(secret, code, Date.now()).ok).toBe(false)
  })

  it('绑定链接包含密钥、发行方与账号，且对特殊字符转义', () => {
    const uri = otpauthUri({ issuer: 'NOVA ERP', account: 'a+b@example.com', secret: 'ABCDEFGH' })
    expect(uri).toBe('otpauth://totp/NOVA%20ERP:a%2Bb%40example.com?secret=ABCDEFGH&issuer=NOVA%20ERP&algorithm=SHA1&digits=6&period=30')
  })
})

describe('恢复码', () => {
  it('生成指定数量、格式符合契约、互不重复', () => {
    const codes = generateRecoveryCodes(10)
    expect(codes).toHaveLength(10)
    for (const code of codes) expect(code).toMatch(RECOVERY_CODE_PATTERN)
    expect(new Set(codes).size).toBe(10)
  })

  it('哈希与大小写、首尾空白无关，且不同恢复码哈希不同', () => {
    expect(hashRecoveryCode(' abcde-fghjk ')).toBe(hashRecoveryCode('ABCDE-FGHJK'))
    expect(hashRecoveryCode('ABCDE-FGHJK')).not.toBe(hashRecoveryCode('ABCDE-FGHJL'))
    expect(hashRecoveryCode('ABCDE-FGHJK')).toMatch(/^[0-9a-f]{64}$/)
  })
})
