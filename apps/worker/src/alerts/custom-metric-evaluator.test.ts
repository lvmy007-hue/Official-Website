import type { RuleMetricReader, StoreDayRow } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { evaluateCustomMetric } from './custom-metric-evaluator'

// 自定义指标规则评估器（P6-16）：按店铺判断、范围、店铺数上限、条件无效、取数超时。

const day = (date: string, sales: number): StoreDayRow => ({ date, orders: 1, units: 1, sales, adsSpend: null, adsSales: null, profit: null, sessions: null })
const NOW = new Date('2026-10-27T12:00:00Z')
const groups = { groups: [{ conditions: [{ metric: 'M-001', window: { kind: 'days' as const, days: 3 }, agg: 'sum' as const, op: '<' as const, threshold: 100 }] }] }

function fakeDb(stores: Array<{ id: string; displayName: string }>) {
  const calls: Array<Record<string, any>> = []
  const db = {
    sellerAccount: {
      findMany: async (args: Record<string, any>) => {
        calls.push(args)
        const wanted: string[] | undefined = args.where.id?.in
        return stores.filter(store => !wanted || wanted.includes(store.id)).slice(0, args.take)
      },
    },
    tenant: { findFirst: async () => ({ timezone: 'UTC' }) },
  } as unknown as PrismaClient
  return { db, calls }
}

const readerOf = (sales: Record<string, number>): RuleMetricReader => ({
  storeDays: async (_tenant, ids) => ids.flatMap(id => (id in sales ? ['2026-10-24', '2026-10-25', '2026-10-26'].map(date => ({ ...day(date, sales[id]!), storeId: id })) : [])),
  trafficDays: async () => [],
  inventoryDays: async () => [],
})

const rule = (over: Record<string, unknown> = {}) => ({ name: '销售额偏低', scope: {}, conditionGroups: groups, ...over })

describe('自定义指标评估器', () => {
  it('只有满足条件的店铺命中，证据里有条件文字与取值', async () => {
    const { db } = fakeDb([
      { id: 's1', displayName: '一店' },
      { id: 's2', displayName: '二店' },
      { id: 's3', displayName: '三店（没数据）' },
    ])
    const hits = await evaluateCustomMetric({ db, tenantId: 't', rule: rule(), now: NOW }, { reader: readerOf({ s1: 10, s2: 50 }) })
    expect(hits.map(hit => hit.entityId)).toEqual(['s1'])
    expect(hits[0]).toMatchObject({ entityType: 'STORE', sellerAccountId: 's1', entityLabel: '一店', title: '销售额偏低：一店' })
    expect(hits[0]?.evidence).toMatchObject({ asOf: '2026-10-27', matched: [expect.objectContaining({ metric: 'M-001', value: 30, threshold: 100, op: '<' })] })
    expect(String(hits[0]?.evidence.condition)).toContain('100')
  })

  it('范围：只判断规则范围里的店铺；店铺数最多 200', async () => {
    const stores = Array.from({ length: 250 }, (_, index) => ({ id: `s${String(index).padStart(3, '0')}`, displayName: `店${index}` }))
    const { db, calls } = fakeDb(stores)
    await evaluateCustomMetric({ db, tenantId: 't', rule: rule({ scope: { sellerAccountIds: ['s001'] } }), now: NOW }, { reader: readerOf({ s001: 1 }) })
    expect(calls[0]?.where.id).toEqual({ in: ['s001'] })
    await evaluateCustomMetric({ db, tenantId: 't', rule: rule(), now: NOW }, { reader: readerOf({}) })
    expect(calls[1]?.take).toBe(200)
  })

  it('没有条件、没有店铺：不命中；条件无效：抛错让评估框架计入规则错误', async () => {
    const { db } = fakeDb([{ id: 's1', displayName: '一店' }])
    expect(await evaluateCustomMetric({ db, tenantId: 't', rule: rule({ conditionGroups: null }), now: NOW }, { reader: readerOf({}) })).toEqual([])
    expect(await evaluateCustomMetric({ db: fakeDb([]).db, tenantId: 't', rule: rule(), now: NOW }, { reader: readerOf({}) })).toEqual([])
    await expect(
      evaluateCustomMetric(
        { db, tenantId: 't', rule: rule({ conditionGroups: { groups: [{ conditions: [{ metric: 'NOPE', window: { kind: 'yesterday' }, agg: 'sum', op: '<', threshold: 1 }] }] } }), now: NOW },
        { reader: readerOf({}) },
      ),
    ).rejects.toThrow('条件无效')
  })

  it('取数超时：放弃本轮（抛错），不当作没有命中', async () => {
    const { db } = fakeDb([{ id: 's1', displayName: '一店' }])
    const slow: RuleMetricReader = { ...readerOf({}), storeDays: () => new Promise(() => undefined) }
    await expect(evaluateCustomMetric({ db, tenantId: 't', rule: rule(), now: NOW }, { reader: slow, timeoutMs: 20 })).rejects.toThrow('超过 20 毫秒')
  })
})
