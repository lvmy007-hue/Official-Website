import type { EligibleOrderRow, RatingsImportError } from '@nova/api-contracts'
import { EligibleQuerySchema } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import type { PrismaService } from '../../platform/prisma.service'
import { emptyFeedbackState } from './reviews-feedback'
import { deliveredOrders } from './reviews-delivery'
import { ReviewsEligibleService } from './reviews-eligible.service'
import { loadImprovements } from './reviews-improvements'
import { importErrorLines } from './reviews-import.service'

// 评价与反馈的小服务与纯函数（P4-13）：导入错误行、客户反馈空状态、可请求订单的扫描与排序、改进清单的拼装。
// 权限、参数与路由见 reviews.http.test.ts；真实数据库里的行为见 testing/reviews.db.test.ts。

process.env.CURSOR_SIGNING_KEY ??= 'unit-test-cursor-signing-key-0123456789'

const NOW = new Date('2026-10-24T08:00:00.000Z')
const day = (offset: number, hour = 0) => new Date(NOW.getTime() - offset * 86_400_000 + hour * 3_600_000)
const STORES = [
  { id: 's1', name: '店铺一' },
  { id: 's2', name: '店铺二' },
]

describe('导入错误行', () => {
  const error = (line: number): RatingsImportError => ({ line, column: '平均星级', code: 'FILE_VALUE_RANGE', message: '平均星级要在 1 到 5 之间' })

  it('逐行列出前 50 条，其余只给条数', () => {
    const lines = importErrorLines(Array.from({ length: 53 }, (_, index) => error(index + 2)))
    expect(lines).toHaveLength(51)
    expect(lines[0]).toBe('第 2 行（平均星级）：平均星级要在 1 到 5 之间')
    expect(lines[50]).toContain('还有 3 条错误')
  })

  it('不足 50 条时不加汇总行，列名为空时不写括号', () => {
    expect(importErrorLines([{ line: 1, column: '', code: 'FILE_COLUMN_MISSING', message: '文件是空的' }])).toEqual(['第 1 行：文件是空的'])
  })
})

describe('客户反馈空状态', () => {
  it('没有店铺是“尚未接入”；有店铺但没同步过也是“尚未接入”', () => {
    expect(emptyFeedbackState([], new Set()).state).toBe('NOT_CONNECTED')
    expect(emptyFeedbackState(['s1', 's2'], new Set()).state).toBe('NOT_CONNECTED')
  })

  it('所有店铺都没有品牌分析权限才是“不适用”；只要有一个店铺在等同步就不是', () => {
    expect(emptyFeedbackState(['s1', 's2'], new Set(['s1', 's2'])).state).toBe('NOT_APPLICABLE')
    expect(emptyFeedbackState(['s1', 's2'], new Set(['s1'])).state).toBe('NOT_CONNECTED')
  })

  it('指定了店铺就只看这个店铺', () => {
    expect(emptyFeedbackState(['s1', 's2'], new Set(['s1']), 's1')).toMatchObject({ state: 'NOT_APPLICABLE' })
    expect(emptyFeedbackState(['s1', 's2'], new Set(['s1']), 's2').state).toBe('NOT_CONNECTED')
  })
})

