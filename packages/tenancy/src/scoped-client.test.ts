import { describe, expect, it } from 'vitest'
import { TenantIsolationError, runWithTenant } from './context.js'
import { catalogFromDatamodel, createTenantScopedClient, scopeArguments, scopeCreateData, scopeWhere } from './scoped-client.js'

const catalog = catalogFromDatamodel({
  models: [
    {
      name: 'PurchaseOrder',
      fields: [
        { name: 'id', kind: 'scalar' },
        { name: 'tenantId', kind: 'scalar' },
        { name: 'supplier', kind: 'object' },
        { name: 'tenant', kind: 'object' },
      ],
    },
    { name: 'Order', fields: [{ name: 'tenantId', kind: 'scalar' }] },
    { name: 'PurchaseOrderLine', fields: [{ name: 'purchaseOrderId', kind: 'scalar' }] },
    { name: 'User', fields: [{ name: 'email', kind: 'scalar' }] },
  ],
})

const relations = catalog.relationFields.get('PurchaseOrder')
const fail = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return error as TenantIsolationError
  }
  throw new Error('预期抛出错误，但没有')
}

describe('模型目录', () => {
  it('从数据模型描述得到全部模型、租户模型与关系字段', () => {
    expect(catalog.allModels).toEqual(['PurchaseOrder', 'Order', 'PurchaseOrderLine', 'User'])
    expect([...catalog.tenantModels].sort()).toEqual(['Order', 'PurchaseOrder'])
    expect([...(relations ?? [])].sort()).toEqual(['supplier', 'tenant'])
  })
})

describe('查询条件补租户 scopeWhere', () => {
  it('没有租户条件：补上', () => {
    expect(scopeWhere({ id: 'a' }, 't1', 'Order')).toEqual({ id: 'a', tenantId: 't1' })
    expect(scopeWhere(undefined, 't1', 'Order')).toEqual({ tenantId: 't1' })
  })
  it('租户条件一致：原样返回', () => {
    const where = { id: 'a', tenantId: 't1' }
    expect(scopeWhere(where, 't1', 'Order')).toBe(where)
  })
  it('指定了别的租户：拒绝', () => {
    const error = fail(() => scopeWhere({ tenantId: 't2' }, 't1', 'Order'))
    expect(error).toBeInstanceOf(TenantIsolationError)
    expect(error.code).toBe('TENANT_MISMATCH')
  })
  it('过滤器对象（in 等）：与当前租户取交集', () => {
    expect(scopeWhere({ tenantId: { in: ['t1', 't2'] } }, 't1', 'Order')).toEqual({ AND: [{ tenantId: { in: ['t1', 't2'] } }, { tenantId: 't1' }] })
  })
})

describe('创建数据补租户 scopeCreateData', () => {
  it('补上租户；已写且一致则不变', () => {
    expect(scopeCreateData({ number: 'PO-1' }, 't1', 'PurchaseOrder', relations)).toEqual({ number: 'PO-1', tenantId: 't1' })
    const data = { number: 'PO-1', tenantId: 't1' }
    expect(scopeCreateData(data, 't1', 'PurchaseOrder', relations)).toBe(data)
  })
  it('写了别的租户（标量或关联）：拒绝', () => {
    expect(fail(() => scopeCreateData({ tenantId: 't2' }, 't1', 'PurchaseOrder', relations)).code).toBe('TENANT_MISMATCH')
    expect(fail(() => scopeCreateData({ tenant: { connect: { id: 't2' } } }, 't1', 'PurchaseOrder', relations)).code).toBe('TENANT_MISMATCH')
  })
  it('用关系写法创建时不混入标量（Prisma 不允许混用），交给行级安全兜底', () => {
    const data = { number: 'PO-1', supplier: { connect: { id: 's1' } } }
    expect(scopeCreateData(data, 't1', 'PurchaseOrder', relations)).toBe(data)
  })
})

