import { describe, expect, it } from 'vitest'
import {
  EXCEPTION_CATEGORIES,
  EXCEPTION_CATEGORY_HINT,
  EXCEPTION_CATEGORY_LABEL,
  EXCEPTION_KINDS,
  EXCEPTION_KIND_LABEL,
  SETTLEMENT_CATEGORIES,
  SETTLEMENT_CATEGORY_LABEL,
  SETTLEMENT_STATUSES,
  SETTLEMENT_STATUS_LABEL,
  SettlementExceptionsQuerySchema,
  SettlementLinesQuerySchema,
  SettlementListQuerySchema,
} from './settlements.js'
import {
  blocksMatch,
  classifyException,
  classifySettlementLine,
  compareBuckets,
  inPeriod,
  isOpeningBalanceLine,
  parseReportTime,
  settlementStatusOf,
  totalsByCategory,
  type ExceptionContext,
} from './settlements-math.js'

describe('标签与枚举齐全', () => {
  it('每个枚举值都有中文名；差异分类都有说明', () => {
    for (const key of SETTLEMENT_CATEGORIES) expect(SETTLEMENT_CATEGORY_LABEL[key]).toBeTruthy()
    for (const key of SETTLEMENT_STATUSES) expect(SETTLEMENT_STATUS_LABEL[key]).toBeTruthy()
    for (const key of EXCEPTION_KINDS) expect(EXCEPTION_KIND_LABEL[key]).toBeTruthy()
    for (const key of EXCEPTION_CATEGORIES) {
      expect(EXCEPTION_CATEGORY_LABEL[key]).toBeTruthy()
      expect(EXCEPTION_CATEGORY_HINT[key]).toBeTruthy()
    }
  })
})

describe('请求校验', () => {
  it('列表：默认按打款日从新到旧；状态只认三种；排序字段只认 sortAt', () => {
    expect(SettlementListQuerySchema.parse({}).sort).toEqual({ field: 'sortAt', dir: 'desc' })
    expect(SettlementListQuerySchema.parse({ status: 'MATCHED' }).status).toBe('MATCHED')
    expect(() => SettlementListQuerySchema.parse({ status: 'NOPE' })).toThrow()
    expect(() => SettlementListQuerySchema.parse({ sort: 'amount' })).toThrow()
  })

  it('明细与异常：不带数据范围参数；明细按行号升序，异常按金额绝对值降序', () => {
    expect(SettlementLinesQuerySchema.parse({}).sort).toEqual({ field: 'lineNo', dir: 'asc' })
    expect(SettlementLinesQuerySchema.parse({ category: 'FEE' }).category).toBe('FEE')
    expect(() => SettlementLinesQuerySchema.parse({ category: 'NOPE' })).toThrow()
    expect(SettlementExceptionsQuerySchema.parse({}).sort).toEqual({ field: 'absAmount', dir: 'desc' })
    expect(SettlementExceptionsQuerySchema.parse({ kind: 'ORDER_MISSING', category: 'SCOPE', status: 'OPEN' })).toMatchObject({ kind: 'ORDER_MISSING', category: 'SCOPE', status: 'OPEN' })
    expect(() => SettlementExceptionsQuerySchema.parse({ kind: 'NOPE' })).toThrow()
  })
})

