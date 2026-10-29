import { describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import type { ImportContext } from '../../types'
import type { Row } from '../../streaming/rows'
import { fakeContext } from '../inventory/fake-context.test-helper'
import { numberOf, parseSellerPerformance } from './seller-performance-parse'
import { sellerPerformanceImporter } from './seller-performance'

const US = 'ATVPDKIKX0DER'

// 与 SP-API 文档里卖家表现报告的形态一致的样例（真实字段未逐项核对，见 CR-092 未验证清单）
const REPORT = {
  accountStatuses: [
    { marketplaceId: 'A1F83G8C2ARO7P', status: 'AT_RISK' },
    { marketplaceId: US, status: 'GOOD' },
  ],
  accountHealthRating: { ahrScore: 312, ahrStatus: 'GOOD' },
  performanceMetrics: [
    {
      marketplaceId: US,
      orderDefectRate: {
        afn: { rate: 0.012, targetValue: 0.01, targetCondition: 'LESS_THAN', orderCount: 400, reportingPeriod: '60 days' },
        mfn: { rate: 0.004, targetValue: 0.01, targetCondition: 'LESS_THAN' },
      },
      lateShipmentRate: { rate: '2.5%' },
      listingPolicyViolations: [
        { id: 'V-100', title: 'Restricted products', affectedAsins: ['B000000001', 'b000000002', 'bad'], impact: '搜索结果被隐藏', date: '2026-10-20T00:00:00Z' },
        { title: 'Intellectual property complaint', asin: 'B000000003' },
      ],
    },
    { marketplaceId: 'A1F83G8C2ARO7P', orderDefectRate: { rate: 0.5 } },
  ],
}

async function* one(row: unknown): AsyncGenerator<Row> {
  yield row as Row
}

type Loose = ReturnType<typeof JSON.parse>

// 自带 $transaction 的最小库替身（importRows 在事务里逐批写）
function contextOf(db: Record<string, unknown>): ImportContext {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const prisma = { ...db, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) }
  return { prisma: prisma as unknown as ImportContext['prisma'], logger }
}

describe('卖家表现报告解析', () => {
  const parsed = parseSellerPerformance(REPORT, US)

  it('账户状态只取美国站；评级取分数与状态', () => {
    expect(parsed.status).toEqual({ status: 'NORMAL', raw: 'GOOD' })
    expect(parsed.rating).toEqual({ score: 312, status: 'GOOD' })
  })

  it('指标：配送方式折成后缀、目标与条件原样带上、百分号换成小数、其他站点的容器跳过', () => {
    const byKey = new Map(parsed.metrics.map(metric => [metric.metricKey, metric]))
    expect(byKey.get('orderDefectRate.afn')).toMatchObject({ value: 0.012, target: 0.01, targetCondition: 'LT', unit: 'RATIO', windowDays: 60 })
    expect(byKey.get('orderDefectRate.mfn')).toMatchObject({ value: 0.004, target: 0.01, targetCondition: 'LT' })
    expect(byKey.get('lateShipmentRate')).toMatchObject({ value: 0.025, target: null, targetCondition: null })
    expect(byKey.get('orderDefectRate.afn')?.detail).toMatchObject({ orderCount: 400 })
    expect([...byKey.keys()].some(key => key.includes('orderCount'))).toBe(false)
    expect(parsed.metrics.filter(metric => metric.value === 0.5)).toHaveLength(0)
  })

  it('政策问题：用报告给的编号；没有编号按内容生成稳定编号；ASIN 去重转大写并丢掉不合法的', () => {
    expect(parsed.hasIssueSection).toBe(true)
    const [first, second] = parsed.issues
    expect(first).toMatchObject({ issueId: 'V-100', kind: 'LISTING_POLICY', asins: ['B000000001', 'B000000002'], impactText: '搜索结果被隐藏' })
    expect(first?.firstSeenAt?.toISOString()).toBe('2026-10-20T00:00:00.000Z')
    expect(second?.issueId.startsWith('h:')).toBe(true)
    expect(second?.kind).toBe('LISTING_POLICY') // 先按条目所在数组的名字归类，其次才看标题
    expect(parseSellerPerformance(REPORT, US).issues[1]?.issueId).toBe(second?.issueId)
  })

  it('没有问题条目这一节时 hasIssueSection 为假；空数组算有这一节', () => {
    expect(parseSellerPerformance({ accountStatuses: [{ status: 'GOOD' }] }).hasIssueSection).toBe(false)
    expect(parseSellerPerformance({ accountStatuses: [{ status: 'GOOD' }], performanceMetrics: { listingPolicyViolations: [] } }).hasIssueSection).toBe(true)
  })

  it('一项都认不出，或者内容不是对象，就以 PARSE_HEADER 失败，不当成“一切正常”', () => {
    expect(() => parseSellerPerformance({ hello: 'world' }, US)).toThrow(/认出/)
    expect(() => parseSellerPerformance([1, 2], US)).toThrow(/JSON 对象/)
  })

  it('numberOf：千分位、百分号、非数字', () => {
    expect(numberOf('1,234')).toBe(1234)
    expect(numberOf('2.5 %')).toBeCloseTo(0.025)
    expect(numberOf('abc')).toBeNull()
    expect(numberOf(Number.NaN)).toBeNull()
  })
})

