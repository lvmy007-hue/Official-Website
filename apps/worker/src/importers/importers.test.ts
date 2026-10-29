import { Readable } from 'node:stream'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { AmazonAdsApiClient } from '../connectors/amazon-ads-api'
import type { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { readLines, tsvRows } from '../streaming/rows'
import type { ImportContext } from '../types'
import { syncAdsReport } from './ads/reports'
import { syncCatalogReport } from './catalog/report'
import { syncNoncomplianceReport, syncStorageFeeReport } from './finance/fee-reports'
import { syncSettlementReport } from './finance/settlement-report'
import { noncomplianceRowHandler } from './inbound/noncompliance-rows'
import { syncInventory } from './inventory/api'
import { syncOrdersReport } from './orders/report'
import { syncReturnsReport } from './returns/report'

// 导入器回归测试（P1-21、P1-22）：用官方格式的报告文本（以字节流形式喂给导入器）与接口响应，
// 经过真实导入器写入记录型的数据库替身，断言写入的表、幂等键与关键字段；确认拆分与流式化后的行为一致。

type Call = { model: string; op: string; args: any }

function fakeContext() {
  const calls: Call[] = []
  const prisma: PrismaClient = new Proxy(
    {},
    {
      get(_target, model: string) {
        // 分批写库使用交互式事务：替身里事务内外共用同一个记录器
        if (model === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
        return new Proxy(
          {},
          {
            get(_inner, op: string) {
              return async (args: any) => {
                calls.push({ model, op, args })
                if (op === 'upsert') return { id: `${model}-1`, ...(args?.create ?? {}) }
                return null
              }
            },
          },
        )
      },
    },
  ) as unknown as PrismaClient
  const warn = vi.fn()
  const logger = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger
  const ctx: ImportContext = { prisma, logger }
  const of = (model: string, op = 'upsert') => calls.filter(call => call.model === model && call.op === op)
  return { ctx, calls, of, warn }
}

const tsv = (...rows: string[][]) => rows.map(row => row.join('\t')).join('\n')
// 把报告文本变成与线上一致的行流：字节流 → 逐行 → 表头对应的记录（故意切成小段，覆盖分段边界）
async function* chunked(content: string) {
  const bytes = Buffer.from(content)
  for (let offset = 0; offset < bytes.length; offset += 37) yield bytes.subarray(offset, offset + 37)
}
const rowsOf = (content: string) => tsvRows(readLines(chunked(content)))

describe('订单报告导入', () => {
  const header = ['amazon-order-id', 'purchase-date', 'order-status', 'sku', 'asin', 'quantity', 'item-price', 'currency']

  it('写入订单与订单行；缺少购买日期的行被跳过并告警，不以当前时间兜底', async () => {
    const { ctx, of, warn } = fakeContext()
    const text = tsv(
      header,
      ['111-0000001-0000001', '2026-09-01T10:00:00Z', 'Shipped', 'SKU-1', 'B000000001', '2', '19.98', 'USD'],
      ['111-0000001-0000002', '', 'Shipped', 'SKU-2', 'B000000002', '1', '5', 'USD'],
    )
    expect((await syncOrdersReport(ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER')).imported).toBe(1)
    const order = of('order')[0].args
    expect(order.where.sellerAccountId_amazonOrderId_purchaseDate).toMatchObject({ sellerAccountId: 'sa1', amazonOrderId: '111-0000001-0000001' })
    expect(order.create).toMatchObject({ tenantId: 't1', status: 'Shipped', currency: 'USD', amount: 19.98, marketplaceId: 'ATVPDKIKX0DER' })
    expect(of('orderItem')[0].args.create).toMatchObject({ sellerSku: 'SKU-1', asin: 'B000000001', quantityOrdered: 2, itemPrice: 19.98 })
    expect(of('order')).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('费用类报告导入', () => {
  it('仓储费：按月份落为月初的费用事件，事件编号稳定（重复导入不产生新记录）', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(['asin', 'sku', 'month-of-charge', 'estimated-monthly-storage-fee', 'currency'], ['B000000001', 'SKU-1', '2026-09', '12.5', 'USD'])
    expect((await syncStorageFeeReport(ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER')).imported).toBe(1)
    const first = of('fbaFeeEvent')[0].args
    expect(first.create).toMatchObject({ eventType: 'STORAGE_FEE', amount: 12.5, sellerSku: 'SKU-1', feeCategory: 'STORAGE', feeSubtype: 'STORAGE_FEE' })
    expect(first.update).toMatchObject({ feeCategory: 'STORAGE' })
    expect(first.update).not.toHaveProperty('reconciliationStatus')
    expect(first.create.postedAt.toISOString().slice(0, 10)).toBe('2026-09-01')
    const again = fakeContext()
    await syncStorageFeeReport(again.ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER')
    expect(again.of('fbaFeeEvent')[0].args.where).toEqual(first.where)
  })

  it('入仓不合规：缺少日期的行被跳过', async () => {
    const { ctx, of, warn } = fakeContext()
    const text = tsv(
      ['fba-shipment-id', 'sku', 'problem-type', 'fee-total', 'currency', 'issue-reported-date'],
      ['FBA1', 'SKU-1', 'Labeling', '3', 'USD', '2026-09-03'],
      ['FBA2', 'SKU-2', 'Labeling', '3', 'USD', ''],
    )
    expect((await syncNoncomplianceReport(ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER')).imported).toBe(1)
    expect(of('fbaFeeEvent')[0].args.create).toMatchObject({ eventType: 'INBOUND_NONCOMPLIANCE', amount: 3, feeCategory: 'INBOUND_PLACEMENT', feeSubtype: 'Labeling' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('入仓不合规：同一遍扫描里也写入货件接收的不合规问题（数量缺失为空，不记 0；没有日期的行不写）', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      ['fba-shipment-id', 'sku', 'problem-type', 'fee-total', 'currency', 'issue-reported-date'],
      ['FBA1', 'SKU-1', 'Labeling', '3', 'USD', '2026-09-03'],
      ['FBA2', 'SKU-2', 'Labeling', '3', 'USD', ''],
    )
    const handler = noncomplianceRowHandler({ tenantId: 't1', sellerAccountId: 'sa1', now: new Date('2026-10-01T00:00:00Z') })
    expect((await syncNoncomplianceReport(ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER', handler)).imported).toBe(1)
    const rows = of('receivingDiscrepancy')
    expect(rows).toHaveLength(1)
    expect(rows[0].args.create).toMatchObject({ shipmentRef: 'FBA1', sku: 'SKU-1', kind: 'NONCOMPLIANCE', source: 'REPORT', problemKey: 'Labeling', qty: null, amount: 3, planId: null })
    expect(rows[0].args.where.tenantId_sellerAccountId_shipmentRef_sku_kind_problemKey).toMatchObject({ kind: 'NONCOMPLIANCE', problemKey: 'Labeling' })
  })

  it('结算报告：汇总行写结算单，带金额的明细行按（结算单，行序号）写入 SettlementLine，不再写财务交易表', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      [
        'settlement-id',
        'settlement-start-date',
        'settlement-end-date',
        'deposit-date',
        'total-amount',
        'currency',
        'transaction-type',
        'order-id',
        'amount-type',
        'amount-description',
        'posted-date-time',
        'amount',
      ],
      ['S1', '2026-08-01 00:00:00 UTC', '2026-08-15 00:00:00 UTC', '2026-08-17 00:00:00 UTC', '100.5', 'EUR', '', '', '', '', '', ''],
      ['', '', '', '', '', '', 'Order', '111-1', 'ItemPrice', 'Principal', '2026-08-05T10:00:00Z', '120'],
      ['S1', '', '', '', '', '', 'Order', '111-1', 'ItemFees', 'Commission', '2026-08-05T10:00:00Z', '-19.5'],
    )
    const result = await syncSettlementReport(ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER', { reportJobId: 'rj1' })
    expect(result.imported).toBe(3)
    expect(of('fbaFinancialTransaction')).toHaveLength(0)
    const settlements = of('fbaSettlement')
    expect(settlements[0].args.create).toMatchObject({ externalSettlementId: 'S1', totalAmount: 100.5, disbursementAmount: 100.5, currency: 'EUR' })
    expect(settlements[0].args.create.sortAt).toEqual(new Date('2026-08-17T00:00:00Z'))
    // 同一份报告里只有汇总行写结算单；明细行沿用已写的结算单，不会覆盖日期与金额（更不会写 0）
    expect(settlements).toHaveLength(1)
    const lines = of('settlementLine')
    expect(lines).toHaveLength(2)
    expect(lines[0].args.where).toEqual({ settlementId_lineNo: { settlementId: 'fbaSettlement-1', lineNo: 2 } })
    expect(lines[0].args.create).toMatchObject({ category: 'INCOME', amazonOrderId: '111-1', amount: 120, currency: 'EUR', sourceReportJobId: 'rj1' })
    expect(lines[1].args.create).toMatchObject({ category: 'FEE', amount: -19.5, lineNo: 3 })
  })

  it('结算报告：缺少结算单编号列按格式变化失败', async () => {
    const { ctx } = fakeContext()
    await expect(syncSettlementReport(ctx, rowsOf(tsv(['order-id', 'amount'], ['1', '2'])), 't1', 'sa1', 'ATVPDKIKX0DER')).rejects.toThrow()
  })
})

describe('退货与商品报告导入', () => {
  it('退货：按订单、商品、退货件编号、退货时间幂等写入（详细规则见 returns/report.test.ts）', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(['order-id', 'asin', 'sku', 'return-date', 'quantity', 'reason', 'detailed-disposition'], ['111-1', 'B000000001', 'SKU-1', '2026-09-02T08:00:00Z', '2', 'DEFECTIVE', 'SELLABLE'])
    expect((await syncReturnsReport(ctx, rowsOf(text), 't1', 'sa1', 'ATVPDKIKX0DER')).imported).toBe(1)
    const call = of('fbaReturnCase')[0].args
    expect(call.where.sellerAccountId_amazonOrderId_asin_sellerSku_fnsku_licensePlateNumber_returnDate).toMatchObject({ amazonOrderId: '111-1', asin: 'B000000001', licensePlateNumber: '' })
    expect(call.create).toMatchObject({ quantity: 2, reason: 'DEFECTIVE', disposition: 'SELLABLE', detailedDisposition: 'SELLABLE' })
  })

  it('商品：缺少店铺上下文直接拒绝；正常行写入价格与履约渠道', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(['seller-sku', 'asin1', 'item-name', 'price', 'fulfillment-channel', 'status'], ['SKU-1', 'B000000001', '保温杯', '$19.99', 'AMAZON_NA', 'Active'])
    await expect(syncCatalogReport(ctx, rowsOf(text), { documentId: null, sellerAccountId: null }, 't1', 'ATVPDKIKX0DER')).rejects.toThrow('CATALOG_REPORT_CONTEXT_MISSING')
    expect((await syncCatalogReport(ctx, rowsOf(text), { documentId: 'doc1', sellerAccountId: 'sa1' }, 't1', 'ATVPDKIKX0DER')).imported).toBe(1)
    expect(of('fbaProduct')[0].args.create).toMatchObject({ sellerSku: 'SKU-1', asin: 'B000000001', price: 19.99, listingStatus: 'ACTIVE', fulfillmentChannel: 'AMAZON_NA' })
  })
})

describe('接口同步导入', () => {
  it('库存：分页读取并写入各数量与当日快照，不再写固定阈值的健康状态', async () => {
    const { ctx, of } = fakeContext()
    const pages = [
      {
        payload: {
          inventorySummaries: [{ sellerSku: 'SKU-1', asin: 'B000000001', inventoryDetails: { fulfillableQuantity: 5, reservedQuantity: { totalReservedQuantity: 2 }, inboundWorkingQuantity: 3 } }],
          pagination: { nextToken: 'next' },
        },
      },
      {
        payload: {
          inventorySummaries: [
            { sellerSku: 'SKU-2', asin: 'B000000002', inventoryDetails: { fulfillableQuantity: 50 } },
            { sellerSku: '', asin: 'x' },
          ],
        },
      },
    ]
    const getInventory = vi.fn(async () => pages.shift())
    const snapshotDate = new Date('2026-10-22T00:00:00Z')
    expect(await syncInventory(ctx, { getInventory } as unknown as AmazonSpApiClient, 't1', 'sa1', 'ATVPDKIKX0DER', snapshotDate)).toBe(3)
    expect(getInventory).toHaveBeenCalledTimes(2)
    expect(getInventory.mock.calls[1]).toEqual(['ATVPDKIKX0DER', 'next'])
    const rows = of('fbaInventoryRecord').map(call => call.args.create)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ sellerSku: 'SKU-1', fulfillableQuantity: 5, reservedQuantity: 2, inboundWorkingQuantity: 3, source: 'API' })
    expect(rows[0]).not.toHaveProperty('healthStatus')
    expect(rows[1]).toMatchObject({ sellerSku: 'SKU-2', fulfillableQuantity: 50 })
    const snapshots = of('inventoryDailySnapshot').map(call => call.args.create)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toMatchObject({ sku: 'SKU-1', snapshotDate, source: 'API', sellable: 5, reserved: 2, inbound: 3 })
  })
})

describe('广告报告导入', () => {
  const job = { id: 'rj1', downloadUrl: null, fromDate: new Date('2026-09-01'), adsProfileId: 'ap1', adProduct: 'SPONSORED_PRODUCTS' }
  const client = (body: string) => ({ openReport: vi.fn(async () => Readable.from([Buffer.from(body)])) }) as unknown as AmazonAdsApiClient

  it('活动报告：按日期与活动幂等写入指标', async () => {
    const { ctx, of } = fakeContext()
    const body = JSON.stringify([{ date: '2026-09-02', campaignId: 'c1', campaignName: '品牌词', impressions: 100, clicks: 5, cost: 3.2, sales7d: 20, purchases7d: 1 }])
    expect((await syncAdsReport(ctx, client(body), { ...job, reportType: 'spCampaigns' }, 't1', 'https://example.test/r')).imported).toBe(1)
    const metric = of('adsMetric')[0].args
    expect(metric.where.adsProfileId_reportDate_adProduct_externalCampaignId).toMatchObject({ adsProfileId: 'ap1', externalCampaignId: 'c1' })
    expect(metric.create).toMatchObject({ impressions: 100, clicks: 5, cost: 3.2, sales: 20, purchases: 1, campaignName: '品牌词', entityType: 'CAMPAIGN', entityId: 'c1' })
  })

  it('搜索词报告：落入词级指标表并标记层级', async () => {
    const { ctx, of } = fakeContext()
    const body = JSON.stringify([{ date: '2026-09-02', campaignId: 'c1', adGroupId: 'g1', targetId: 'k1', searchTerm: 'steel bottle', impressions: 10, clicks: 1, cost: 0.5 }])
    expect((await syncAdsReport(ctx, client(body), { ...job, reportType: 'spSearchTerm' }, 't1', 'https://example.test/r')).imported).toBe(1)
    expect(of('adsMetric')).toHaveLength(0)
    expect(of('adsTermMetric')[0].args.create).toMatchObject({ level: 'SEARCH_TERM', searchTerm: 'steel bottle', clicks: 1, keywordId: 'k1', targetId: 'k1' })
  })
})
