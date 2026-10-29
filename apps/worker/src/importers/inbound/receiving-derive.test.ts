import { describe, expect, it } from 'vitest'
import { deriveReceiving, planDiscrepancies, type DeriveInput } from './receiving-derive.js'

const DAY = 86_400_000
const now = new Date('2026-10-22T00:00:00.000Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY)

interface Disc {
  id: string
  sku: string
  kind: string
  qty: number
  resolvedAt: Date | null
  shipmentRef: string
  source: string
}
interface Opp {
  dedupKey: string
  status: string
  estimatedAmount: number | null
  currency: string | null
  deadlineAt: Date
}

/** 最小内存库：只实现 deriveReceiving 用到的几个方法。 */
function fakeDb(costs: Record<string, number> = {}, discs: Disc[] = [], opps: Opp[] = []) {
  let seq = 0
  const db = {
    receivingDiscrepancy: {
      findMany: async (args: { where: { shipmentRef: string; source?: string; kind?: string; resolvedAt?: unknown } }) =>
        discs.filter(
          row =>
            row.shipmentRef === args.where.shipmentRef &&
            (!args.where.source || row.source === args.where.source) &&
            (!args.where.kind || row.kind === args.where.kind) &&
            (!args.where.resolvedAt || row.resolvedAt !== null),
        ),
      upsert: async (args: { create: { sku: string; kind: string; qty: number; shipmentRef: string; source: string }; update: { qty: number } }) => {
        const found = discs.find(row => row.shipmentRef === args.create.shipmentRef && row.sku === args.create.sku && row.kind === args.create.kind)
        if (found) Object.assign(found, { qty: args.update.qty, resolvedAt: null })
        else discs.push({ id: `d${++seq}`, resolvedAt: null, ...args.create })
      },
      updateMany: async (args: { where: { id: { in: string[] } }; data: { resolvedAt: Date } }) => {
        for (const row of discs.filter(item => args.where.id.in.includes(item.id))) row.resolvedAt = args.data.resolvedAt
      },
    },
    reimbursementOpportunity: {
      findUnique: async (args: { where: { tenantId_sellerAccountId_ruleCode_dedupKey: { dedupKey: string } } }) =>
        opps.find(row => row.dedupKey === args.where.tenantId_sellerAccountId_ruleCode_dedupKey.dedupKey) ?? null,
      upsert: async (args: { create: Opp; update: Omit<Opp, 'dedupKey'> }) => {
        const found = opps.find(row => row.dedupKey === args.create.dedupKey)
        if (found) Object.assign(found, args.update)
        else opps.push({ ...args.create })
      },
      updateMany: async (args: { where: { dedupKey: string; status: string }; data: { status: string } }) => {
        const hit = opps.filter(row => row.dedupKey === args.where.dedupKey && row.status === args.where.status)
        for (const row of hit) row.status = args.data.status
        return { count: hit.length }
      },
    },
    tenantSetting: { findFirst: async () => null },
    costVersion: {
      findFirst: async (args: { where: { sku: string } }) => (costs[args.where.sku] === undefined ? null : { unitProductCost: { toNumber: () => costs[args.where.sku] }, currency: 'CNY' }),
    },
  }
  return { db: db as never, discs, opps }
}

const input = (over: Partial<DeriveInput> = {}): DeriveInput => ({
  tenantId: 't1',
  sellerAccountId: 's1',
  planId: 'p1',
  shipmentRowId: 'row1',
  shipmentId: 'FBA1',
  closed: true,
  closedAt: ago(60),
  now,
  rows: [
    { sku: 'A', shipped: 10, received: 7 },
    { sku: 'B', shipped: 5, received: 6 },
    { sku: 'C', shipped: 4, received: 4 },
  ],
  ...over,
})

describe('planDiscrepancies', () => {
  it('没关闭不判差异', () => {
    expect(planDiscrepancies([], input().rows, false)).toEqual({ upserts: [], resolve: [] })
  })
  it('关闭后：应发大于已收是少收，小于是多收，相等或缺数据不算', () => {
    const plan = planDiscrepancies([], [...input().rows, { sku: 'D', shipped: null, received: 3 }], true)
    expect(plan.upserts).toEqual([
      { sku: 'A', kind: 'SHORT', qty: 3 },
      { sku: 'B', kind: 'OVER', qty: 1 },
    ])
  })
  it('差异消失的未消除行进入 resolve，已消除的不再动', () => {
    const existing = [
      { id: 'x1', sku: 'A', kind: 'SHORT', resolvedAt: null },
      { id: 'x2', sku: 'Z', kind: 'SHORT', resolvedAt: null },
      { id: 'x3', sku: 'Y', kind: 'SHORT', resolvedAt: ago(1) },
    ]
    expect(planDiscrepancies(existing, input().rows, true).resolve).toEqual(['x2'])
  })
})

describe('deriveReceiving', () => {
  it('没关闭什么都不写', async () => {
    const { db, discs } = fakeDb()
    expect(await deriveReceiving(db, input({ closed: false }))).toEqual({ discrepancies: 0, opportunities: 0 })
    expect(discs).toHaveLength(0)
  })

  it('关闭满等待期：写差异，少收产出待处理机会，估算 = 数量 × 商品成本，截止日按申请期限', async () => {
    const { db, discs, opps } = fakeDb({ A: 12.5 })
    await deriveReceiving(db, input())
    expect(discs.map(row => `${row.sku}:${row.kind}:${row.qty}`)).toEqual(['A:SHORT:3', 'B:OVER:1'])
    expect(opps).toHaveLength(1)
    expect(opps[0]).toMatchObject({ dedupKey: 'FBA1:A', status: 'PENDING', estimatedAmount: 37.5, currency: 'CNY' })
    expect(opps[0].deadlineAt.toISOString().slice(0, 10)).toBe(new Date(ago(60).getTime() + 540 * DAY).toISOString().slice(0, 10))
  })

  it('没有商品成本：估算金额为空，不当 0', async () => {
    const { db, opps } = fakeDb()
    await deriveReceiving(db, input())
    expect(opps[0].estimatedAmount).toBeNull()
    expect(opps[0].currency).toBeNull()
  })

  it('还在等待期内只记差异，不产出机会', async () => {
    const { db, discs, opps } = fakeDb()
    await deriveReceiving(db, input({ closedAt: ago(10) }))
    expect(discs).toHaveLength(2)
    expect(opps).toHaveLength(0)
  })

  it('过了申请期限且从没产出过：不补产出；已有待处理的转为已过期', async () => {
    const first = fakeDb()
    await deriveReceiving(first.db, input({ closedAt: ago(600) }))
    expect(first.opps).toHaveLength(0)
    const second = fakeDb({}, [], [{ dedupKey: 'FBA1:A', status: 'PENDING', estimatedAmount: null, currency: null, deadlineAt: ago(1) }])
    await deriveReceiving(second.db, input({ closedAt: ago(600) }))
    expect(second.opps[0].status).toBe('EXPIRED')
  })

  it('人工处理过的机会（已建案等）不被覆盖', async () => {
    const { db, opps } = fakeDb({}, [], [{ dedupKey: 'FBA1:A', status: 'CASE_CREATED', estimatedAmount: 1, currency: 'USD', deadlineAt: ago(-5) }])
    await deriveReceiving(db, input())
    expect(opps[0]).toMatchObject({ status: 'CASE_CREATED', estimatedAmount: 1 })
  })

  it('少收后来补齐：差异标记已消除，待处理的机会转为差异已消除', async () => {
    const { db, discs, opps } = fakeDb()
    await deriveReceiving(db, input())
    await deriveReceiving(
      db,
      input({
        rows: [
          { sku: 'A', shipped: 10, received: 10 },
          { sku: 'B', shipped: 5, received: 6 },
        ],
      }),
    )
    expect(discs.find(row => row.sku === 'A')?.resolvedAt).toEqual(now)
    expect(opps[0].status).toBe('RESOLVED')
  })
})