describe('已送达订单读取', () => {
  it('分组条件带企业、店铺、下单日期的上下界，并只保留“全部包裹都有送达时间”的订单', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { sellerAccountId: 's1', orderId: 'o1', orderPurchaseDate: day(12), _count: { _all: 2, deliveredAt: 2 }, _max: { deliveredAt: day(10) } },
      { sellerAccountId: 's1', orderId: 'o2', orderPurchaseDate: day(13), _count: { _all: 2, deliveredAt: 1 }, _max: { deliveredAt: day(10) } },
    ])
    const prisma = { orderPackage: { groupBy } } as unknown as PrismaService
    const result = await deliveredOrders(prisma, 't1', ['s1'], { from: day(31), to: day(5) }, 5000)
    expect(result.rows.map(row => row.orderId)).toEqual(['o1'])
    expect(result.truncated).toBe(false)
    const args = groupBy.mock.calls[0][0]
    expect(args.where.tenantId).toBe('t1')
    expect(args.where.sellerAccountId).toEqual({ in: ['s1'] })
    expect(args.where.orderPurchaseDate.gte.getTime()).toBe(day(31).getTime() - 120 * 86_400_000)
    expect(args.where.orderPurchaseDate.lte.getTime()).toBe(day(5).getTime())
    expect(args.take).toBe(5001)
  })

  it('超过扫描上限标 truncated，只处理上限内的订单', async () => {
    const groups = Array.from({ length: 4 }, (_, index) => ({
      sellerAccountId: 's1',
      orderId: `o${index}`,
      orderPurchaseDate: day(12),
      _count: { _all: 1, deliveredAt: 1 },
      _max: { deliveredAt: day(10) },
    }))
    const prisma = { orderPackage: { groupBy: vi.fn().mockResolvedValue(groups) } } as unknown as PrismaService
    const result = await deliveredOrders(prisma, 't1', ['s1'], { from: day(31), to: day(5) }, 3)
    expect(result.truncated).toBe(true)
    expect(result.rows).toHaveLength(3)
  })

  it('没有店铺不查数据库', async () => {
    const groupBy = vi.fn()
    expect((await deliveredOrders({ orderPackage: { groupBy } } as unknown as PrismaService, 't1', [], { from: day(31), to: day(5) }, 10)).rows).toEqual([])
    expect(groupBy).not.toHaveBeenCalled()
  })
})

const orderRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  sellerAccountId: 's1',
  amazonOrderId: `111-${id}`,
  purchaseDate: day(14),
  status: 'Shipped',
  fulfillmentStatus: 'SHIPPED',
  ...extra,
})
const group = (orderId: string, deliveredDaysAgo: number, storeId = 's1') => ({
  sellerAccountId: storeId,
  orderId,
  orderPurchaseDate: day(14),
  _count: { _all: 1, deliveredAt: 1 },
  _max: { deliveredAt: day(deliveredDaysAgo) },
})

function eligibleService(input: { groups: unknown[]; orders: unknown[]; items?: unknown[]; requests?: unknown[] }) {
  const prisma = {
    orderPackage: { groupBy: vi.fn().mockResolvedValue(input.groups) },
    order: { findMany: vi.fn().mockResolvedValue(input.orders) },
    orderItem: { findMany: vi.fn().mockResolvedValue(input.items ?? []) },
    solicitationRequest: { findMany: vi.fn().mockResolvedValue(input.requests ?? []) },
  }
  return { prisma, service: new ReviewsEligibleService(prisma as unknown as PrismaService, {} as never) }
}

