import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROMOTIONS_ROLE_MISSING } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { PromotionsApi } from '../../connectors/promotions-api'
import { readLines, tsvRows } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { issuesOfItem, parsePromotions, parseSelection } from './parse'
import { couponReportImporter, promotionReportImporter } from './reports'
import { syncPromotions } from './sync'

// 促销同步器与绩效报告导入器（I-17、R-40、R-41，P4-05）：官方格式样例（apps/worker/fixtures/promotions）→ 解析、写入、幂等、清单只在促销更新后重取、角色没批与各种上限。

const FIXTURES = join(__dirname, '../../../fixtures/promotions')
const json = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const NOW = new Date('2026-10-25T08:00:00Z')
const http = (status: number) => new UpstreamHttpError(`SP_API_${status}`, status, undefined, 'api')
const lastPage = () => ({ ...json('search.json'), pagination: undefined })
/** 第二份清单样例带“还有下一页”的标记；去掉它就是只有一页的清单。 */
const lastSelection = () => {
  const body = json('selection-2.json') as { selection: { selectionDetails: Record<string, unknown> } }
  return { selection: { ...body.selection, selectionDetails: { ...body.selection.selectionDetails, pagination: undefined } } }
}

type Row = Record<string, unknown> & { id: string }

/** 内存里的四张表：只实现导入器用到的几个方法。 */
function memory() {
  const promotions: Row[] = []
  const items: Array<Record<string, unknown>> = []
  const metrics: Array<Record<string, unknown>> = []
  const coupons: Array<Record<string, unknown>> = []
  const writes = { created: 0, updated: 0 }
  const promotion = {
    findMany: vi.fn(async (args: { where: { promotionId: { in: string[] } } }) => promotions.filter(row => args.where.promotionId.in.includes(row.promotionId as string))),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      writes.created += 1
      const row = { id: `row-${promotions.length + 1}`, itemCount: null, itemsForUpdatedAt: null, itemsTruncated: false, ...args.data } as Row
      promotions.push(row)
      return { id: row.id }
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      writes.updated += 1
      Object.assign(
        promotions.find(row => row.id === args.where.id)!,
        args.data,
      )
      return {}
    }),
  }
  const promotionItem = {
    deleteMany: vi.fn(async (args: { where: { promotionRowId: string } }) => {
      for (let index = items.length - 1; index >= 0; index -= 1) if (items[index].promotionRowId === args.where.promotionRowId) items.splice(index, 1)
      return {}
    }),
    createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      items.push(...args.data)
      return { count: args.data.length }
    }),
  }
  const upsert = (table: Array<Record<string, unknown>>, keys: string[]) =>
    vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const found = table.find(row => keys.every(key => row[key]?.toString() === args.create[key]?.toString()))
      if (found) Object.assign(found, args.update)
      else table.push(args.create)
      return {}
    })
  const warn = vi.fn()
  const prisma: Record<string, unknown> = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    promotion,
    promotionItem,
    promotionMetric: { upsert: upsert(metrics, ['mappingId', 'asin', 'metricDate']) },
    couponMetric: { upsert: upsert(coupons, ['mappingId', 'metricDate']) },
  }
  const ctx: ImportContext = { prisma: prisma as unknown as PrismaClient, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  return { ctx, promotions, items, metrics, coupons, writes, warn, promotionItem }
}

const apiOf = (search: () => Promise<unknown>, selection: (promotionId: string) => Promise<unknown>) =>
  ({ search: vi.fn(search), selection: vi.fn(selection) }) as unknown as PromotionsApi & { search: ReturnType<typeof vi.fn>; selection: ReturnType<typeof vi.fn> }
const defaultApi = () =>
  apiOf(
    async () => lastPage(),
    async (promotionId: string) => (promotionId === 'P-DEAL-1' ? json('selection-1.json') : lastSelection()),
  )