describe('结算明细归类', () => {
  const kind = (transactionType: string, amountType = '', amountDescription = '') => classifySettlementLine({ transactionType, amountType, amountDescription })

  it('订单：价格类是收入，费用类是费用', () => {
    expect(kind('Order', 'ItemPrice', 'Principal')).toBe('INCOME')
    expect(kind('Order', 'ItemPrice', 'Tax')).toBe('INCOME')
    expect(kind('Order', 'ItemFees', 'Commission')).toBe('FEE')
    expect(kind('Order', 'ItemFees', 'FBAPerUnitFulfillmentFee')).toBe('FEE')
    expect(kind('Order', 'Promotion', 'Shipping')).toBe('INCOME')
  })

  it('退款、A 到 Z、拒付是退款；赔付先于退款判断', () => {
    expect(kind('Refund', 'ItemPrice', 'Principal')).toBe('REFUND')
    expect(kind('Refund', 'ItemFees', 'RefundCommission')).toBe('REFUND')
    expect(kind('other-transaction', '', 'A-to-z Guarantee Claim')).toBe('REFUND')
    expect(kind('other-transaction', '', 'Chargeback Refund')).toBe('REFUND')
    expect(kind('other-transaction', '', 'FBA Inventory Reimbursement - Lost')).toBe('REIMBURSEMENT')
    expect(kind('other-transaction', '', 'WAREHOUSE_DAMAGE')).toBe('REIMBURSEMENT')
  })

  it('保留金先于其它判断；费用类杂项；认不出的归调整及其他（不冒充收入）', () => {
    expect(kind('Previous Reserve Amount Balance')).toBe('RESERVE')
    expect(kind('other-transaction', '', 'Current Reserve Amount')).toBe('RESERVE')
    expect(kind('other-transaction', '', 'Subscription Fee')).toBe('FEE')
    expect(kind('other-transaction', '', 'FBA Storage Fee')).toBe('FEE')
    expect(kind('other-transaction', '', 'Cost of Advertising')).toBe('FEE')
    expect(kind('other-transaction', '', 'FBA Removal Order: Disposal Fee')).toBe('FEE')
    expect(kind('other-transaction', '', 'Manual adjustment')).toBe('ADJUSTMENT')
    expect(kind('', '', '')).toBe('ADJUSTMENT')
  })

  it('期初余额行；按类别合计保留两位小数', () => {
    expect(isOpeningBalanceLine({ amountDescription: 'Previous Reserve Amount Balance' })).toBe(true)
    expect(isOpeningBalanceLine({ transactionType: 'Previous Reserve Amount Balance' })).toBe(true)
    expect(isOpeningBalanceLine({ amountDescription: 'Current Reserve Amount' })).toBe(false)
    expect(
      totalsByCategory([
        { category: 'INCOME', amount: 0.1 },
        { category: 'INCOME', amount: 0.2 },
        { category: 'FEE', amount: -1.005 },
      ]),
    ).toEqual({ INCOME: 0.3, FEE: -1, REFUND: 0, REIMBURSEMENT: 0, ADJUSTMENT: 0, RESERVE: 0 })
  })
})

describe('报告时间解析', () => {
  it('日期、带 UTC 的时间、ISO 时间、不带时区的时间（按 UTC）；解析不了是 null，不用当前时间兜底', () => {
    expect(parseReportTime('2026-09-30')?.toISOString()).toBe('2026-09-30T00:00:00.000Z')
    expect(parseReportTime('2026-09-30 23:59:59 UTC')?.toISOString()).toBe('2026-09-30T23:59:59.000Z')
    expect(parseReportTime('2026-09-30T23:59:59Z')?.toISOString()).toBe('2026-09-30T23:59:59.000Z')
    expect(parseReportTime('2026-09-30 08:00:00')?.toISOString()).toBe('2026-09-30T08:00:00.000Z')
    expect(parseReportTime('')).toBeNull()
    expect(parseReportTime(undefined)).toBeNull()
    expect(parseReportTime('not a date')).toBeNull()
  })
})

describe('两边按订单逐组比较', () => {
  it('差额在容差内算对平；只有一边有的是报告独有或接口独有；两边都有金额不同是金额不一致；差额是报告减接口', () => {
    const report = new Map([
      ['A', 100],
      ['B', 10],
      ['C', 5],
      ['D', 7.03],
    ])
    const api = new Map([
      ['A', 100.04],
      ['C', 8],
      ['D', 7],
      ['E', 3],
    ])
    expect(compareBuckets(report, api, 0.05)).toEqual([
      { key: 'B', reportAmount: 10, apiAmount: 0, diff: 10, kind: 'REPORT_ONLY' },
      { key: 'C', reportAmount: 5, apiAmount: 8, diff: -3, kind: 'AMOUNT_MISMATCH' },
      { key: 'E', reportAmount: 0, apiAmount: 3, diff: -3, kind: 'API_ONLY' },
    ])
    expect(compareBuckets(new Map(), new Map())).toEqual([])
  })
})

