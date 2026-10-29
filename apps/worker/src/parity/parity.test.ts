import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { OrderDigest } from '../importers/orders/v2026-types'
import { compareFinance, type FinanceEntry } from './compare-finance'
import { compareOrders, type LegacyOrder } from './compare-orders'
import { runFinanceParity, runOrdersParity } from './run'
import { MAX_STORED_DIFFS, PARITY_INTERVAL_MS, saveParityRun, shouldRunParity } from './store'
import { countByCategory, zeroUnexplained } from './types'

// 新旧接口并行双跑核对：差异分类、核对记录、旧通道关闭规则。

const window = { start: new Date('2026-09-13T00:00:00Z'), end: new Date('2026-09-20T00:00:00Z') }
const at = (iso: string) => new Date(iso)

const legacyOrder = (id: string, over: Partial<LegacyOrder> = {}): LegacyOrder => ({
  amazonOrderId: id,
  purchaseDate: at('2026-09-15T10:00:00Z'),
  lastUpdate: at('2026-09-15T12:00:00Z'),
  status: 'Shipped',
  amount: 29.16,
  ...over,
})
const newOrder = (id: string, over: Partial<OrderDigest> = {}): OrderDigest => ({
  amazonOrderId: id,
  purchaseDate: at('2026-09-15T10:00:00Z'),
  lastUpdated: at('2026-09-15T12:00:00Z'),
  status: 'Shipped',
  amount: 29.16,
  currency: 'USD',
  taxAmount: 2.16,
  ...over,
})
const only = <T>(list: T[]): T => {
  expect(list).toHaveLength(1)
  return list[0]
}

describe('订单核对：差异分类', () => {
  it('两边一致：没有差异，计入匹配', () => {
    const report = compareOrders({ legacy: [legacyOrder('a')], next: [newOrder('a')], window })
    expect(report).toMatchObject({ legacyCount: 1, newCount: 1, matchedCount: 1, diffs: [] })
    expect(zeroUnexplained(report)).toBe(true)
  })

  it('只有一边有：落在窗口边界归时间口径；归发票待确认状态的归范围；其余是未解释', () => {
    const edge = compareOrders({ legacy: [legacyOrder('a', { purchaseDate: at('2026-09-19T23:58:00Z') })], next: [], window })
    expect(only(edge.diffs)).toMatchObject({ category: 'TIME_BASIS', field: 'presence', legacyValue: '有', newValue: '无' })
    const scope = compareOrders({ legacy: [], next: [newOrder('b', { status: 'InvoiceUnconfirmed' })], window })
    expect(only(scope.diffs)).toMatchObject({ category: 'SCOPE', newValue: '有' })
    const unexplained = compareOrders({ legacy: [legacyOrder('c')], next: [newOrder('d')], window })
    expect(unexplained.diffs.map(diff => [diff.entityKey, diff.category])).toEqual([
      ['c', 'UNEXPLAINED'],
      ['d', 'UNEXPLAINED'],
    ])
    expect(zeroUnexplained(unexplained)).toBe(false)
  })

  it('状态不同：新接口更新时间更晚归时间口径，否则未解释', () => {
    const later = compareOrders({ legacy: [legacyOrder('a', { status: 'Unshipped' })], next: [newOrder('a', { lastUpdated: at('2026-09-16T00:00:00Z') })], window })
    expect(only(later.diffs)).toMatchObject({ category: 'TIME_BASIS', field: 'status', legacyValue: 'Unshipped', newValue: 'Shipped' })
    const same = compareOrders({ legacy: [legacyOrder('a', { status: 'Unshipped' })], next: [newOrder('a')], window })
    expect(only(same.diffs).category).toBe('UNEXPLAINED')
  })

  it('金额不同：差额正好等于税额归归因口径；更新更晚归时间口径；待付款订单旧接口无金额归范围；其余未解释', () => {
    const tax = compareOrders({ legacy: [legacyOrder('a', { amount: 27 })], next: [newOrder('a', { amount: 29.16, taxAmount: 2.16 })], window })
    expect(only(tax.diffs)).toMatchObject({ category: 'ATTRIBUTION_BASIS', field: 'amount', legacyValue: '27.00', newValue: '29.16' })
    const later = compareOrders({ legacy: [legacyOrder('a', { amount: 20 })], next: [newOrder('a', { amount: 25, taxAmount: 0, lastUpdated: at('2026-09-16T00:00:00Z') })], window })
    expect(only(later.diffs).category).toBe('TIME_BASIS')
    const pending = compareOrders({ legacy: [legacyOrder('a', { status: 'Pending', amount: undefined })], next: [newOrder('a', { status: 'Pending' })], window })
    expect(only(pending.diffs)).toMatchObject({ category: 'SCOPE', legacyValue: '无' })
    const unexplained = compareOrders({ legacy: [legacyOrder('a', { amount: 20 })], next: [newOrder('a', { amount: 25, taxAmount: 0 })], window })
    expect(only(unexplained.diffs).category).toBe('UNEXPLAINED')
  })

  it('每条差异都带中文原因，且都落在四类之内', () => {
    const report = compareOrders({
      legacy: [legacyOrder('a', { amount: 20 }), legacyOrder('b', { status: 'Unshipped' }), legacyOrder('c')],
      next: [newOrder('a', { amount: 25, taxAmount: 0 }), newOrder('b'), newOrder('d', { status: 'InvoiceUnconfirmed' })],
      window,
    })
    expect(report.diffs.length).toBeGreaterThanOrEqual(4)
    for (const diff of report.diffs) {
      expect(['TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED']).toContain(diff.category)
      expect(diff.explanation).toMatch(/[\u4e00-\u9fa5]/)
    }
  })
})

