import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTransaction, type ParsedTransaction } from './v2024-parse'
import { syncFinanceV2024 } from './v2024-sync'
import { writeTransaction } from './v2024-write'

// 财务新版接口（Finances API v2024-06-19 listTransactions）：官方模型文件里的样例结构经真实解析器、写入器写入记录型数据库替身。
// 官方样例里 transactionStatus 写作 "Released"（与枚举大小写不同），解析必须大小写不敏感。

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
                if (key in overrides) return overrides[key]
                if (op === 'upsert') return { id: `${model}-1`, ...(args?.create ?? {}) }
                if (op === 'findMany') return []
                return null
              }
            },
          },
        )
      },
    },
  ) as unknown as PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const of = (model: string, op = 'upsert') => calls.filter(call => call.model === model && call.op === op)
  return { prisma, logger, calls, of }
}

const usd = (currencyAmount: number) => ({ currencyAmount, currencyCode: 'USD' })
function sampleTransaction(overrides: Record<string, unknown> = {}) {
  return {
    sellingPartnerMetadata: { sellingPartnerId: 'A3TH9S8BH6GOGM', accountType: 'PAYABLE', marketplaceId: 'ATVPDKIKX0DER' },
    relatedIdentifiers: [
      { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: '902-1845936-5435065' },
      { relatedIdentifierName: 'SETTLEMENT_ID', relatedIdentifierValue: '12345678901' },
      { relatedIdentifierName: 'FINANCIAL_EVENT_GROUP_ID', relatedIdentifierValue: '4MVaHcsAfaYAlwlaPWrXJxrfUiKfYZ2ooWtY7528FUA' },
    ],
    transactionType: 'Shipment',
    transactionId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI',
    transactionStatus: 'Released',
    description: 'Order Payment',
    postedDate: '2026-09-10T03:35:13.214Z',
    totalAmount: usd(10),
    marketplaceDetails: { marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'Amazon.com' },
    items: [
      {
        description: 'Item title',
        totalAmount: usd(10),
        relatedIdentifiers: [{ itemRelatedIdentifierName: 'ORDER_ADJUSTMENT_ITEM_ID', itemRelatedIdentifierValue: '81297625-121-27551' }],
        breakdowns: [{ breakdownType: 'Product Charges', breakdownAmount: usd(10), breakdowns: [{ breakdownType: 'Principle', breakdownAmount: usd(10), breakdowns: [] }] }],
        contexts: [{ contextType: 'ProductContext', asin: 'B07FGXZQZ1', sku: 'sku-12', quantityShipped: 1, fulfillmentNetwork: 'MFN' }],
      },
    ],
    ...overrides,
  }
}
const parsed = (raw: Record<string, unknown>): ParsedTransaction => {
  const transaction = parseTransaction(raw)
  if ('skipped' in transaction) throw new Error(`交易被跳过：${transaction.skipped}`)
  return transaction
}
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const NOW = new Date('2026-09-20T12:00:00Z')