describe('卖家表现报告导入器', () => {
  const options = { reportJobId: 'rj1', snapshotDate: new Date('2026-10-22T00:00:00Z') }
  const scope = { tenantId: 't1', sellerAccountId: 'sa1', marketplaceId: US }

  it('写账户状态、评级、各项指标的快照（按指标判定达标）与政策问题；有问题条目这一节时把没再出现的未解决问题标记为已解决', async () => {
    const { ctx, calls, of } = fakeContext()
    const result = await sellerPerformanceImporter(scope, options)(ctx, one(REPORT))
    expect(result).toMatchObject({ read: 1, imported: 1 })
    const snapshots = of('accountHealthSnapshot').map(call => call.args.create)
    const byKey = new Map(snapshots.map(row => [row.metricKey, row]))
    expect(byKey.get('ACCOUNT_STATUS')).toMatchObject({ metricGroup: 'STATUS', accountStatus: 'NORMAL', sourceReportJobId: 'rj1' })
    expect(byKey.get('ACCOUNT_HEALTH_RATING')).toMatchObject({ metricGroup: 'RATING', value: 312 })
    expect(byKey.get('orderDefectRate.afn')).toMatchObject({ metricGroup: 'ORDER_DEFECT', status: 'NOT_MET', unit: 'RATIO', windowDays: 60 })
    expect(byKey.get('orderDefectRate.mfn')).toMatchObject({ status: 'MET' })
    expect(byKey.get('lateShipmentRate')).toMatchObject({ status: 'UNKNOWN' })
    expect(snapshots.every(row => row.snapshotDate.toISOString().slice(0, 10) === '2026-10-22')).toBe(true)
    const created = calls.filter(call => call.model === 'policyIssue' && call.op === 'create').map(call => call.args.data)
    expect(created.map(row => row.issueId)).toContain('V-100')
    expect(created.every(row => row.tenantId === 't1' && row.sellerAccountId === 'sa1')).toBe(true)
    const resolve = calls.find(call => call.model === 'policyIssue' && call.op === 'updateMany')
    expect(resolve?.args.where).toMatchObject({ status: 'OPEN' })
    expect(resolve?.args.data).toMatchObject({ status: 'RESOLVED' })
  })

  it('报告里没有问题条目这一节时，不解决任何已有问题', async () => {
    const { ctx, calls } = fakeContext()
    await sellerPerformanceImporter(scope, options)(ctx, one({ accountStatuses: [{ status: 'AT_RISK' }] }))
    expect(calls.some(call => call.model === 'policyIssue')).toBe(false)
  })

  it('同一天已有更新的快照（推送写入）时，更早生成的报告不覆盖', async () => {
    const upsert = vi.fn(async () => ({}))
    const db = { accountHealthSnapshot: { findUnique: async () => ({ sourceUpdatedAt: new Date(Date.now() + 3_600_000) }), upsert } }
    const result = await sellerPerformanceImporter(scope, options)(contextOf(db), one({ accountStatuses: [{ status: 'GOOD' }] }))
    expect(result.imported).toBe(0)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('已解决的问题再次出现：重开、回到待处理、版本加一；仍未解决的只刷新不动人工字段', async () => {
    const updates: Loose[] = []
    const existing = new Map([
      ['V-100', { id: 'i1', status: 'RESOLVED' }],
      ['h-other', { id: 'i2', status: 'OPEN' }],
    ])
    const db = {
      accountHealthSnapshot: { findUnique: async () => null, upsert: async () => ({}) },
      policyIssue: {
        findUnique: async (args: Loose) => existing.get(args.where.tenantId_sellerAccountId_issueId.issueId) ?? null,
        create: async () => ({}),
        update: async (args: Loose) => (updates.push(args), {}),
        updateMany: async () => ({ count: 0 }),
      },
    }
    await sellerPerformanceImporter(scope, options)(
      contextOf(db),
      one({
        performanceMetrics: {
          issues: [
            { id: 'V-100', title: 'a' },
            { id: 'h-other', title: 'b' },
          ],
        },
      }),
    )
    expect(updates).toHaveLength(2)
    expect(updates[0]?.data).toMatchObject({ status: 'OPEN', resolvedAt: null, handlingStatus: 'OPEN', version: { increment: 1 } })
    expect(updates[1]?.data.status).toBeUndefined()
    expect(updates[1]?.data.handlingStatus).toBeUndefined()
    expect(updates[1]?.data.version).toBeUndefined()
  })
})