async function* chunked(content: string) {
  const bytes = Buffer.from(content)
  for (let offset = 0; offset < bytes.length; offset += 41) yield bytes.subarray(offset, offset + 41)
}
const rowsOfFile = (name: string) => tsvRows(readLines(chunked(readFileSync(join(FIXTURES, name), 'utf8'))))

describe('响应解析', () => {
  it('促销：必填缺失的行跳过计数；类型状态转大写；缺标题写默认；开始时间缺失时才用创建时间；问题分错误与警告计数', () => {
    const { promotions, skipped, nextToken } = parsePromotions(json('search.json'))
    expect(skipped).toBe(1)
    expect(nextToken).toBe('NEXT-PAGE-TOKEN')
    expect(promotions.map(item => item.promotionId)).toEqual(['P-DEAL-1', 'P-COUPON-1', 'P-CAT-1'])
    expect(promotions[0]).toMatchObject({
      type: 'DEAL',
      status: 'RUNNING',
      mappingId: 'TRK-DEAL-1',
      budget: { type: 'UNITS', value: 200, currency: null },
      selection: { type: 'ITEMS', id: 'sel-1', revision: 1 },
      errorCount: 0,
      warningCount: 1,
    })
    expect(promotions[0].startAt.toISOString()).toBe('2026-10-20T07:00:00.000Z')
    expect(promotions[1]).toMatchObject({ couponType: 'STANDARD', revisionStatus: 'FAILED', errorCount: 1, benefit: { perCustomerUses: 1 } })
    expect(promotions[2]).toMatchObject({ title: '（无标题）', selection: { type: 'CATALOG', id: null, revision: null }, mappingId: null })
    const noSchedule = parsePromotions({ promotions: [{ promotionId: 'X', promotionType: 'DEAL', status: 'running', createdDate: '2026-10-01T00:00:00Z', lastUpdatedDate: '2026-10-02T00:00:00Z' }] })
    expect(noSchedule.promotions[0]).toMatchObject({ status: 'RUNNING', endAt: null })
    expect(noSchedule.promotions[0].startAt.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('商品清单：ASIN 转大写；没有 ASIN 与 SKU 的行跳过；固定价、折扣、预算都取出；商品级问题按标识落到行', () => {
    const { items, issues, skipped, nextToken } = parseSelection(json('selection-1.json'))
    expect(skipped).toBe(1)
    expect(nextToken).toBeNull()
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      asin: 'B0TESTASIN1',
      sku: 'SKU-1',
      benefitType: 'DISCOUNTED_PRICE',
      discountType: 'PERCENTAGE_OFF',
      percentOff: 20,
      perCustomerUses: 1,
      budgetType: 'UNITS',
      budgetValue: 100,
    })
    expect(items[1]).toMatchObject({ asin: 'B0TESTASIN2', sku: '', benefitType: 'FIXED_PRICE', fixedPrice: 19.99, currency: 'USD' })
    expect(issuesOfItem(items[1], issues)).toEqual([{ code: 'LOW_STOCK', message: '库存偏低', severity: 'WARNING' }])
    expect(issuesOfItem(items[0], issues)).toEqual([])
    expect(parseSelection(json('selection-2.json')).nextToken).toBe('SEL-NEXT')
  })
})

describe('同步', () => {
  it('第一次：写入三个促销与两份商品清单；CATALOG 不取清单、商品数留空；清单对应的促销更新时间记下来', async () => {
    const db = memory()
    const api = defaultApi()
    const result = await syncPromotions(db.ctx, api, scope, { now: NOW })
    expect(result).toMatchObject({ promotions: 3, changed: 3, itemPromotions: 2, items: 3, skipped: 2, incomplete: false })
    expect(api.selection).toHaveBeenCalledTimes(2)
    const [deal, coupon, catalog] = db.promotions
    expect(deal).toMatchObject({ itemCount: 2, itemsForUpdatedAt: new Date('2026-10-19T09:00:00Z'), mappingId: 'TRK-DEAL-1', errorCount: 0, warningCount: 1, budgetValue: 200 })
    expect(coupon).toMatchObject({ itemCount: 1, status: 'UPCOMING', revisionStatus: 'FAILED' })
    expect(catalog).toMatchObject({ selectionType: 'CATALOG', itemCount: null, itemsForUpdatedAt: null })
    expect(db.items.filter(row => row.promotionRowId === deal.id).map(row => row.asin)).toEqual(['B0TESTASIN1', 'B0TESTASIN2'])
    expect(db.items.find(row => row.asin === 'B0TESTASIN2')?.issuesJson).toEqual([{ code: 'LOW_STOCK', message: '库存偏低', severity: 'WARNING' }])
  })

  it('第二次、亚马逊没有变化：不写促销、不再取清单（jsonb 键序不同也算没变）', async () => {
    const db = memory()
    const api = defaultApi()
    await syncPromotions(db.ctx, api, scope, { now: NOW })
    db.promotions[0].issuesJson = (db.promotions[0].issuesJson as Array<Record<string, unknown>>).map(item => Object.fromEntries(Object.entries(item).reverse()))
    api.selection.mockClear()
    const updatedBefore = db.writes.updated
    const again = await syncPromotions(db.ctx, api, scope, { now: NOW })
    expect(again).toMatchObject({ changed: 0, itemPromotions: 0, items: 0 })
    expect(api.selection).not.toHaveBeenCalled()
    expect(db.writes.updated).toBe(updatedBefore)
    expect(db.writes.created).toBe(3)
  })

  it('状态随时间变化而更新时间不变：状态照样更新，清单不重取', async () => {
    const db = memory()
    const api = defaultApi()
    await syncPromotions(db.ctx, api, scope, { now: NOW })
    const page = lastPage() as { promotions: Array<Record<string, unknown>> }
    page.promotions[0] = { ...page.promotions[0], status: 'EXPIRED' }
    api.search.mockResolvedValue(page)
    api.selection.mockClear()
    const again = await syncPromotions(db.ctx, api, scope, { now: NOW })
    expect(again).toMatchObject({ changed: 1, itemPromotions: 0 })
    expect(db.promotions[0].status).toBe('EXPIRED')
    expect(api.selection).not.toHaveBeenCalled()
  })

  it('促销有更新：先删后写重取清单，不留旧商品', async () => {
    const db = memory()
    const api = defaultApi()
    await syncPromotions(db.ctx, api, scope, { now: NOW })
    const page = lastPage() as { promotions: Array<Record<string, unknown>> }
    page.promotions[0] = { ...page.promotions[0], lastUpdatedDate: '2026-10-24T09:00:00Z' }
    api.search.mockResolvedValue(page)
    api.selection.mockImplementation(async () => json('selection-2.json'))
    const again = await syncPromotions(db.ctx, api, scope, { now: NOW, selectionPages: 1 })
    expect(again).toMatchObject({ changed: 1, itemPromotions: 1, items: 1 })
    expect(db.items.filter(row => row.promotionRowId === db.promotions[0].id).map(row => row.asin)).toEqual(['B0TESTASIN1'])
    expect(db.promotions[0]).toMatchObject({ itemCount: 1, itemsTruncated: true, itemsForUpdatedAt: new Date('2026-10-24T09:00:00Z') })
    expect(again.incomplete).toBe(true) // 清单页数触到上限
  })

  it('接口角色没批（403）：以不可重试的 ROLE_MISSING 结束，一行都不写', async () => {
    const db = memory()
    const api = apiOf(
      async () => {
        throw http(403)
      },
      async () => ({}),
    )
    await expect(syncPromotions(db.ctx, api, scope, { now: NOW })).rejects.toMatchObject({ code: PROMOTIONS_ROLE_MISSING })
    expect(db.promotions).toEqual([])
  })

  it('某个促销的清单取不到（404）：跳过并计数，促销保留且不记已取清单；其他错误原样抛出，不留半份清单', async () => {
    const db = memory()
    const api = apiOf(
      async () => lastPage(),
      async (promotionId: string) => {
        if (promotionId === 'P-DEAL-1') throw http(404)
        return json('selection-2.json')
      },
    )
    const result = await syncPromotions(db.ctx, api, scope, { now: NOW })
    expect(result).toMatchObject({ promotions: 3, itemPromotions: 1, skipped: 2 })
    expect(db.promotions[0].itemsForUpdatedAt).toBeNull()
    const broken = memory()
    const failing = apiOf(
      async () => lastPage(),
      async () => {
        throw http(500)
      },
    )
    await expect(syncPromotions(broken.ctx, failing, scope, { now: NOW })).rejects.toMatchObject({ status: 500 })
    expect(broken.items).toEqual([])
    expect(broken.promotionItem.deleteMany).not.toHaveBeenCalled()
  })

  it('每次最多重取指定个数的清单：进行中与即将开始的优先、开始时间新的先取，剩下的标 incomplete 留给下一次', async () => {
    const db = memory()
    const api = defaultApi()
    const result = await syncPromotions(db.ctx, api, scope, { now: NOW, selectionPromotions: 1 })
    expect(result).toMatchObject({ itemPromotions: 1, incomplete: true })
    expect(api.selection).toHaveBeenCalledWith('P-COUPON-1', 'sel-2', 2, undefined) // 两个都在“进行中/即将开始”，开始时间新的先取
    expect(db.warn).toHaveBeenCalled()
  })

  it('搜索翻页触到上限：标 incomplete，不无限翻页；同一个促销编号在两页里只算一个', async () => {
    const db = memory()
    const api = apiOf(
      async () => json('search.json'),
      async () => json('selection-2.json'),
    )
    const result = await syncPromotions(db.ctx, api, scope, { now: NOW, searchPages: 2 })
    expect(api.search).toHaveBeenCalledTimes(2)
    expect(result.incomplete).toBe(true)
    expect(result.promotions).toBe(3)
  })
})

describe('绩效报告导入', () => {
  it('促销绩效：按映射编号、ASIN、日写入；没给的列存空；没有编号、日期或指标的行跳过；重复导入覆盖', async () => {
    const db = memory()
    const result = await promotionReportImporter(scope, { reportJobId: 'rj1' })(db.ctx, rowsOfFile('promotion-report.tsv'))
    expect(result).toMatchObject({ read: 5, imported: 2, skipped: 3 })
    expect(db.metrics).toHaveLength(2)
    expect(db.metrics[0]).toMatchObject({ mappingId: 'TRK-DEAL-1', asin: 'B0TESTASIN1', units: 12, sales: 239.88, redemptions: 12, currency: 'USD', sourceReportJobId: 'rj1' })
    expect(db.metrics[1]).toMatchObject({ asin: 'B0TESTASIN2', units: 3, redemptions: null })
    await promotionReportImporter(scope)(db.ctx, rowsOfFile('promotion-report.tsv'))
    expect(db.metrics).toHaveLength(2)
  })

  it('优惠券绩效：按映射编号与日写入；整行都没有指标的跳过', async () => {
    const db = memory()
    const result = await couponReportImporter(scope)(db.ctx, rowsOfFile('coupon-report.tsv'))
    expect(result).toMatchObject({ read: 3, imported: 2, skipped: 1 })
    expect(db.coupons[0]).toMatchObject({ mappingId: 'TRK-COUPON-1', clips: 40, redemptions: 9, budgetSpent: 13.5, sales: 90 })
    expect(db.coupons[1]).toMatchObject({ clips: 25, redemptions: null, budgetSpent: null, sales: null })
  })

  it('关键列整体对不上：以 PARSE_HEADER 失败，不当作没有数据', async () => {
    const db = memory()
    const rows = tsvRows(readLines(chunked('foo\tbar\n1\t2\n')))
    await expect(promotionReportImporter(scope)(db.ctx, rows)).rejects.toMatchObject({ code: 'PARSE_HEADER' })
    await expect(couponReportImporter(scope)(db.ctx, tsvRows(readLines(chunked('foo\tbar\n1\t2\n'))))).rejects.toMatchObject({ code: 'PARSE_HEADER' })
  })
})