describe('财务新版接口解析', () => {
  it('交易头、状态（大小写不敏感）、关联标识、结算编号、费用明细叶子', () => {
    const transaction = parsed(sampleTransaction())
    expect(transaction).toMatchObject({
      transactionId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI',
      transactionType: 'Shipment',
      status: 'RELEASED',
      description: 'Order Payment',
      amount: 10,
      currency: 'USD',
      amazonOrderId: '902-1845936-5435065',
      settlementId: '12345678901',
      accountType: 'PAYABLE',
    })
    expect(transaction.postedAt.toISOString()).toBe('2026-09-10T03:35:13.214Z')
    expect(transaction.relatedIdentifiers).toHaveLength(3)
    expect(transaction.lines).toEqual([
      {
        sourceEventId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI:0:0.0.0',
        eventType: 'Principle',
        path: 'Product Charges/Principle',
        amount: 10,
        currency: 'USD',
        asin: 'B07FGXZQZ1',
        sellerSku: 'sku-12',
      },
    ])
  })

  it('没有拆分明细的行用该行合计作为一条明细；breakdowns 是对象形式（官方示例里出现过）也能读', () => {
    const transaction = parsed(sampleTransaction({ items: [{ totalAmount: usd(4.5), breakdowns: { breakdowns: [] } }] }))
    expect(transaction.lines).toEqual([
      { sourceEventId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI:0:total', eventType: 'Shipment', path: 'Shipment', amount: 4.5, currency: 'USD', asin: undefined, sellerSku: undefined },
    ])
    const nested = parsed(sampleTransaction({ items: [{ breakdowns: { breakdowns: [{ breakdownType: 'Fees', breakdownAmount: usd(-2), breakdowns: [] }] } }] }))
    expect(nested.lines[0]).toMatchObject({ eventType: 'Fees', amount: -2 })
  })

  it('官方将来新增的状态不报错：状态为空并保留原值；接口没给状态时同样为空', () => {
    expect(parsed(sampleTransaction({ transactionStatus: 'SOMETHING_NEW' }))).toMatchObject({ status: undefined, statusRaw: 'SOMETHING_NEW' })
    expect(parsed(sampleTransaction({ transactionStatus: undefined })).status).toBeUndefined()
    expect(parsed(sampleTransaction({ transactionStatus: 'DEFERRED_RELEASED' })).status).toBe('DEFERRED_RELEASED')
  })

  it('递延交易的预计释放日（P2b-08）：从交易层与明细行层的 DeferredContext 取，多个取最晚的；没有或日期不合法就是空', () => {
    const deferred = (maturityDate: unknown) => ({ contextType: 'DeferredContext', deferralReason: 'DD7', maturityDate })
    expect(parsed(sampleTransaction()).maturityAt).toBeUndefined()
    const both = parsed(
      sampleTransaction({
        transactionStatus: 'DEFERRED',
        contexts: [deferred('2026-09-20T00:00:00Z')],
        items: [{ totalAmount: usd(10), breakdowns: [], contexts: [deferred('2026-09-25T00:00:00Z'), { contextType: 'ProductContext', sku: 'sku-12' }] }],
      }),
    )
    expect(both.maturityAt?.toISOString()).toBe('2026-09-25T00:00:00.000Z')
    expect(parsed(sampleTransaction({ contexts: [deferred('not-a-date')] })).maturityAt).toBeUndefined()
  })

  it('缺交易编号、缺入账时间（分区列）、缺金额、非美国站的交易返回跳过原因', () => {
    expect(parseTransaction(sampleTransaction({ transactionId: undefined }))).toEqual({ skipped: 'NO_TRANSACTION_ID' })
    expect(parseTransaction(sampleTransaction({ postedDate: undefined }))).toEqual({ skipped: 'NO_POSTED_DATE' })
    expect(parseTransaction(sampleTransaction({ totalAmount: undefined }))).toEqual({ skipped: 'NO_AMOUNT' })
    expect(parseTransaction(sampleTransaction({ marketplaceDetails: { marketplaceId: 'A1F83G8C2ARO7P' } }))).toEqual({ skipped: 'NOT_US_MARKETPLACE' })
  })
})

describe('财务新版接口写入', () => {
  it('交易、费用明细、结算关联按幂等键写入；交易状态与金额每次覆盖（状态会从递延变成已释放）', async () => {
    const { prisma, logger, of } = recorder()
    await writeTransaction({ prisma, logger }, scope, parsed(sampleTransaction()))
    expect(of('fbaSettlement')[0].args.where.sellerAccountId_externalSettlementId).toEqual({ sellerAccountId: 'sa1', externalSettlementId: '12345678901' })
    expect(of('fbaSettlement')[0].args.update).toEqual({})

    const transaction = of('fbaFinancialTransaction')[0].args
    expect(transaction.where.sellerAccountId_externalTransactionId_postedAt).toMatchObject({ sellerAccountId: 'sa1', externalTransactionId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI' })
    expect(transaction.create).toMatchObject({
      tenantId: 't1',
      settlementId: 'fbaSettlement-1',
      amazonOrderId: '902-1845936-5435065',
      transactionStatus: 'RELEASED',
      amount: 10,
      currency: 'USD',
      marketplaceId: 'ATVPDKIKX0DER',
    })
    expect(transaction.create.relatedIdentifiers).toHaveLength(3)
    expect(transaction.update.transactionStatus).toBe('RELEASED')

    const fee = of('fbaFeeEvent')[0].args
    expect(fee.where.sellerAccountId_sourceEventId_postedAt).toMatchObject({ sourceEventId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI:0:0.0.0' })
    expect(fee.create).toMatchObject({ eventType: 'Principle', amount: 10, asin: 'B07FGXZQZ1', sellerSku: 'sku-12', settlementId: '12345678901', description: 'Product Charges/Principle' })
  })

  it('每条费用明细写入时就分类（P2b-05）：销售收入是“不是费用”，配送费、佣金、退款各归其类；交易状态同步到明细，新增与更新都带', async () => {
    const { prisma, logger, of } = recorder()
    const line = (suffix: string, path: string, amount: number) => ({ breakdownType: path, breakdownAmount: usd(amount), breakdowns: [] as unknown[], suffix })
    const items = [
      {
        totalAmount: usd(-4),
        breakdowns: [
          { breakdownType: 'Amazon Fees', breakdownAmount: usd(-4), breakdowns: [line('a', 'FBAPerUnitFulfillmentFee', -3), line('b', 'Commission', -1)] },
          { breakdownType: 'Product Charges', breakdownAmount: usd(10), breakdowns: [line('c', 'Principal', 10)] },
        ],
      },
    ]
    await writeTransaction({ prisma, logger }, scope, parsed(sampleTransaction({ items, transactionStatus: 'Deferred' })))
    const byType = Object.fromEntries(of('fbaFeeEvent').map(call => [call.args.create.eventType, call.args]))
    expect(byType.FBAPerUnitFulfillmentFee.create).toMatchObject({ feeCategory: 'FULFILLMENT', transactionStatus: 'DEFERRED' })
    expect(byType.Commission.create).toMatchObject({ feeCategory: 'COMMISSION' })
    expect(byType.Principal.create).toMatchObject({ feeCategory: 'NON_FEE' })
    expect(byType.Commission.update).toMatchObject({ feeCategory: 'COMMISSION', transactionStatus: 'DEFERRED' })
    // 不覆盖人工对账的字段
    for (const args of Object.values(byType)) {
      expect(args.update).not.toHaveProperty('reconciliationStatus')
      expect(args.update).not.toHaveProperty('reconciliationNote')
    }
  })

  it('预计释放日写进交易的 maturityAt；接口没给时不传这一列，已有的值不会被冲掉', async () => {
    const { prisma, logger, of } = recorder()
    const deferred = sampleTransaction({ transactionStatus: 'DEFERRED', contexts: [{ contextType: 'DeferredContext', maturityDate: '2026-09-25T00:00:00Z' }] })
    await writeTransaction({ prisma, logger }, scope, parsed(deferred))
    expect(of('fbaFinancialTransaction')[0].args.create.maturityAt.toISOString()).toBe('2026-09-25T00:00:00.000Z')
    expect(of('fbaFinancialTransaction')[0].args.update.maturityAt.toISOString()).toBe('2026-09-25T00:00:00.000Z')
    await writeTransaction({ prisma, logger }, scope, parsed(sampleTransaction()))
    expect(of('fbaFinancialTransaction')[1].args.update.maturityAt).toBeUndefined()
  })

  it('没有结算编号的交易不建结算记录；状态未知时写空并留下原值', async () => {
    const { prisma, logger, of } = recorder()
    await writeTransaction(
      { prisma, logger },
      scope,
      parsed(sampleTransaction({ relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'o1' }], transactionStatus: 'SOMETHING_NEW' })),
    )
    expect(of('fbaSettlement')).toHaveLength(0)
    const create = of('fbaFinancialTransaction')[0].args.create
    expect(create.settlementId).toBeNull()
    expect(create.transactionStatus).toBeNull()
    expect(create.raw).toMatchObject({ statusRaw: 'SOMETHING_NEW' })
  })

  it('幂等：同一交易写两次，幂等键完全相同', async () => {
    const { prisma, logger, of } = recorder()
    const transaction = parsed(sampleTransaction())
    await writeTransaction({ prisma, logger }, scope, transaction)
    await writeTransaction({ prisma, logger }, scope, transaction)
    const keys = (model: string, field: string) => of(model).map(call => JSON.stringify(call.args.where[field]))
    expect(new Set(keys('fbaFinancialTransaction', 'sellerAccountId_externalTransactionId_postedAt')).size).toBe(1)
    expect(new Set(keys('fbaFeeEvent', 'sellerAccountId_sourceEventId_postedAt')).size).toBe(1)
  })
})

describe('财务新版接口同步', () => {
  const window = { after: '2026-09-01T00:00:00Z', before: '2026-09-08T00:00:00Z' }
  // 时间窗的起点会被“最多回溯 730 天”截断，固定当前时间，测试结果才不随日期变化
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('带时间窗的回补任务：逐页取数，翻页带同样的时间窗，只处理该窗口，不做递延核对', async () => {
    const { prisma, logger, calls } = recorder()
    const listTransactions = vi
      .fn()
      .mockResolvedValueOnce({ payload: { transactions: [sampleTransaction(), sampleTransaction({ transactionId: '' })], nextToken: 'p2' } })
      .mockResolvedValueOnce({ payload: { transactions: [sampleTransaction({ transactionId: 'tx-2' })] } })
    const result = await syncFinanceV2024({ prisma, logger }, { listTransactions }, scope, { window })
    expect(result).toMatchObject({ imported: 2, skipped: 1, pages: 2, deferredReleased: 0, balanceRows: 0 })
    expect(listTransactions).toHaveBeenCalledTimes(2)
    expect(listTransactions.mock.calls[0][0]).toMatchObject({ postedAfter: window.after, postedBefore: window.before })
    expect(listTransactions.mock.calls[1][0]).toMatchObject({ postedAfter: window.after, postedBefore: window.before, nextToken: 'p2' })
    expect(calls.filter(call => call.model === 'accountBalanceSnapshot')).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('增量：从上次成功时间前推 14 天重拉；之后单独核对递延交易，接口不再返回的改为“递延后已释放”，并写入当天递延余额', async () => {
    const { prisma, logger, calls, of } = recorder({ 'fbaFinancialTransaction.findMany': [{ externalTransactionId: 'still-deferred' }, { externalTransactionId: 'now-released' }] })
    const listTransactions = vi.fn(async (input: { transactionStatus?: string }) =>
      input.transactionStatus === 'DEFERRED'
        ? { payload: { transactions: [sampleTransaction({ transactionId: 'still-deferred', transactionStatus: 'DEFERRED', totalAmount: usd(25.5), postedDate: '2026-09-15T00:00:00Z' })] } }
        : { payload: { transactions: [] } },
    )
    const since = new Date('2026-09-20T00:00:00Z')
    const result = await syncFinanceV2024({ prisma, logger }, { listTransactions }, scope, { since, now: () => NOW })
    // 主窗口：起点 = since − 14 天
    expect(listTransactions.mock.calls[0][0].postedAfter).toBe('2026-09-06T00:00:00.000Z')
    const deferredCall = listTransactions.mock.calls.find(call => call[0].transactionStatus === 'DEFERRED')?.[0]
    expect(deferredCall).toMatchObject({ transactionStatus: 'DEFERRED' })
    expect(result).toMatchObject({ deferredReleased: 1, balanceRows: 1 })
    const released = of('fbaFinancialTransaction', 'updateMany')[0].args
    expect(released.where.externalTransactionId.in).toEqual(['now-released'])
    expect(released.data).toEqual({ transactionStatus: 'DEFERRED_RELEASED' })
    // 费用明细上冗余的交易状态同步改成“递延后已释放”（费用事件页的交易状态筛选）；只改仍是递延的明细
    const feeRelease = of('fbaFeeEvent', 'updateMany')[0].args
    expect(feeRelease.where).toMatchObject({ sellerAccountId: 'sa1', sourceRecordId: { in: ['now-released'] }, transactionStatus: 'DEFERRED' })
    expect(feeRelease.data).toEqual({ transactionStatus: 'DEFERRED_RELEASED' })
    const snapshot = of('accountBalanceSnapshot')[0].args
    expect(snapshot.create).toMatchObject({ balanceType: 'DEFERRED', accountType: 'PAYABLE', currency: 'USD', amount: 25.5, tenantId: 't1', sourceRecordId: 'deferred:2026-09-20' })
    expect(snapshot.where.sellerAccountId_snapshotDate_currency_balanceType_accountType.snapshotDate.toISOString()).toBe('2026-09-20T00:00:00.000Z')
    expect(calls.some(call => call.model === 'fbaFinancialTransaction' && call.op === 'upsert')).toBe(true)
  })

  it('当天没有任何递延交易也写一行 0：余额曲线能区分“确实为 0”与“没有数据”', async () => {
    const { prisma, logger, of } = recorder()
    const listTransactions = vi.fn().mockResolvedValue({ payload: { transactions: [] } })
    const result = await syncFinanceV2024({ prisma, logger }, { listTransactions }, scope, { since: new Date('2026-09-20T00:00:00Z'), now: () => NOW })
    expect(result.balanceRows).toBe(1)
    expect(of('accountBalanceSnapshot')[0].args.create).toMatchObject({ amount: 0, currency: 'USD', balanceType: 'DEFERRED', accountType: '' })
  })

  it('接口错误原样抛出，交给任务重试', async () => {
    const { prisma, logger } = recorder()
    const listTransactions = vi.fn().mockRejectedValue(Object.assign(new Error('SP_API_429'), { status: 429 }))
    await expect(syncFinanceV2024({ prisma, logger }, { listTransactions }, scope, { window })).rejects.toMatchObject({ status: 429 })
  })
})
