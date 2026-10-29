import { describe, expect, it } from 'vitest'
import { runWithTenant } from './context.js'
import { boundFindMany, catalogFromDatamodel, createTenantScopedClient } from './scoped-client.js'

// 查询必须有边界（12.5）：运行时检测到超过上限行数的查询直接报错。

const catalog = catalogFromDatamodel({ models: [{ name: 'Order', fields: [{ name: 'tenantId', kind: 'scalar' }] }] })

describe('boundFindMany（纯函数）', () => {
  it('没有 take 时改为上限加一；显式 take 在上限内原样放行；超过上限立刻报错', () => {
    expect(boundFindMany({ where: { a: 1 } }, 100, 'Order').args).toEqual({ where: { a: 1 }, take: 101 })
    expect(boundFindMany({ take: 100 }, 100, 'Order').args).toEqual({ take: 100 })
    expect(boundFindMany({ take: -50 }, 100, 'Order').check).toBeUndefined()
    expect(() => boundFindMany({ take: 101 }, 100, 'Order')).toThrow('超过单次查询上限')
  })

  it('返回行数超过上限报错，等于上限放行', () => {
    const { check } = boundFindMany(undefined, 3, 'Order')
    expect(() => check?.([1, 2, 3])).not.toThrow()
    expect(() => check?.([1, 2, 3, 4])).toThrow('查询必须带分页或聚合')
  })
})

function rowsPrisma(rowCount: number) {
  const calls: unknown[] = []
  const lazy = (value: unknown) => ({ then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject) })
  const delegate = {
    findMany: (args: unknown) => {
      calls.push(args)
      return lazy(Array.from({ length: rowCount }, (_, index) => ({ id: index })))
    },
    count: () => lazy(rowCount),
  }
  const client: any = {
    order: delegate,
    $queryRaw: () => lazy([{ ok: true }]),
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)({ order: delegate, $queryRaw: () => lazy([{ ok: true }]) })
      const results: unknown[] = []
      for (const item of arg as PromiseLike<unknown>[]) results.push(await item)
      return results
    },
  }
  return { client, calls }
}

describe('租户隔离客户端的行数边界', () => {
  it('单次访问：不带 take 且返回超限的查询直接报错（QUERY_ROW_LIMIT_EXCEEDED）', async () => {
    const fake = rowsPrisma(6)
    const db = createTenantScopedClient(fake.client, { catalog, maxRows: 5 }) as any
    await expect(runWithTenant('t1', () => db.order.findMany({ where: {} }))).rejects.toMatchObject({ code: 'QUERY_ROW_LIMIT_EXCEEDED' })
    expect(fake.calls[0]).toMatchObject({ take: 6 })
  })

  it('单次访问：行数在上限内正常返回；带分页的查询不受影响；take 超限立刻报错', async () => {
    const fake = rowsPrisma(5)
    const db = createTenantScopedClient(fake.client, { catalog, maxRows: 5 }) as any
    expect(await runWithTenant('t1', () => db.order.findMany({ where: {} }))).toHaveLength(5)
    expect(await runWithTenant('t1', () => db.order.findMany({ take: 5 }))).toHaveLength(5)
    expect(() => runWithTenant('t1', () => db.order.findMany({ take: 6 }))).toThrow('超过单次查询上限')
  })

  it('数组事务（列表加总数）同样检查；交互式事务同样检查', async () => {
    const fake = rowsPrisma(9)
    const db = createTenantScopedClient(fake.client, { catalog, maxRows: 5 }) as any
    await expect(runWithTenant('t1', () => db.$transaction([db.order.findMany({}), db.order.count({})]))).rejects.toMatchObject({ code: 'QUERY_ROW_LIMIT_EXCEEDED' })
    await expect(runWithTenant('t1', () => db.$transaction(async (tx: any) => tx.order.findMany({})))).rejects.toMatchObject({ code: 'QUERY_ROW_LIMIT_EXCEEDED' })
  })

  it('没有设置 maxRows：不改写参数、不检查', async () => {
    const fake = rowsPrisma(50)
    const db = createTenantScopedClient(fake.client, { catalog }) as any
    expect(await runWithTenant('t1', () => db.order.findMany({}))).toHaveLength(50)
    expect(fake.calls[0]).not.toHaveProperty('take')
  })
})