describe('财务核对：差异分类', () => {
  const fetchedAt = at('2026-09-20T12:00:00Z')
  const entry = (orderId: string | undefined, amount: number, over: Partial<FinanceEntry> = {}): FinanceEntry => ({
    amazonOrderId: orderId,
    amount,
    currency: 'USD',
    postedAt: at('2026-09-15T00:00:00Z'),
    ...over,
  })

  it('同一订单合计相同：匹配；没有订单号的交易不参与逐订单核对', () => {
    const report = compareFinance({ legacy: [entry('o1', 10), entry('o1', 5), entry(undefined, 99)], next: [entry('o1', 15), entry(undefined, 1)], window, fetchedAt })
    expect(report).toMatchObject({ legacyCount: 1, newCount: 1, matchedCount: 1, diffs: [] })
  })

  it('差额等于递延交易合计：范围；只有新接口有且全是递延：范围', () => {
    const gap = compareFinance({ legacy: [entry('o1', 10)], next: [entry('o1', 10), entry('o1', 5, { deferred: true })], window, fetchedAt })
    expect(only(gap.diffs)).toMatchObject({ category: 'SCOPE', field: 'amount', legacyValue: '10.00', newValue: '15.00' })
    const allDeferred = compareFinance({ legacy: [], next: [entry('o2', 7, { deferred: true })], window, fetchedAt })
    expect(only(allDeferred.diffs).category).toBe('SCOPE')
  })

  it('入账在最近 48 小时内或窗口边界：时间口径；其余未解释', () => {
    const recent = compareFinance({ legacy: [], next: [entry('o1', 7, { postedAt: at('2026-09-19T20:00:00Z') })], window: { ...window, end: at('2026-09-19T20:00:00Z') }, fetchedAt })
    expect(only(recent.diffs).category).toBe('TIME_BASIS')
    const edge = compareFinance({ legacy: [entry('o1', 7, { postedAt: at('2026-09-13T00:01:00Z') })], next: [], window, fetchedAt })
    expect(only(edge.diffs).category).toBe('TIME_BASIS')
    const unexplained = compareFinance({ legacy: [entry('o1', 10)], next: [entry('o1', 12)], window, fetchedAt })
    expect(only(unexplained.diffs)).toMatchObject({ category: 'UNEXPLAINED', explanation: expect.stringContaining('2.00') })
  })
})

