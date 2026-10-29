import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { CursorService, bindingOf, resolveCursorKey } from './cursor.service'
import { parsePageParams } from './page-params'

const sort = { field: 'createdAt', dir: 'desc' } as const

function service() {
  return new CursorService()
}

const row = (id: string, createdAt: Date) => ({ id, createdAt })

describe('游标分页', () => {
  const binding = bindingOf('t1', { q: 'abc', storeIds: ['s1'] })

  it('不足一页时没有下一页游标', () => {
    const result = service().page([row('a', new Date('2026-01-02'))], { pageSize: 2, sort, binding })
    expect(result.pageInfo).toEqual({ pageSize: 2, nextCursor: null, hasMore: false, approxTotal: null })
    expect(result.items).toHaveLength(1)
  })

  it('多取一行即有下一页，游标可还原为复合条件（时间字段，降序用 lt）', () => {
    const svc = service()
    const rows = [row('c', new Date('2026-01-03')), row('b', new Date('2026-01-02')), row('a', new Date('2026-01-01'))]
    const { items, pageInfo } = svc.page(rows, { pageSize: 2, sort, binding, approxTotal: 120 })
    expect(items.map(item => item.id)).toEqual(['c', 'b'])
    expect(pageInfo.hasMore).toBe(true)
    expect(pageInfo.approxTotal).toBe(120)
    const where = svc.after(pageInfo.nextCursor!, sort, binding) as { OR: Array<Record<string, any>> }
    expect(where.OR[0]).toEqual({ createdAt: { lt: new Date('2026-01-02') } })
    expect(where.OR[1]).toEqual({ createdAt: new Date('2026-01-02'), id: { lt: 'b' } })
  })

  it('升序使用 gt；数值与高精度小数字段可用', () => {
    const svc = service()
    const asc = { field: 'qty', dir: 'asc' } as const
    const { pageInfo } = svc.page(
      [
        { id: 'x', qty: 5 },
        { id: 'y', qty: 6 },
      ],
      { pageSize: 1, sort: asc, binding },
    )
    const where = svc.after(pageInfo.nextCursor!, asc, binding) as { OR: Array<Record<string, any>> }
    expect(where.OR[0]).toEqual({ qty: { gt: 5 } })

    const money = { field: 'amount', dir: 'desc' } as const
    const dec = svc.page(
      [
        { id: 'p', amount: new Prisma.Decimal('12.340000') },
        { id: 'q', amount: new Prisma.Decimal('1') },
      ],
      { pageSize: 1, sort: money, binding },
    )
    const decWhere = svc.after(dec.pageInfo.nextCursor!, money, binding) as { OR: Array<Record<string, any>> }
    expect(decWhere.OR[0].amount.lt).toBe('12.34')
  })

  it('没有游标时不附加条件（第一页）', () => {
    expect(service().after(undefined, sort, binding)).toEqual({})
  })

  it('篡改、截断、伪造的游标都被拒绝', () => {
    const svc = service()
    const rows = [row('b', new Date('2026-01-02')), row('a', new Date('2026-01-01'))]
    const token = svc.page(rows, { pageSize: 1, sort, binding }).pageInfo.nextCursor!
    const [body, signature] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), i: 'zzz' })).toString('base64url')
    for (const bad of [`${forgedBody}.${signature}`, `${body}.AAAA`, body, `${token}.extra`, 'not-a-cursor', '.']) {
      expect(() => svc.after(bad, sort, binding)).toThrowError(/游标/)
    }
  })

  it('查询条件、租户、排序任一变化，游标失效', () => {
    const svc = service()
    const rows = [row('b', new Date('2026-01-02')), row('a', new Date('2026-01-01'))]
    const token = svc.page(rows, { pageSize: 1, sort, binding }).pageInfo.nextCursor!
    expect(() => svc.after(token, sort, bindingOf('t1', { q: 'other', storeIds: ['s1'] }))).toThrowError(/游标/)
    expect(() => svc.after(token, sort, bindingOf('t2', { q: 'abc', storeIds: ['s1'] }))).toThrowError(/游标/)
    expect(() => svc.after(token, { field: 'createdAt', dir: 'asc' }, binding)).toThrowError(/游标/)
    expect(() => svc.after(token, { field: 'updatedAt', dir: 'desc' }, binding)).toThrowError(/游标/)
  })

  it('分页参数不参与绑定，翻页时游标仍然有效', () => {
    expect(bindingOf('t1', { q: 'abc', page: 1, pageSize: 50 })).toBe(bindingOf('t1', { q: 'abc', cursor: 'x', pageSize: 100 }))
  })

  it('排序字段为空值时报错，避免产生错误游标', () => {
    expect(() =>
      service().page(
        [
          { id: 'a', createdAt: null },
          { id: 'b', createdAt: null },
        ],
        { pageSize: 1, sort, binding },
      ),
    ).toThrowError(/空值/)
  })

  it('排序字段 + 编号构成次序，保证翻页不重不漏', () => {
    expect(service().orderBy(sort)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('同一时间戳的多行翻页：不重复、不遗漏', () => {
    // 用内存数据模拟数据库按 (createdAt desc, id desc) 排序与条件过滤
    const svc = service()
    const same = new Date('2026-01-01T00:00:00Z')
    const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => row(id, same)).concat([row('z', new Date('2026-01-02')), row('y', new Date('2025-12-31'))])
    const sorted = [...all].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1))
    const run = (where: any) =>
      sorted.filter(item => {
        if (!where.OR) return true
        const [first, second] = where.OR
        return item.createdAt < first.createdAt.lt || (item.createdAt.getTime() === second.createdAt.getTime() && item.id < second.id.lt)
      })
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = run(svc.after(cursor, sort, binding)).slice(0, 4)
      const page = svc.page(rows.length === 4 ? rows : rows, { pageSize: 3, sort, binding })
      seen.push(...page.items.map(item => item.id))
      if (!page.pageInfo.hasMore) break
      cursor = page.pageInfo.nextCursor!
    }
    expect(seen).toEqual(sorted.map(item => item.id))
  })
})

describe('签名密钥', () => {
  it('专用密钥优先，其次由登录密钥派生，都没有则拒绝', () => {
    const dedicated = 'd'.repeat(32)
    const jwt = 'j'.repeat(40)
    expect(resolveCursorKey({ CURSOR_SIGNING_KEY: dedicated, JWT_SECRET: jwt } as never).toString()).toBe(dedicated)
    expect(resolveCursorKey({ JWT_SECRET: jwt } as never)).toHaveLength(32)
    expect(() => resolveCursorKey({ CURSOR_SIGNING_KEY: 'short' } as never)).toThrowError(/密钥/)
  })
})

describe('页码参数', () => {
  it('默认 50、上限 200、超限报校验错误', () => {
    expect(parsePageParams({})).toEqual({ page: 1, pageSize: 50, skip: 0, take: 50 })
    expect(parsePageParams({ page: '3', pageSize: '200' })).toMatchObject({ skip: 400, take: 200 })
    expect(() => parsePageParams({ pageSize: '201' })).toThrow()
  })
})
