import {
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_STATUS_SEVERITY,
  HEALTH_METRIC_STATUS_LABEL,
  HEALTH_TARGET_CONDITION_TEXT,
  POLICY_ISSUE_KIND_LABEL,
  type AccountStatus,
  type AccountStatusChange,
  type HealthMetricGroup,
  type HealthMetricStatus,
  type HealthMetricView,
  type HealthTargetCondition,
  type OdrBreakdownItem,
  type PolicyIssueKind,
} from './account-health.js'

// 账户健康的纯函数（P5-02）：指标归类与命名、账户状态归一、达标判定、状态变更点。
// 报告的真实字段还没有用真实店铺核对，所以归类按“指标名里的关键词”宽松匹配，认不出的归“其他指标”，原名照样显示。
// 不含 zod，前端首屏可引用。

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

const STATUS_WORDS: Readonly<Record<string, AccountStatus>> = {
  normal: 'NORMAL',
  good: 'NORMAL',
  active: 'NORMAL',
  healthy: 'NORMAL',
  atrisk: 'AT_RISK',
  warning: 'AT_RISK',
  risk: 'AT_RISK',
  deactivated: 'DEACTIVATED',
  deactive: 'DEACTIVATED',
  suspended: 'DEACTIVATED',
  inactive: 'DEACTIVATED',
  blocked: 'DEACTIVATED',
  // 卖家表现报告里最差的一档写作 CRITICAL；这个对应关系没有用真实店铺核对（CR-092 未验证清单），原文仍保留在快照明细里
  critical: 'DEACTIVATED',
}

/** 把报告 / 推送里的账户状态文本归一；认不出的返回 null（不猜成正常）。 */
export function normalizeAccountStatus(raw: unknown): AccountStatus | null {
  if (typeof raw !== 'string') return null
  return STATUS_WORDS[norm(raw)] ?? null
}

/** 指标名里的配送方式后缀（.afn / .mfn）；报告把同一指标按配送方式分开给时入库键带这个后缀。 */
export function splitMetricKey(key: string): { base: string; fulfillment: 'AFN' | 'MFN' | null } {
  const match = /^(.*)\.(afn|mfn)$/i.exec(key)
  if (!match) return { base: key, fulfillment: null }
  return { base: match[1] ?? key, fulfillment: match[2]?.toUpperCase() === 'AFN' ? 'AFN' : 'MFN' }
}

const FULFILLMENT_TEXT = { AFN: '亚马逊配送', MFN: '卖家自配送' } as const

const LABELS: Readonly<Record<string, string>> = {
  accountstatus: '账户状态',
  accounthealthrating: '账户健康评级',
  orderdefectrate: '订单缺陷率',
  negativefeedbackrate: '负面反馈率',
  atozguaranteeclaimsrate: '交易保障索赔率',
  azclaimsrate: '交易保障索赔率',
  chargebackrate: '拒付率',
  lateshipmentrate: '迟发率',
  prefulfillmentcancellationrate: '发货前取消率',
  validtrackingrate: '有效追踪率',
  ontimedeliveryrate: '准时送达率',
  invoicedefectrate: '发票缺陷率',
  customerservicedissatisfactionrate: '客服不满意率',
  returndissatisfactionrate: '退货不满意率',
  intellectualpropertycomplaints: '知识产权投诉',
  intellectualpropertycomplaint: '知识产权投诉',
  productauthenticitycustomercomplaints: '商品真实性投诉',
  productconditioncustomercomplaints: '商品状况投诉',
  productsafetycustomercomplaints: '商品安全投诉',
  listingpolicyviolations: '上架政策违规',
  restrictedproductpolicyviolations: '受限商品政策违规',
  reviewpolicyviolations: '评论政策违规',
  suspectedintellectualpropertyviolations: '疑似知识产权违规',
  otherpolicyviolations: '其他政策违规',
}

