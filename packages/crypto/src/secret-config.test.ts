import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { looksLikePlaceholder, secretConfigProblems } from './index.js'

const strong = () => randomBytes(32).toString('hex')
const good = () => ({
  JWT_SECRET: strong(),
  TOKEN_ENCRYPTION_KEY: strong(),
  STORAGE_SIGNING_KEY: strong(),
  DATABASE_URL: `postgresql://nova_app:${randomBytes(18).toString('base64url')}@db:5432/nova`,
  QUEUE_REDIS_URL: `redis://:${randomBytes(18).toString('base64url')}@queue:6379`,
})

describe('looksLikePlaceholder', () => {
  it('示例文件里的占位值与开发默认值都被识别', () => {
    for (const value of [
      'REPLACE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS',
      'local-development-secret-change-me-at-least-32',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'nova_app_dev_password',
      'a'.repeat(64),
      '1'.repeat(64),
      '',
      '   ',
    ]) {
      expect(looksLikePlaceholder(value), value).toBe(true)
    }
  })

  it('随机生成的值不会被误判', () => {
    for (let i = 0; i < 50; i += 1) expect(looksLikePlaceholder(strong())).toBe(false)
    expect(looksLikePlaceholder(randomBytes(24).toString('base64url'))).toBe(false)
  })
})

describe('secretConfigProblems', () => {
  it('全部是随机值：没有问题', () => {
    expect(secretConfigProblems(good())).toEqual([])
  })

  it('JWT_SECRET 缺失、是示例值或过于简单：报问题；清单里不回显值', () => {
    expect(secretConfigProblems({ ...good(), JWT_SECRET: undefined })).toEqual(['JWT_SECRET 未配置'])
    const problems = secretConfigProblems({ ...good(), JWT_SECRET: 'local-development-secret-change-me-at-least-32' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('JWT_SECRET')
    expect(problems.join()).not.toContain('local-development')
  })

  it('主密钥：旧变量与新变量里的示例值都被发现；两把都随机则通过', () => {
    const dev = '0123456789abcdef'.repeat(4)
    expect(secretConfigProblems({ ...good(), TOKEN_ENCRYPTION_KEY: dev })).toHaveLength(1)
    expect(secretConfigProblems({ ...good(), TOKEN_ENCRYPTION_KEY: undefined, ENCRYPTION_MASTER_KEYS: `new:${strong()},old:${dev}` })).toHaveLength(1)
    expect(secretConfigProblems({ ...good(), TOKEN_ENCRYPTION_KEY: undefined, ENCRYPTION_MASTER_KEYS: `new:${strong()},old:${strong()}` })).toEqual([])
  })

  it('连接串里的密码：示例密码被发现；没有密码或解析不了的连接串不在这里处理', () => {
    expect(secretConfigProblems({ ...good(), DATABASE_URL: 'postgresql://nova_app:nova_app_dev_password@localhost:15432/nova' })).toEqual(['DATABASE_URL 里的密码仍是示例值或过于简单'])
    expect(secretConfigProblems({ ...good(), CACHE_REDIS_URL: 'redis://:nova_dev_cache_password@localhost:16380' })).toHaveLength(1)
    expect(secretConfigProblems({ ...good(), DATABASE_SYSTEM_URL: 'not a url' })).toEqual([])
    expect(secretConfigProblems({ ...good(), DATABASE_SYSTEM_URL: 'postgresql://nova_system@db/nova' })).toEqual([])
  })

  it('可选的 STORAGE_SIGNING_KEY：不配不报，配了示例值才报', () => {
    expect(secretConfigProblems({ ...good(), STORAGE_SIGNING_KEY: undefined })).toEqual([])
    expect(secretConfigProblems({ ...good(), STORAGE_SIGNING_KEY: 'REPLACE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS' })).toHaveLength(1)
  })
})
