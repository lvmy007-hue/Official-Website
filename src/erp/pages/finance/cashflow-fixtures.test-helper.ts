import type { CashflowResponse, DisbursementRow, ForecastWeek } from '@nova/api-contracts'
import { freshness } from './fee-fixtures.test-helper'

// 回款与现金流页面测试用的接口返回样例（只在测试里使用）。

const WEEK_RANGES = [
  ['2026-10-23', '2026-10-29'],
  ['2026-10-30', '2026-11-05'],
] as const

export const week = (index: number, over: Partial<ForecastWeek> = {}): ForecastWeek => ({
  index,
  from: WEEK_RANGES[index]![0],
  to: WEEK_RANGES[index]![1],
  publishedInflow: 0,
  estimatedInflow: 0,
  purchaseOutflow: null,
  firstMileOutflow: null,
  adsOutflow: null,
  net: 0,
  cumulative: 0,
  missing: ['采购付款', '头程付款', '广告扣款'],
  ...over,
})

export const disbursementRow = (over: Partial<DisbursementRow> = {}): DisbursementRow => ({
  settlementId: 'st1',
  externalSettlementId: '12345678901',
  sellerAccountId: 's1',
  storeName: '美国主店',
  periodEnd: '2026-10-05',
  expectedDate: '2026-10-08',
  expectedAmount: 500,
  currency: 'USD',
  registered: null,
  state: 'UNREGISTERED',
  stateLabel: '超期未登记',
  diff: null,
  ...over,
})

export const registered = (over: Partial<NonNullable<DisbursementRow['registered']>> = {}): NonNullable<DisbursementRow['registered']> => ({
  id: 'd1',
  disbursedAt: '2026-10-09',
  amount: 480,
  currency: 'USD',
  bankLast4: '6789',
  note: '已核对流水',
  version: 3,
  createdBy: '财务小王',
  updatedBy: '财务小王',
  updatedAt: '2026-10-10T00:00:00.000Z',
  ...over,
})

export const cashflow = (over: Partial<CashflowResponse> = {}): CashflowResponse => ({
  state: 'OK',
  note: null,
  asOf: '2026-10-23',
  currency: 'USD',
  currencies: ['EUR', 'USD'],
  balances: {
    items: [{ sellerAccountId: 's1', storeName: '美国主店', accountType: 'PAYABLE', label: '递延余额（PAYABLE）', currency: 'USD', amount: 120.5, asOf: '2026-10-22' }],
    totals: [{ currency: 'USD', amount: 120.5 }],
    unavailable: [{ label: '可用余额、下次打款额', note: '官方没有通用的账户余额接口，这里不显示；下次打款见下方“打款预测”' }],
  },
  deferral: {
    totals: [{ currency: 'USD', amount: 100, count: 3, withMaturity: 2 }],
    schedule: {
      overdue: { amount: 0, count: 0 },
      weeks: [
        { from: '2026-10-23', to: '2026-10-29', amount: 80, count: 2 },
        { from: '2026-10-30', to: '2026-11-05', amount: 0, count: 0 },
      ],
      later: { amount: 0, count: 0 },
      unknown: { amount: 20, count: 1 },
    },
    released: [{ currency: 'USD', amount: 60, count: 4 }],
    releasedDays: 90,
    note: '预计释放日来自财务接口；接口没给的单列，不用下单日推算。',
  },
  payout: {
    stores: [
      {
        sellerAccountId: 's1',
        storeName: '美国主店',
        currency: 'USD',
        cycleDays: 14,
        lagDays: 3,
        samples: 3,
        lastPeriodEnd: '2026-10-20',
        published: [{ settlementId: 'st9', externalSettlementId: '99999', depositDate: '2026-10-23', amount: 500, currency: 'USD' }],
        predicted: [{ periodEnd: '2026-11-03', depositDate: '2026-11-06', runRateAmount: 1400, deferredAmount: 80, estimated: 1480 }],
        reason: null,
      },
    ],
    next: { date: '2026-10-23', amount: 500, kind: 'PUBLISHED', storeName: '美国主店' },
    dailyRate: 100,
    basis: '金额 = 最近 28 天已释放交易的日均净入账 × 结算周期天数，另加按预计释放日并入的递延金额。这是模型估算，不是亚马逊的承诺。',
  },
  forecast: {
    currency: 'USD',
    modelVersion: 'run-rate-v1',
    weeks: [
      week(0, { publishedInflow: 500, estimatedInflow: 0, net: 500, cumulative: 500 }),
      week(1, { estimatedInflow: 1480, net: -270, cumulative: 230, missing: ['头程付款'], firstMileOutflow: null }),
    ],
    sources: [
      { state: 'OK', label: '已公布的打款', note: '结算单上有打款日与金额、尚未到账日的', total: 500 },
      { state: 'RESTRICTED', label: '采购付款', note: '没有“采购查看”权限，不计入', total: null },
      { state: 'NOT_CONNECTED', label: '广告扣款', note: '广告花费报告尚未接入，不计入', total: null },
    ],
    excluded: [{ label: '采购付款', count: 1, currencies: ['CNY'] }],
    undated: [{ label: '采购付款', count: 2 }],
    assumptions: ['不换算汇率，不同币种分别预测', '累计净额不含期初余额'],
  },
  disbursements: {
    items: [
      disbursementRow(),
      disbursementRow({ settlementId: 'st2', externalSettlementId: '22222222222', registered: registered(), state: 'SHORT', stateLabel: '到账少于报告', diff: -20 }),
      disbursementRow({
        settlementId: 'st3',
        externalSettlementId: '33333333333',
        registered: registered({ id: 'd3', amount: 500, version: 1 }),
        state: 'MATCHED',
        stateLabel: '已到账且一致',
        diff: 0,
      }),
    ],
    summary: { total: 3, matched: 1, mismatched: 1, awaiting: 0, unregistered: 1 },
    truncated: false,
  },
  canConfirm: true,
  freshness,
  ...over,
})

export const emptyCashflow = (): CashflowResponse =>
  cashflow({
    state: 'NO_DATA',
    note: '尚无回款与现金流数据：店铺授权并同步财务数据与结算报告后显示',
    currencies: [],
    balances: { items: [], totals: [], unavailable: [] },
    deferral: { totals: [], schedule: null, released: [], releasedDays: 90, note: '预计释放日来自财务接口。' },
    payout: { stores: [], next: null, dailyRate: null, basis: '模型估算' },
    forecast: { currency: 'USD', modelVersion: 'run-rate-v1', weeks: [week(0, { estimatedInflow: null, missing: ['预计打款', '采购付款'] })], sources: [], excluded: [], undated: [], assumptions: [] },
    disbursements: { items: [], summary: { total: 0, matched: 0, mismatched: 0, awaiting: 0, unregistered: 0 }, truncated: false },
    canConfirm: false,
  })