/** 指标的中文名：认得的用中文名（带配送方式后缀），认不得的显示报告里的原名。 */
export function healthMetricLabel(key: string): string {
  const { base, fulfillment } = splitMetricKey(key)
  const name = LABELS[norm(base)] ?? base
  return fulfillment ? `${name}（${FULFILLMENT_TEXT[fulfillment]}）` : name
}

const ODR_WORDS = ['orderdefect', 'negativefeedback', 'chargeback', 'atoz', 'guaranteeclaim', 'azclaim']
const POLICY_WORDS = ['policy', 'intellectual', 'authenticity', 'safety', 'restricted', 'violation', 'complaint']

/** 指标归类：账户状态、评级、订单缺陷、政策合规，其余归其他。 */
export function classifyHealthMetric(key: string): HealthMetricGroup {
  const name = norm(splitMetricKey(key).base)
  if (name === 'accountstatus') return 'STATUS'
  if (name === 'accounthealthrating') return 'RATING'
  if (ODR_WORDS.some(word => name.includes(word))) return 'ORDER_DEFECT'
  if (POLICY_WORDS.some(word => name.includes(word))) return 'POLICY'
  return 'OTHER'
}

const CONDITION_WORDS: Readonly<Record<string, HealthTargetCondition>> = {
  lt: 'LT',
  lessthan: 'LT',
  below: 'LT',
  lte: 'LTE',
  lessthanorequal: 'LTE',
  lessthanorequalto: 'LTE',
  atmost: 'LTE',
  gt: 'GT',
  greaterthan: 'GT',
  above: 'GT',
  gte: 'GTE',
  greaterthanorequal: 'GTE',
  greaterthanorequalto: 'GTE',
  atleast: 'GTE',
  eq: 'EQ',
  equal: 'EQ',
  equals: 'EQ',
}

/** 目标条件归一（报告可能给符号或英文词）；认不出的返回 null。 */
export function normalizeTargetCondition(raw: unknown): HealthTargetCondition | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '<') return 'LT'
  if (text === '<=') return 'LTE'
  if (text === '>') return 'GT'
  if (text === '>=') return 'GTE'
  if (text === '=' || text === '==') return 'EQ'
  return CONDITION_WORDS[norm(text)] ?? null
}

/** 达标判定：报告没给目标或条件就是“报告没给目标”，不替报告下结论；值缺失同样不判定。 */
export function judgeHealthMetric(value: number | null, target: number | null, condition: HealthTargetCondition | null): HealthMetricStatus {
  if (value === null || target === null || condition === null) return 'UNKNOWN'
  const met = condition === 'LT' ? value < target : condition === 'LTE' ? value <= target : condition === 'GT' ? value > target : condition === 'GTE' ? value >= target : value === target
  return met ? 'MET' : 'NOT_MET'
}

const trimNumber = (value: number) => String(Number(value.toFixed(4)))

/** 指标值的显示文本：比率（RATIO，报告给小数，0.0085 = 0.85%）按百分比，计数原样；没有值返回“尚无记录”，不显示 0。 */
export function formatHealthValue(value: number | null, unit: string | null): string {
  if (value === null) return '尚无记录'
  return unit === 'RATIO' ? `${trimNumber(value * 100)}%` : trimNumber(value)
}

/** 目标的人话描述，例如“不高于 1%”。 */
export function targetText(target: number | null, condition: HealthTargetCondition | null, unit: string | null): string | null {
  if (target === null || condition === null) return null
  return `${HEALTH_TARGET_CONDITION_TEXT[condition]} ${formatHealthValue(target, unit)}`
}

export interface MetricRowInput {
  metricKey: string
  metricGroup: HealthMetricGroup
  value: number | null
  target: number | null
  targetCondition: HealthTargetCondition | null
  status: HealthMetricStatus
  unit: string | null
  windowDays: number | null
}

