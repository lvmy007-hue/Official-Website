import { describe, expect, it } from 'vitest'
import { diffSnapshots, redactForAudit } from './audit-snapshot'

describe('审计快照脱敏', () => {
  it('令牌、密码、密钥、买家与联系方式类字段一律隐藏，空值保持原样', () => {
    const redacted = redactForAudit({
      name: '主体甲',
      refreshToken: 'abc',
      accessToken: 'def',
      password: 'p',
      passwordHash: 'h',
      clientSecret: 's',
      buyerName: '张三',
      email: 'a@b.cn',
      phone: '123',
      shipAddress: 'x',
      nullable: null,
      nested: { authorization: 'Bearer x', keep: 1 },
    }) as Record<string, unknown>
    expect(redacted).toEqual({
      name: '主体甲',
      refreshToken: '[已隐藏]',
      accessToken: '[已隐藏]',
      password: '[已隐藏]',
      passwordHash: '[已隐藏]',
      clientSecret: '[已隐藏]',
      buyerName: '[已隐藏]',
      email: '[已隐藏]',
      phone: '[已隐藏]',
      shipAddress: '[已隐藏]',
      nullable: null,
      nested: { authorization: '[已隐藏]', keep: 1 },
    })
  })

  it('限长限深：长文本截断、大数组截断、过深层级省略；日期与金额转成字符串', () => {
    const long = 'x'.repeat(800)
    const result = redactForAudit({ long, list: Array.from({ length: 60 }, (_, i) => i), at: new Date('2026-03-01T00:00:00Z'), amount: { toJSON: () => '12.340000' } }) as any
    expect(result.long.length).toBe(501)
    expect(result.list).toHaveLength(51)
    expect(result.list[50]).toContain('另有 10 项')
    expect(result.at).toBe('2026-03-01T00:00:00.000Z')
    expect(result.amount).toBe('12.340000')
    let deep: any = { v: 1 }
    for (let i = 0; i < 10; i += 1) deep = { child: deep }
    expect(JSON.stringify(redactForAudit(deep))).toContain('层级过深')
  })
})

describe('字段级差异', () => {
  it('只列出变化的字段，嵌套字段用点号路径，新增与删除分别表现为前或后为空', () => {
    const changes = diffSnapshots({ name: '甲', limits: { stores: 3, members: 5 }, gone: 1 }, { name: '乙', limits: { stores: 3, members: 8 }, added: true })
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: 'name', before: '甲', after: '乙' },
        { field: 'limits.members', before: 5, after: 8 },
        { field: 'gone', before: 1, after: null },
        { field: 'added', before: null, after: true },
      ]),
    )
    expect(changes).toHaveLength(4)
  })

  it('新建只有“后”，删除只有“前”，没有变化返回空', () => {
    expect(diffSnapshots(undefined, { a: 1 })).toEqual([{ field: 'a', before: null, after: 1 }])
    expect(diffSnapshots({ a: 1 }, undefined)).toEqual([{ field: 'a', before: 1, after: null }])
    expect(diffSnapshots({ a: [1, 2] }, { a: [1, 2] })).toEqual([])
  })

  it('差异条数有上限，避免超大对象撑爆审计表', () => {
    const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    expect(diffSnapshots({}, big).length).toBe(200)
  })
})