describe('整体参数改写 scopeArguments', () => {
  it('读写删带条件；upsert 同时处理条件与创建数据；createMany 逐行处理', () => {
    expect(scopeArguments('findMany', undefined, 't1', 'Order', undefined)).toEqual({ where: { tenantId: 't1' } })
    expect(scopeArguments('deleteMany', { where: { id: 'x' } }, 't1', 'Order', undefined)).toEqual({ where: { id: 'x', tenantId: 't1' } })
    expect(scopeArguments('upsert', { where: { id: 'x' }, create: { id: 'x' }, update: { a: 1 } }, 't1', 'Order', undefined)).toEqual({
      where: { id: 'x', tenantId: 't1' },
      create: { id: 'x', tenantId: 't1' },
      update: { a: 1 },
    })
    expect(scopeArguments('createMany', { data: [{ id: 'a' }, { id: 'b', tenantId: 't1' }] }, 't1', 'Order', undefined).data).toEqual([
      { id: 'a', tenantId: 't1' },
      { id: 'b', tenantId: 't1' },
    ])
  })
  it('更新不得把数据改到别的租户', () => {
    expect(fail(() => scopeArguments('update', { where: { id: 'x' }, data: { tenantId: 't2' } }, 't1', 'Order', undefined)).code).toBe('TENANT_MISMATCH')
    expect(fail(() => scopeArguments('updateMany', { where: {}, data: { tenantId: { set: 't2' } } }, 't1', 'Order', undefined)).code).toBe('TENANT_MISMATCH')
    expect(() => scopeArguments('update', { where: { id: 'x' }, data: { tenantId: 't1', notes: 'x' } }, 't1', 'Order', undefined)).not.toThrow()
  })
})

// 模拟 Prisma 客户端：操作是“惰性”的（await 时才执行），事务按顺序执行并记录。
function fakePrisma() {
  const executed: string[] = []
  const transactions: string[][] = []
  const lazy = (label: string, value: unknown) => ({
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      executed.push(label)
      return Promise.resolve(value).then(resolve, reject)
    },
  })
  const delegateFor = (name: string) => new Proxy({}, { get: (_t, operation) => (args: unknown) => lazy(`${name}.${String(operation)} ${JSON.stringify(args)}`, { name, operation, args }) })
  const surface = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => lazy(`raw ${strings.join('?')} [${values.join(',')}]`, [{ ok: true }]),
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => lazy(`exec ${strings.join('?')} [${values.join(',')}]`, 1),
    $disconnect: async () => 'closed',
  }
  const withDelegates = <T extends object>(extra: T) =>
    new Proxy({ ...surface, ...extra } as Record<string, unknown>, {
      get: (target, prop) => (typeof prop === 'string' && /^[a-z]/.test(prop) && !(prop in target) ? delegateFor(prop) : target[prop as string]),
    })
  const client = withDelegates({
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') {
        transactions.push(['interactive'])
        return (arg as (tx: unknown) => unknown)(withDelegates({}))
      }
      const items = arg as PromiseLike<unknown>[]
      const before = executed.length
      const results: unknown[] = []
      for (const item of items) results.push(await item)
      transactions.push(executed.slice(before))
      return results
    },
  })
  return { client: client as any, executed, transactions }
}

const scoped = (fake: ReturnType<typeof fakePrisma>, extra: Partial<Parameters<typeof createTenantScopedClient>[1]> = {}) => createTenantScopedClient(fake.client, { catalog, ...extra }) as any