export function toMetricView(row: MetricRowInput): HealthMetricView {
  return {
    key: row.metricKey,
    label: healthMetricLabel(row.metricKey),
    group: row.metricGroup,
    value: row.value,
    target: row.target,
    targetCondition: row.targetCondition,
    targetText: targetText(row.target, row.targetCondition, row.unit),
    status: row.status,
    statusLabel: HEALTH_METRIC_STATUS_LABEL[row.status],
    unit: row.unit,
    windowDays: row.windowDays,
  }
}

const RATING_STATUS_LABEL: Readonly<Record<string, string>> = { good: '良好', fair: '一般', atrisk: '有风险', critical: '严重' }

/** 账户健康评级状态的中文名；认不得的显示报告原文。 */
export const ratingStatusLabel = (status: string | null): string | null => (status ? (RATING_STATUS_LABEL[norm(status)] ?? status) : null)

/** 订单缺陷率的三个构成项（报告分项给了才显示数字）。 */
export const ODR_BREAKDOWN_DEFS = [
  { key: 'NEGATIVE_FEEDBACK', label: '负面反馈', word: 'negativefeedback' },
  { key: 'CLAIMS', label: '交易保障索赔', word: 'claim' },
  { key: 'CHARGEBACK', label: '拒付', word: 'chargeback' },
] as const

/** 订单缺陷率本身（总的那一项）：键名以 orderDefectRate 开头。 */
export const isOrderDefectTotal = (key: string) => norm(splitMetricKey(key).base) === 'orderdefectrate'

/** 从订单缺陷分组的指标里挑出三个构成项；报告没有分项给的，note 写明“报告未分项给出”，不用 0 代替。 */
export function orderDefectBreakdown(metrics: HealthMetricView[]): OdrBreakdownItem[] {
  return ODR_BREAKDOWN_DEFS.map(def => {
    const hit = metrics.find(metric => norm(splitMetricKey(metric.key).base).includes(def.word) && !isOrderDefectTotal(metric.key))
    return { key: def.key, label: def.label, metric: hit ?? null, note: hit ? null : '报告未分项给出' }
  })
}

const POLICY_KIND_WORDS: readonly [string, PolicyIssueKind][] = [
  ['intellectualproperty', 'IP_COMPLAINT'],
  ['authenticity', 'AUTHENTICITY'],
  ['counterfeit', 'AUTHENTICITY'],
  ['safety', 'PRODUCT_SAFETY'],
  ['restricted', 'RESTRICTED_PRODUCT'],
  ['listingpolic', 'LISTING_POLICY'],
  ['reviewpolic', 'REVIEW_POLICY'],
  ['condition', 'CONDITION'],
]

/** 政策问题归类：先认报告给的类型 / 指标名，再认标题；认不出归“其他”。 */
export function classifyPolicyKind(...texts: (string | null | undefined)[]): PolicyIssueKind {
  for (const text of texts) {
    if (!text) continue
    const name = norm(text)
    const hit = POLICY_KIND_WORDS.find(([word]) => name.includes(word))
    if (hit) return hit[1]
  }
  return 'OTHER'
}

/** 状态变更点：输入按日期升序的每日状态，输出每次变化（含第一天，previous 为 null）。 */
export function accountStatusChanges(days: { date: string; status: AccountStatus }[]): AccountStatusChange[] {
  const changes: AccountStatusChange[] = []
  let previous: AccountStatus | null = null
  for (const day of days) {
    if (day.status !== previous) {
      changes.push({
        date: day.date,
        status: day.status,
        label: ACCOUNT_STATUS_LABEL[day.status],
        previousStatus: previous,
        previousLabel: previous ? ACCOUNT_STATUS_LABEL[previous] : null,
        worse: previous !== null && ACCOUNT_STATUS_SEVERITY[day.status] > ACCOUNT_STATUS_SEVERITY[previous],
      })
      previous = day.status
    }
  }
  return changes
}

export const policyKindLabel = (kind: PolicyIssueKind) => POLICY_ISSUE_KIND_LABEL[kind]
