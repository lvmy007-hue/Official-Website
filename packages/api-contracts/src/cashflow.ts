import { z } from 'zod'
import type { InventoryFreshness } from './inventory.js'

// 回款与现金流（P2b-08，07 章 7.8，freeze/api.md GET /finance/cashflow、POST /finance/disbursements/confirm）。
// 本文件放常量、请求校验与响应类型；纯函数（打款周期、按周预测、到账核对、递延分桶）在 cashflow-math.ts。
// 数据口径（CR-021）：官方没有通用的账户余额接口，页面上的“余额”只有递延余额（由 listTransactions 的递延交易推导）；
// 可用余额与下次打款额不可得，下次打款只能取自已公布的结算单，或按历史周期估算（标明是模型估算）。

export const CASHFLOW_READ = 'finance.read'
export const CASHFLOW_CONFIRM = 'finance.reconcile'
export const CASHFLOW_FRESHNESS_KEYS = ['finance.transactions', 'rpt.settlement'] as const

/** 预测周数（每周 7 天，第 1 周从今天起）：默认 8，最多 13。 */
export const CASHFLOW_WEEKS_DEFAULT = 8
export const CASHFLOW_WEEKS_MAX = 13
/** 推断打款周期用最近几张结算单，至少几张。 */
export const PAYOUT_HISTORY_SETTLEMENTS = 6
export const PAYOUT_MIN_SETTLEMENTS = 2
/** 推断出的周期与到账延迟超出这个范围就不预测（数据多半不对）。 */
export const CASHFLOW_CYCLE_MAX_DAYS = 45
export const CASHFLOW_LAG_MAX_DAYS = 30
/** 日均净入账取最近多少天已释放的交易；广告日均取最近多少天的广告花费。这两个天数是我们定的。 */
export const CASHFLOW_RUN_RATE_DAYS = 28
export const CASHFLOW_ADS_DAYS = 14
/** 递延交易只看最近这么多天入账的（与财务同步的递延核对窗口一致）；“已释放”看最近多少天入账的原递延交易。 */
export const CASHFLOW_DEFERRED_DAYS = 180
export const CASHFLOW_RELEASED_DAYS = 90
/** 到账核对：金额差额不超过它算一致（结算币种的绝对金额，我们定的数）；过了打款日几天内算“等待登记”。 */
export const DISBURSEMENT_TOLERANCE = 0.05
export const DISBURSEMENT_GRACE_DAYS = 3
/** 到账核对列表最多列出最近多少张结算单。 */
export const DISBURSEMENT_LIST_LIMIT = 100
export const CASHFLOW_MODEL_VERSION = 'run-rate-v1'
export const DISBURSEMENT_NOTE_MAX = 200

const dateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => {
    const time = Date.parse(`${value}T00:00:00Z`)
    return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value)
  }, '日期不存在')

export const CashflowQuerySchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, '币种应为三位大写字母')
    .default('USD'),
  weeks: z.coerce.number().int().min(1).max(CASHFLOW_WEEKS_MAX).default(CASHFLOW_WEEKS_DEFAULT),
})
export type CashflowQuery = z.infer<typeof CashflowQuerySchema>

export const DisbursementConfirmBodySchema = z
  .object({
    settlementId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '结算单编号不合法'),
    disbursedAt: dateText,
    amount: z.number().positive('到账金额必须大于 0').max(1e12),
    currency: z.string().regex(/^[A-Z]{3}$/, '币种应为三位大写字母'),
    bankLast4: z
      .string()
      .regex(/^\d{4}$/, '收款账户末四位应为四位数字')
      .optional(),
    note: z.string().trim().max(DISBURSEMENT_NOTE_MAX).optional(),
    /** 已有登记再改正时必须带上看到的版本号（乐观锁）；第一次登记不带。 */
    version: z.number().int().min(1).optional(),
  })
  .strict()
export type DisbursementConfirmBody = z.infer<typeof DisbursementConfirmBodySchema>

// ---- 纯函数用到的类型 ----

export type PayoutCycle = { ok: true; cycleDays: number; lagDays: number; samples: number; lastPeriodEnd: string } | { ok: false; reason: string }

export interface PredictedPayout {
  periodEnd: string
  depositDate: string
  /** 近期日均净入账 × 周期天数；没有近期交易为 null。 */
  runRateAmount: number | null
  /** 并入这次打款的递延释放金额（按预计释放日）。 */
  deferredAmount: number
  /** 合计；两项都没有时为 null。 */
  estimated: number | null
}

export interface ForecastWeek {
  index: number
  from: string
  to: string
  /** 已公布的打款（结算单上有打款日与金额，尚未到账日）。 */
  publishedInflow: number
  /** 模型预计的打款；预测不可用为 null。 */
  estimatedInflow: number | null
  /** 采购付款计划（计划中、尚未付）；来源不可用为 null。 */
  purchaseOutflow: number | null
  firstMileOutflow: number | null
  adsOutflow: number | null
  /** 净额只加上可用的部分；不可用的来源列在 missing。 */
  net: number
  /** 累计净额，不含期初余额。 */
  cumulative: number
  missing: string[]
}