type Call = { model: string; op: string; args: any }
function recorder(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const prisma: PrismaClient = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
        return new Proxy(
          {},
          {
            get(_inner, op: string) {
              return async (args: any) => {
                calls.push({ model, op, args })
                const key = `${model}.${op}`
                if (key in overrides) return typeof overrides[key] === 'function' ? (overrides[key] as (a: unknown) => unknown)(args) : overrides[key]
                if (op === 'create') return { id: `${model}-1`, ...(args?.data ?? {}) }
                return null
              }
            },
          },
        )
      },
    },
  ) as unknown as PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const of = (model: string, op: string) => calls.filter(call => call.model === model && call.op === op)
  return { prisma, logger, calls, of }
}

const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const NOW = at('2026-09-20T12:00:00Z')
const state = (over: Record<string, unknown> = {}) => ({ id: 'state-1', legacyEnabled: true, consecutivePasses: 0, requiredPasses: 7, lastRunAt: null, ...over })

describe('核对记录与旧通道关闭', () => {
  const input = (report: Parameters<typeof saveParityRun>[3]['report']) => ({ window, report, startedAt: NOW, now: NOW })

  it('核对间隔：每天一次；已关闭的店铺不再核对', () => {
    expect(shouldRunParity({ legacyEnabled: true, lastRunAt: null }, NOW)).toBe(true)
    expect(shouldRunParity({ legacyEnabled: true, lastRunAt: new Date(NOW.getTime() - PARITY_INTERVAL_MS + 60_000) }, NOW)).toBe(false)
    expect(shouldRunParity({ legacyEnabled: true, lastRunAt: new Date(NOW.getTime() - PARITY_INTERVAL_MS) }, NOW)).toBe(true)
    expect(shouldRunParity({ legacyEnabled: false, lastRunAt: null }, NOW)).toBe(false)
  })

  it('没有未解释差异：通过，连续通过次数加 1；差异按“未解释优先”保存', async () => {
    const { prisma, of } = recorder({ 'connectorChannelState.upsert': state({ consecutivePasses: 2 }) })
    const diffs = [
      { category: 'TIME_BASIS' as const, entityKey: 'a', field: 'presence', explanation: '时间' },
      { category: 'SCOPE' as const, entityKey: 'b', field: 'presence', explanation: '范围' },
    ]
    const saved = await saveParityRun(prisma, scope, 'ORDERS', input({ legacyCount: 5, newCount: 6, matchedCount: 4, diffs }))
    expect(saved).toMatchObject({ status: 'PASSED', closed: false, counts: { TIME_BASIS: 1, SCOPE: 1, ATTRIBUTION_BASIS: 0, UNEXPLAINED: 0 } })
    expect(of('connectorParityRun', 'create')[0].args.data).toMatchObject({ domain: 'ORDERS', status: 'PASSED', legacyCount: 5, newCount: 6, matchedCount: 4, unexplainedCount: 0 })
    expect(of('connectorParityDiff', 'createMany')[0].args.data.map((row: { category: string }) => row.category)).toEqual(['SCOPE', 'TIME_BASIS'])
    expect(of('connectorChannelState', 'update')[0].args.data).toMatchObject({ consecutivePasses: 3 })
  })

  it('有未解释差异：连续通过次数清零，旧通道保持开启', async () => {
    const { prisma, of } = recorder({ 'connectorChannelState.upsert': state({ consecutivePasses: 6 }) })
    const saved = await saveParityRun(
      prisma,
      scope,
      'FINANCE',
      input({ legacyCount: 1, newCount: 1, matchedCount: 0, diffs: [{ category: 'UNEXPLAINED', entityKey: 'a', field: 'amount', explanation: '说不通' }] }),
    )
    expect(saved).toMatchObject({ status: 'HAS_DIFFS', closed: false })
    const data = of('connectorChannelState', 'update')[0].args.data
    expect(data.consecutivePasses).toBe(0)
    expect(data.legacyEnabled).toBeUndefined()
  })

  it('连续通过达到要求次数：关闭旧通道并写明原因与时间', async () => {
    const { prisma, of } = recorder({ 'connectorChannelState.upsert': state({ consecutivePasses: 6 }) })
    const saved = await saveParityRun(prisma, scope, 'ORDERS', input({ legacyCount: 1, newCount: 1, matchedCount: 1, diffs: [] }))
    expect(saved).toMatchObject({ status: 'PASSED', closed: true })
    expect(of('connectorChannelState', 'update')[0].args.data).toMatchObject({ consecutivePasses: 7, legacyEnabled: false, closedAt: NOW, closedReason: expect.stringContaining('7') })
  })

  it('旧接口不可用：不算通过也不清零，状态记为旧接口不可用', async () => {
    const { prisma, of } = recorder({ 'connectorChannelState.upsert': state({ consecutivePasses: 3 }) })
    const saved = await saveParityRun(prisma, scope, 'ORDERS', input(null))
    expect(saved).toMatchObject({ status: 'LEGACY_UNAVAILABLE', closed: false })
    expect(of('connectorChannelState', 'update')[0].args.data.consecutivePasses).toBe(3)
    expect(of('connectorParityDiff', 'createMany')).toHaveLength(0)
  })

  it(`差异行最多保存 ${MAX_STORED_DIFFS} 条，超出部分仍计入各类计数`, async () => {
    const { prisma, of } = recorder({ 'connectorChannelState.upsert': state() })
    const diffs = Array.from({ length: MAX_STORED_DIFFS + 50 }, (_, index) => ({ category: 'TIME_BASIS' as const, entityKey: `o${index}`, field: 'presence', explanation: '时间' }))
    const saved = await saveParityRun(prisma, scope, 'ORDERS', input({ legacyCount: 0, newCount: 0, matchedCount: 0, diffs }))
    expect(of('connectorParityDiff', 'createMany')[0].args.data).toHaveLength(MAX_STORED_DIFFS)
    expect(saved.counts.TIME_BASIS).toBe(MAX_STORED_DIFFS + 50)
    expect(countByCategory(diffs).TIME_BASIS).toBe(MAX_STORED_DIFFS + 50)
  })
})