describe('租户隔离客户端', () => {
  it('租户模型没有租户上下文：直接报错，不触达数据库', () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    expect(fail(() => db.purchaseOrder.findMany({})).code).toBe('TENANT_CONTEXT_MISSING')
    expect(fake.executed).toEqual([])
  })

  it('非租户模型没有租户上下文：直接放行（例如健康检查、全局表）', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    await db.user.findMany({ where: { email: 'a' } })
    await db.$queryRaw`SELECT 1`
    expect(fake.transactions).toEqual([])
    expect(fake.executed).toHaveLength(2)
  })

  it('单次访问：同一个事务里先设置租户变量，再执行带租户条件的查询', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    const result = await runWithTenant('t1', () => db.purchaseOrder.findMany({ where: { status: 'OPEN' } }))
    expect(result).toEqual({ name: 'purchaseOrder', operation: 'findMany', args: { where: { status: 'OPEN', tenantId: 't1' } } })
    expect(fake.transactions).toHaveLength(1)
    expect(fake.transactions[0]).toEqual(['raw SELECT set_config(?, ?, true) [app.tenant_id,t1]', 'purchaseOrder.findMany {"where":{"status":"OPEN","tenantId":"t1"}}'])
  })

  it('配置了语句超时：同一条设置语句里顺带设置事务级 statement_timeout（对连接池事务模式同样有效）', async () => {
    const fake = fakePrisma()
    const db = scoped(fake, { statementTimeoutMs: 30000 })
    await runWithTenant('t1', () => db.purchaseOrder.findMany({}))
    expect(fake.transactions[0][0]).toBe("raw SELECT set_config(?, ?, true), set_config('statement_timeout', ?, true) [app.tenant_id,t1,30000]")
  })

  it('子表（没有 tenantId 列）也在设置了租户变量的事务里执行，条件不改写', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    await runWithTenant('t1', () => db.purchaseOrderLine.findMany({ where: { purchaseOrderId: 'p1' } }))
    expect(fake.transactions[0]).toEqual(['raw SELECT set_config(?, ?, true) [app.tenant_id,t1]', 'purchaseOrderLine.findMany {"where":{"purchaseOrderId":"p1"}}'])
  })

  it('数组事务：列表加总数放在同一个事务里，租户变量只设置一次，返回值不含设置语句的结果', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    const [items, total] = await runWithTenant('t1', () => db.$transaction([db.order.findMany({ take: 5 }), db.order.count({})]))
    expect((items as any).operation).toBe('findMany')
    expect((total as any).operation).toBe('count')
    expect(fake.transactions).toHaveLength(1)
    expect(fake.transactions[0]).toEqual(['raw SELECT set_config(?, ?, true) [app.tenant_id,t1]', 'order.findMany {"take":5,"where":{"tenantId":"t1"}}', 'order.count {"where":{"tenantId":"t1"}}'])
  })

  it('交互式事务：开头设置租户变量；事务内的操作直接执行且带租户条件，不再嵌套事务', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    await runWithTenant('t1', () =>
      db.$transaction(async (tx: any) => {
        await tx.order.create({ data: { id: 'o1' } })
        return tx.purchaseOrder.update({ where: { id: 'p1' }, data: { notes: 'x' } })
      }),
    )
    expect(fake.transactions).toEqual([['interactive']])
    expect(fake.executed).toEqual([
      'raw SELECT set_config(?, ?, true) [app.tenant_id,t1]',
      'order.create {"data":{"id":"o1","tenantId":"t1"}}',
      'purchaseOrder.update {"where":{"id":"p1","tenantId":"t1"},"data":{"notes":"x"}}',
    ])
  })

  it('交互式事务里仍然拒绝越界写入', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    await expect(runWithTenant('t1', () => db.$transaction(async (tx: any) => tx.order.create({ data: { tenantId: 't2' } })))).rejects.toMatchObject({ code: 'TENANT_MISMATCH' })
  })

  it('原始 SQL：有租户上下文时同样先设置租户变量', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    await runWithTenant('t1', () => db.$queryRaw`SELECT count(*) FROM "Order"`)
    expect(fake.transactions[0][0]).toBe('raw SELECT set_config(?, ?, true) [app.tenant_id,t1]')
    expect(fake.transactions[0][1]).toBe('raw SELECT count(*) FROM "Order" []')
  })

  it('数组事务里混入别的租户上下文创建的操作：拒绝', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    const foreign = runWithTenant('t2', () => db.order.findMany({}))
    expect(() => runWithTenant('t1', () => db.$transaction([foreign]))).toThrow(/不同的租户上下文/)
  })

  it('并发的两个租户互不串扰', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    const [a, b] = await Promise.all([runWithTenant('t1', () => db.order.findMany({})), runWithTenant('t2', () => db.order.findMany({}))])
    expect((a as any).args.where.tenantId).toBe('t1')
    expect((b as any).args.where.tenantId).toBe('t2')
  })

  it('非数据访问的属性与方法原样透传', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    expect(await db.$disconnect()).toBe('closed')
  })

  it('独立数据库接入点：按租户选择底层客户端，业务代码不变', async () => {
    const shared = fakePrisma()
    const dedicated = fakePrisma()
    const db = scoped(shared, { resolveClient: (tenantId?: string) => (tenantId === 'big-customer' ? dedicated.client : shared.client) })
    await runWithTenant('big-customer', () => db.order.findMany({}))
    await runWithTenant('small-customer', () => db.order.findMany({}))
    expect(dedicated.transactions).toHaveLength(1)
    expect(shared.transactions).toHaveLength(1)
    expect(dedicated.executed.at(-1)).toContain('"tenantId":"big-customer"')
    expect(shared.executed.at(-1)).toContain('"tenantId":"small-customer"')
  })

  it('同一个操作被多次 await 只执行一次', async () => {
    const fake = fakePrisma()
    const db = scoped(fake)
    const call = runWithTenant('t1', () => db.order.count({}))
    await call
    await call
    expect(fake.transactions).toHaveLength(1)
  })
})