export interface DeferralBucket {
  amount: number
  count: number
}
export interface DeferralSchedule {
  overdue: DeferralBucket
  weeks: Array<{ from: string; to: string; amount: number; count: number }>
  later: DeferralBucket
  unknown: DeferralBucket
}

export const DISBURSEMENT_MATCH_STATES = ['MATCHED', 'SHORT', 'OVER', 'CURRENCY_DIFFERENT', 'PENDING_DEPOSIT', 'AWAITING', 'UNREGISTERED', 'NO_DEPOSIT_DATE'] as const
export type DisbursementMatchState = (typeof DISBURSEMENT_MATCH_STATES)[number]
export const DISBURSEMENT_STATE_LABEL: Readonly<Record<DisbursementMatchState, string>> = {
  MATCHED: '已到账且一致',
  SHORT: '到账少于报告',
  OVER: '到账多于报告',
  CURRENCY_DIFFERENT: '币种不同，未比较',
  PENDING_DEPOSIT: '打款日未到',
  AWAITING: '等待登记',
  UNREGISTERED: '超期未登记',
  NO_DEPOSIT_DATE: '报告无打款日',
}

// ---- 响应 ----

export type CashSourceState = 'OK' | 'RESTRICTED' | 'OUT_OF_SCOPE' | 'NOT_CONNECTED'

export interface BalanceRow {
  sellerAccountId: string
  storeName: string
  accountType: string
  label: string
  currency: string
  amount: number
  asOf: string
}
export interface CashflowBalances {
  items: BalanceRow[]
  totals: Array<{ currency: string; amount: number }>
  /** 取不到的余额及原因（可用余额没有官方接口）。 */
  unavailable: Array<{ label: string; note: string }>
}

export interface CashflowDeferral {
  /** 各币种递延中的金额；withMaturity 是其中接口给了预计释放日的笔数。 */
  totals: Array<{ currency: string; amount: number; count: number; withMaturity: number }>
  schedule: DeferralSchedule | null
  released: Array<{ currency: string; amount: number; count: number }>
  releasedDays: number
  note: string
}

export interface PublishedPayout {
  settlementId: string
  externalSettlementId: string
  depositDate: string
  amount: number
  currency: string
}
export interface CashflowPayoutStore {
  sellerAccountId: string
  storeName: string
  currency: string
  cycleDays: number | null
  lagDays: number | null
  samples: number
  lastPeriodEnd: string | null
  published: PublishedPayout[]
  predicted: PredictedPayout[]
  /** 不能预测的原因；能预测为 null。 */
  reason: string | null
}
export interface CashflowPayout {
  stores: CashflowPayoutStore[]
  next: { date: string; amount: number | null; kind: 'PUBLISHED' | 'ESTIMATED'; storeName: string } | null
  /** 近期日均净入账（按币种，来自已释放的交易）；没有近期交易为 null。 */
  dailyRate: number | null
  basis: string
}

export interface CashSourceView {
  state: CashSourceState
  label: string
  note: string
  total: number | null
}

export interface CashflowForecastView {
  currency: string
  modelVersion: string
  weeks: ForecastWeek[]
  sources: CashSourceView[]
  /** 因币种不同没有计入的采购付款与头程费用（不换算汇率）。 */
  excluded: Array<{ label: string; count: number; currencies: string[] }>
  /** 没有日期、排不进任何一周的项。 */
  undated: Array<{ label: string; count: number }>
  assumptions: string[]
}

export interface DisbursementRecord {
  id: string
  disbursedAt: string
  amount: number
  currency: string
  bankLast4: string | null
  note: string | null
  version: number
  createdBy: string
  updatedBy: string
  updatedAt: string
}
export interface DisbursementRow {
  settlementId: string
  externalSettlementId: string
  sellerAccountId: string
  storeName: string
  periodEnd: string | null
  expectedDate: string | null
  expectedAmount: number
  currency: string
  registered: DisbursementRecord | null
  state: DisbursementMatchState
  stateLabel: string
  /** 登记金额 − 报告金额；没登记或币种不同为 null。 */
  diff: number | null
}
export interface CashflowDisbursements {
  items: DisbursementRow[]
  summary: { total: number; matched: number; mismatched: number; awaiting: number; unregistered: number }
  truncated: boolean
}

export interface CashflowResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  asOf: string
  currency: string
  /** 范围内出现过的币种，供页面切换（不换算）。 */
  currencies: string[]
  balances: CashflowBalances
  deferral: CashflowDeferral
  payout: CashflowPayout
  forecast: CashflowForecastView
  disbursements: CashflowDisbursements
  canConfirm: boolean
  freshness: InventoryFreshness
}

export interface DisbursementConfirmResult {
  id: string
  version: number
  created: boolean
  state: DisbursementMatchState
  diff: number | null
}