describe('差异归类与对平判断', () => {
  const base: ExceptionContext = {
    kind: 'AMOUNT_MISMATCH',
    reportAmount: 100,
    apiAmount: 85,
    diff: 15,
    apiOutsidePeriod: 0,
    apiUnattributed: 0,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    apiCoverageStart: new Date('2026-01-01T00:00:00Z'),
    ordersCoverageStart: new Date('2026-01-01T00:00:00Z'),
  }

  it('时间口径优先于归因口径：接口里周期外的交易扣掉后两边就一致', () => {
    expect(classifyException({ ...base, reportAmount: 100, apiAmount: 115, diff: -15, apiOutsidePeriod: 15, apiUnattributed: -15 })).toBe('TIMING')
    // 周期外的金额不足以解释差额：不算时间口径
    expect(classifyException({ ...base, apiOutsidePeriod: 5 })).toBe('UNEXPLAINED')
  })

  it('归因口径：差额正好是没归到本结算单的交易', () => {
    expect(classifyException({ ...base, apiUnattributed: 15 })).toBe('ATTRIBUTION')
    expect(classifyException({ ...base, apiUnattributed: 14 })).toBe('UNEXPLAINED')
  })

  it('范围：报告有接口没有，且接口最早交易晚于周期开始；没有任何接口交易也是范围；订单未同步同理', () => {
    const only = { ...base, kind: 'REPORT_ONLY' as const, apiAmount: 0, diff: 100 }
    expect(classifyException({ ...only, apiCoverageStart: new Date('2026-09-10T00:00:00Z') })).toBe('SCOPE')
    expect(classifyException({ ...only, apiCoverageStart: null })).toBe('SCOPE')
    expect(classifyException(only)).toBe('UNEXPLAINED')
    expect(classifyException({ ...base, kind: 'ORDER_MISSING', ordersCoverageStart: new Date('2026-09-10T00:00:00Z') })).toBe('SCOPE')
    expect(classifyException({ ...base, kind: 'ORDER_MISSING', ordersCoverageStart: null })).toBe('SCOPE')
    expect(classifyException({ ...base, kind: 'ORDER_MISSING' })).toBe('UNEXPLAINED')
    expect(classifyException({ ...base, kind: 'SELF_CHECK' })).toBe('UNEXPLAINED')
  })

  it('只有“订单未同步且在范围外”不挡住对平；其余异常都挡', () => {
    expect(blocksMatch('ORDER_MISSING', 'SCOPE')).toBe(false)
    expect(blocksMatch('ORDER_MISSING', 'UNEXPLAINED')).toBe(true)
    expect(blocksMatch('REPORT_ONLY', 'SCOPE')).toBe(true)
    expect(blocksMatch('SELF_CHECK', 'UNEXPLAINED')).toBe(true)
  })

  it('核对状态：没报告、没交易是待核对（原因不同）；差额在容差内且没有阻挡的异常才是已对平', () => {
    const input = { hasReport: true, hasTransactions: true, diff: 0, blockingExceptions: 0 }
    expect(settlementStatusOf({ ...input, hasReport: false })).toEqual({ status: 'PENDING', pendingReason: 'NO_REPORT' })
    expect(settlementStatusOf({ ...input, hasTransactions: false })).toEqual({ status: 'PENDING', pendingReason: 'NO_TRANSACTIONS' })
    expect(settlementStatusOf(input)).toEqual({ status: 'MATCHED', pendingReason: null })
    expect(settlementStatusOf({ ...input, diff: 0.05 }).status).toBe('MATCHED')
    expect(settlementStatusOf({ ...input, diff: -0.06 }).status).toBe('DISCREPANCY')
    expect(settlementStatusOf({ ...input, blockingExceptions: 1 }).status).toBe('DISCREPANCY')
  })

  it('入账时间是否在结算周期内：前后各放宽一段；周期缺失视为在内', () => {
    const start = new Date('2026-09-01T00:00:00Z')
    const end = new Date('2026-09-14T23:59:59Z')
    const day = 86_400_000
    expect(inPeriod(new Date('2026-09-05T00:00:00Z'), start, end, day)).toBe(true)
    expect(inPeriod(new Date('2026-08-31T12:00:00Z'), start, end, day)).toBe(true)
    expect(inPeriod(new Date('2026-08-30T00:00:00Z'), start, end, day)).toBe(false)
    expect(inPeriod(new Date('2026-09-15T20:00:00Z'), start, end, day)).toBe(true)
    expect(inPeriod(new Date('2026-09-16T00:00:00Z'), start, end, day)).toBe(false)
    expect(inPeriod(new Date('2020-01-01T00:00:00Z'), null, null, day)).toBe(true)
  })
})