describe('可请求订单扫描', () => {
  it('取消的订单、已请求的订单被排除；失败的订单保留并标 FAILED；ASIN 去重排序', async () => {
    const { service, prisma } = eligibleService({
      groups: [group('o1', 10), group('o2', 10), group('o3', 10), group('o4', 10)],
      orders: [orderRow('o1'), orderRow('o2', { status: 'Canceled' }), orderRow('o3'), orderRow('o4')],
      items: [
        { sellerAccountId: 's1', orderId: 'o1', asin: 'B0AAAAAAA2' },
        { sellerAccountId: 's1', orderId: 'o1', asin: 'B0AAAAAAA1' },
        { sellerAccountId: 's1', orderId: 'o1', asin: 'B0AAAAAAA2' },
      ],
      requests: [
        { sellerAccountId: 's1', amazonOrderId: '111-o3', status: 'REQUESTED' },
        { sellerAccountId: 's1', amazonOrderId: '111-o4', status: 'FAILED' },
      ],
    })
    const scan = await service.scan('t1', STORES, NOW)
    expect(scan.rows.map(row => [row.amazonOrderId, row.lastStatus])).toEqual([
      ['111-o1', null],
      ['111-o4', 'FAILED'],
    ])
    expect(scan.rows[0]).toMatchObject({ storeName: '店铺一', asins: ['B0AAAAAAA1', 'B0AAAAAAA2'], dayAfterDelivery: 10, daysLeft: 20 })
    // 买家信息列一律不读：订单与订单行都是显式的 select，没有任何个人信息列
    const selected = JSON.stringify([prisma.order.findMany.mock.calls[0][0].select, prisma.orderItem.findMany.mock.calls[0][0].select])
    expect(selected).not.toMatch(/pii|buyer|shipping|address|email|name/i)
    expect(prisma.order.findMany.mock.calls[0][0].select).toBeDefined()
  })

  it('送达窗口边界：第 5 天与第 30 天可请求，第 4 天与第 31 天不可请求（扫描只看窗口内，窗口外即使被读到也被排除）', async () => {
    const { service } = eligibleService({
      groups: [group('o5', 5), group('o30', 30), group('o4', 4), group('o31', 31)],
      orders: [orderRow('o5'), orderRow('o30'), orderRow('o4'), orderRow('o31')],
    })
    const rows = (await service.scan('t1', STORES, NOW)).rows
    expect(rows.map(row => [row.amazonOrderId, row.dayAfterDelivery, row.daysLeft]).sort()).toEqual([
      ['111-o30', 30, 0],
      ['111-o5', 5, 25],
    ])
  })

  it('没有已送达的订单不再读订单与请求记录', async () => {
    const { service, prisma } = eligibleService({ groups: [], orders: [] })
    expect((await service.scan('t1', STORES, NOW)).rows).toEqual([])
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })
})

describe('可请求订单排序与分页', () => {
  const rows = (): EligibleOrderRow[] =>
    ['b', 'a', 'c'].map((suffix, index) => ({
      storeId: 's1',
      storeName: '店铺一',
      amazonOrderId: `111-${suffix}`,
      purchaseDate: day(20 - index).toISOString(),
      deliveredAt: day(10 + index).toISOString(),
      dayAfterDelivery: 10 + index,
      daysLeft: 20 - index,
      asins: [`B0ASIN000${index}`],
      lastStatus: null,
    }))
  const query = (extra: Record<string, string> = {}) => EligibleQuerySchema.parse(extra)
  const service = new ReviewsEligibleService({} as PrismaService, {} as never)

  it('默认按送达时间从早到晚（最先到期的在前）；倒序与按下单时间可选', () => {
    expect(service.pageOfRows('t1', rows(), query()).items.map(row => row.amazonOrderId)).toEqual(['111-c', '111-a', '111-b'])
    expect(service.pageOfRows('t1', rows(), query({ sort: 'deliveredAt:desc' })).items.map(row => row.amazonOrderId)).toEqual(['111-b', '111-a', '111-c'])
    expect(service.pageOfRows('t1', rows(), query({ sort: 'purchaseDate:asc' })).items.map(row => row.amazonOrderId)).toEqual(['111-b', '111-a', '111-c'])
  })

  it('搜索订单号或 ASIN；翻页游标与条件绑定', () => {
    expect(service.pageOfRows('t1', rows(), query({ q: 'b0asin0001' })).items.map(row => row.amazonOrderId)).toEqual(['111-a'])
    const first = service.pageOfRows('t1', rows(), query({ pageSize: '2' }))
    expect(first.items).toHaveLength(2)
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 3 })
    const second = service.pageOfRows('t1', rows(), query({ pageSize: '2', cursor: first.pageInfo.nextCursor as string }))
    expect(second.items.map(row => row.amazonOrderId)).toEqual(['111-b'])
    expect(() => service.pageOfRows('t1', rows(), query({ pageSize: '2', sort: 'deliveredAt:desc', cursor: first.pageInfo.nextCursor as string }))).toThrow()
  })
})