describe('核对运行器', () => {
  const rawOrder = (id: string) => ({
    orderId: id,
    createdTime: '2026-09-15T10:00:00Z',
    lastUpdatedTime: '2026-09-15T12:00:00Z',
    fulfillment: { fulfillmentStatus: 'SHIPPED' },
    proceeds: { grandTotal: { amount: '29.16', currencyCode: 'USD' } },
    orderItems: [],
  })
  const legacyPayload = (id: string) => ({
    payload: {
      Orders: [{ AmazonOrderId: id, PurchaseDate: '2026-09-15T10:00:00Z', LastUpdateDate: '2026-09-15T12:00:00Z', OrderStatus: 'Shipped', OrderTotal: { Amount: '29.16', CurrencyCode: 'USD' } }],
    },
  })

  it('订单：旧接口、新接口同一时间窗各拉一遍；新接口不取买家信息；落核对记录', async () => {
    const { prisma, logger, of } = recorder({ 'connectorChannelState.upsert': state() })
    const searchOrders = vi.fn().mockResolvedValue({ orders: [rawOrder('o1')] })
    const getOrders = vi.fn().mockResolvedValue(legacyPayload('o1'))
    const outcome = await runOrdersParity({ prisma, logger }, scope, { next: { searchOrders }, legacy: { getOrders }, marketplaceId: 'ATVPDKIKX0DER' }, { now: () => NOW })
    expect(outcome).toMatchObject({ ran: true, status: 'PASSED' })
    expect(searchOrders.mock.calls[0][0].includedData).not.toContain('BUYER')
    expect(searchOrders.mock.calls[0][0].includedData).not.toContain('RECIPIENT')
    expect(getOrders.mock.calls[0][2]).toMatchObject({ createdAfter: searchOrders.mock.calls[0][0].createdAfter, createdBefore: searchOrders.mock.calls[0][0].createdBefore })
    expect(of('connectorParityRun', 'create')[0].args.data).toMatchObject({ legacyCount: 1, newCount: 1, matchedCount: 1, status: 'PASSED' })
  })

  it('不到核对间隔或旧通道已关闭：不调用任何接口', async () => {
    const { prisma, logger } = recorder({ 'connectorChannelState.upsert': state({ lastRunAt: new Date(NOW.getTime() - 3_600_000) }) })
    const searchOrders = vi.fn()
    const getOrders = vi.fn()
    const outcome = await runOrdersParity({ prisma, logger }, scope, { next: { searchOrders }, legacy: { getOrders }, marketplaceId: 'ATVPDKIKX0DER' }, { now: () => NOW })
    expect(outcome).toEqual({ ran: false })
    expect(searchOrders).not.toHaveBeenCalled()
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('旧接口调用失败：记为旧接口不可用，不调用新接口，也不抛错', async () => {
    const { prisma, logger } = recorder({ 'connectorChannelState.upsert': state() })
    const searchOrders = vi.fn()
    const getOrders = vi.fn().mockRejectedValue(Object.assign(new Error('SP_API_410'), { status: 410 }))
    const outcome = await runOrdersParity({ prisma, logger }, scope, { next: { searchOrders }, legacy: { getOrders }, marketplaceId: 'ATVPDKIKX0DER' }, { now: () => NOW })
    expect(outcome).toMatchObject({ ran: true, status: 'LEGACY_UNAVAILABLE' })
    expect(searchOrders).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('新接口失败时错误抛出（新通道本身异常，不能被当成核对通过）', async () => {
    const { prisma, logger } = recorder({ 'connectorChannelState.upsert': state() })
    const searchOrders = vi.fn().mockRejectedValue(new Error('SP_API_500'))
    const getOrders = vi.fn().mockResolvedValue(legacyPayload('o1'))
    await expect(runOrdersParity({ prisma, logger }, scope, { next: { searchOrders }, legacy: { getOrders }, marketplaceId: 'ATVPDKIKX0DER' }, { now: () => NOW })).rejects.toThrow('SP_API_500')
  })

  it('财务：旧接口事件按订单汇总，与新接口交易逐单比对', async () => {
    const { prisma, logger, of } = recorder({ 'connectorChannelState.upsert': state() })
    const listTransactions = vi.fn().mockResolvedValue({
      payload: {
        transactions: [
          {
            transactionId: 'x1',
            transactionType: 'Shipment',
            postedDate: '2026-09-15T00:00:00Z',
            totalAmount: { currencyAmount: 10, currencyCode: 'USD' },
            relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'o1' }],
          },
        ],
      },
    })
    const getFinancialEvents = vi.fn().mockResolvedValue({
      payload: {
        FinancialEvents: {
          ShipmentEventList: [
            {
              AmazonOrderId: 'o1',
              PostedDate: '2026-09-15T00:00:00Z',
              ShipmentItemList: [{ ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyCode: 'USD', CurrencyAmount: 10 } }] }],
            },
          ],
        },
      },
    })
    const outcome = await runFinanceParity({ prisma, logger }, scope, { next: { listTransactions }, legacy: { getFinancialEvents } }, { now: () => NOW })
    expect(outcome).toMatchObject({ ran: true, status: 'PASSED' })
    expect(of('connectorParityRun', 'create')[0].args.data).toMatchObject({ domain: 'FINANCE', legacyCount: 1, newCount: 1, matchedCount: 1 })
  })
})
