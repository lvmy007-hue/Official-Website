import { hash } from 'bcryptjs'
import { describe, expect, it, vi } from 'vitest'

// 用真实的 bcrypt 比较次数证明“账号不存在”和“密码错误”走同样的计算路径（防止靠耗时枚举账号）。
const compareSpy = vi.hoisted(() => vi.fn())
vi.mock('bcryptjs', async importOriginal => {
  const module = await importOriginal<typeof import('bcryptjs')>()
  const actual = (module as { default?: typeof import('bcryptjs') }).default ?? module
  compareSpy.mockImplementation(actual.compare)
  return { default: { ...actual, compare: compareSpy }, hash: actual.hash, compare: compareSpy }
})

import { verifyPassword } from './password-check'

describe('verifyPassword', () => {
  it('正确口令通过，错误口令不通过，且每次都做一次哈希比较', async () => {
    const stored = await hash('correct-horse', 4)
    compareSpy.mockClear()
    expect(await verifyPassword('correct-horse', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
    expect(compareSpy).toHaveBeenCalledTimes(2)
  })

  it('账号不存在或不可登录（没有哈希）时仍做一次比较，并固定返回 false', async () => {
    compareSpy.mockClear()
    expect(await verifyPassword('anything', null)).toBe(false)
    expect(await verifyPassword('anything', undefined)).toBe(false)
    expect(await verifyPassword('anything', '')).toBe(false)
    expect(compareSpy).toHaveBeenCalledTimes(3)
  })

  it('用占位哈希比较时，即使口令恰好等于占位口令也不通过', async () => {
    expect(await verifyPassword('nova-member-dummy-password', null)).toBe(false)
  })
})