describe('改进清单拼装', () => {
  const stores = [{ id: 's1', name: '店铺一' }]
  const returnRow = (asin: string, reason: string | null, quantity: number) => ({ sellerAccountId: 's1', asin, reason, _sum: { quantity } })
  const topicRow = (asin: string, topic: string, rank: number, date = '2026-10-18') => ({
    sellerAccountId: 's1',
    asin,
    topicKey: topic,
    mentionRange: '10-50',
    rank,
    snapshotDate: new Date(`${date}T00:00:00.000Z`),
  })

  function prismaFor(input: { returns: unknown[]; latest: unknown[]; topics: unknown[] }) {
    return {
      fbaReturnCase: { groupBy: vi.fn().mockResolvedValue(input.returns) },
      reviewTopic: { groupBy: vi.fn().mockResolvedValue(input.latest), findMany: vi.fn().mockResolvedValue(input.topics) },
      fbaProduct: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', asin: 'B0AAAAAAA1', title: '行李箱' }]) },
    } as unknown as PrismaService
  }
  const latest = (asin: string) => ({ sellerAccountId: 's1', asin, _max: { snapshotDate: new Date('2026-10-18T00:00:00.000Z') } })

  it('只列有退货且有最新负面主题的商品，按退货件数降序；文字有重合才标可能相关', async () => {
    const prisma = prismaFor({
      returns: [returnRow('B0AAAAAAA1', 'DEFECTIVE', 5), returnRow('B0AAAAAAA1', null, 2), returnRow('B0AAAAAAA2', 'SWITCHEROO', 9), returnRow('B0AAAAAAA3', 'DEFECTIVE', 20)],
      latest: [latest('B0AAAAAAA1'), latest('B0AAAAAAA2')],
      topics: [topicRow('B0AAAAAAA1', 'zipper defective', 1), topicRow('B0AAAAAAA1', 'size', 2), topicRow('B0AAAAAAA2', 'color', 1)],
    })
    const result = await loadImprovements(prisma, 't1', stores, NOW)
    expect(result.state).toBe('OK')
    // B0AAAAAAA3 退货最多但没有评论主题，不列出；B0AAAAAAA2（9 件）排在 B0AAAAAAA1（7 件）前面
    expect(result.rows.map(row => [row.asin, row.returnUnits, row.possiblyRelated])).toEqual([
      ['B0AAAAAAA2', 9, false],
      ['B0AAAAAAA1', 7, true],
    ])
    expect(result.rows[1]).toMatchObject({ title: '行李箱', storeName: '店铺一', snapshotDate: '2026-10-18' })
    expect(result.rows[1].returnReasons.map(item => [item.code, item.units])).toEqual([
      ['DEFECTIVE', 5],
      ['UNSPECIFIED', 2],
    ])
    expect(result.rows[1].returnReasons[0].share).toBeCloseTo(5 / 7, 4)
    expect(result.rows[1].negativeTopics.map(item => item.topic)).toEqual(['zipper defective', 'size'])
    expect(result.days).toBe(90)
  })

  it('退货记录按近 90 天、范围内店铺读取；没有任何退货的商品不列出，空时是“尚无记录”而不是 0 行的成功', async () => {
    const prisma = prismaFor({ returns: [], latest: [], topics: [] })
    const result = await loadImprovements(prisma, 't1', stores, NOW)
    expect(result).toMatchObject({ state: 'NO_DATA', rows: [] })
    const where = (prisma.fbaReturnCase.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0].where
    expect(where.sellerAccountId).toEqual({ in: ['s1'] })
    expect(where.returnDate.gte.getTime()).toBe(NOW.getTime() - 90 * 86_400_000)
  })

  it('只取每个商品最近一次快照里的负面主题（较早快照的主题不混入）', async () => {
    const prisma = prismaFor({
      returns: [returnRow('B0AAAAAAA1', 'DEFECTIVE', 3)],
      latest: [latest('B0AAAAAAA1')],
      topics: [topicRow('B0AAAAAAA1', 'new topic', 1), topicRow('B0AAAAAAA1', 'old topic', 1, '2026-10-04')],
    })
    const result = await loadImprovements(prisma, 't1', stores, NOW)
    expect(result.rows[0].negativeTopics.map(item => item.topic)).toEqual(['new topic'])
  })
})
