import type { AlertEvidenceRow } from '@nova/api-contracts'

// 预警证据的展示（09 章 9.1 预警详情）：评估器把命中时的依据写进 AlertInstance.evidenceJson，形状各不相同。
// 这里只展示登记过中文名的键（不在表里的键一律不显示，避免出现内部字段名），数值按含义格式化；
// 买家个人信息、令牌之类不会被评估器写进证据，这里也不会展示任何没有登记的字段。

type Kind = 'text' | 'int' | 'num' | 'money' | 'percent' | 'times' | 'date' | 'datetime' | 'bool' | 'list' | 'enum'

const FIELDS: Readonly<Record<string, readonly [string, Kind]>> = {
  storeName: ['店铺', 'text'],
  store: ['店铺', 'text'],
  sku: ['SKU', 'text'],
  asin: ['ASIN', 'text'],
  title: ['商品标题', 'text'],
  campaignName: ['广告活动', 'text'],
  adProduct: ['广告产品', 'text'],
  provider: ['汇率来源', 'text'],
  switchLabel: ['写入开关', 'text'],
  sourceLabel: ['数据来源', 'text'],
  source: ['数据来源', 'text'],
  settlementId: ['结算单', 'text'],
  shipmentRef: ['货件', 'text'],
  feeKindLabel: ['费用类别', 'text'],
  ruleLabel: ['机会类型', 'text'],
  fieldLabel: ['修改项', 'text'],
  actorLabel: ['修改人', 'text'],
  stateLabel: ['价格健康状态', 'text'],
  resultStatus: ['报价结果', 'text'],
  servingStatus: ['投放状态', 'text'],
  budgetType: ['预算类型', 'text'],
  strandedReason: ['滞留原因', 'text'],
  lostReason: ['失去原因', 'enum'],
  currentTier: ['当前收费档', 'text'],
  previousTier: ['上一收费档', 'text'],
  period: ['周期', 'text'],
  range: ['统计区间', 'text'],
  recentRange: ['最近区间', 'text'],
  baselineRange: ['基线区间', 'text'],
  kind: ['类型', 'enum'],
  risk: ['风险等级', 'enum'],
  state: ['状态', 'enum'],
  status: ['同步状态', 'enum'],
  errorCode: ['错误代码', 'text'],
  errorMessage: ['失败原因', 'text'],
  autoDisabledReason: ['自动关闭原因', 'text'],
  before: ['修改前', 'text'],
  after: ['修改后', 'text'],
  noncomplianceTypes: ['不合规类型', 'list'],
  skus: ['涉及 SKU', 'list'],
  noDemand: ['近期没有销量', 'bool'],
  byOthers: ['他人修改', 'bool'],
  sellable: ['可售（件）', 'int'],
  inboundCounted: ['已计入在途（件）', 'int'],
  strandedQty: ['滞留（件）', 'int'],
  qty: ['数量（件）', 'int'],
  soldUnits: ['销售（件）', 'int'],
  returnedUnits: ['退货（件）', 'int'],
  overUnits: ['多收（件）', 'int'],
  shortUnits: ['少收（件）', 'int'],
  orders: ['订单数', 'int'],
  clicks: ['点击', 'int'],
  baselineClicks: ['基线点击', 'int'],
  recentClicks: ['最近点击', 'int'],
  itemCount: ['涉及条数', 'int'],
  skuCount: ['涉及 SKU 数', 'int'],
  changeCount: ['修改次数', 'int'],
  risingCount: ['上升的主题数', 'int'],
  openExceptions: ['未解决异常数', 'int'],
  consecutiveFailures: ['连续失败次数', 'int'],
  failureThreshold: ['预警阈值（次）', 'int'],
  calls7d: ['近 7 天写调用', 'int'],
  failures7d: ['近 7 天失败', 'int'],
  windowDays: ['回看天数', 'int'],
  lookbackDays: ['回看天数', 'int'],
  spendDays: ['有花费的天数', 'int'],
  daysLeft: ['剩余天数', 'int'],
  daysOfCover: ['可售天数', 'num'],
  targetDays: ['目标覆盖天数', 'num'],
  fastestLeadDays: ['最快补货天数', 'num'],
  policyVersion: ['库存规则版本', 'int'],
  hoursSinceSuccess: ['距上次成功（小时）', 'int'],
  hoursBehind: ['已落后（小时）', 'num'],
  thresholdHours: ['预警阈值（小时）', 'num'],
  tokenMaxAgeDays: ['授权最长年龄（天）', 'int'],
  dailyDemand: ['日均需求（件）', 'num'],
  spend: ['花费', 'money'],
  recentSpend: ['最近花费', 'money'],
  sales: ['广告销售额', 'money'],
  budget: ['预算', 'money'],
  recentCpc: ['最近单次点击成本', 'money'],
  baselineCpc: ['基线单次点击成本', 'money'],
  extraSpend: ['多花费', 'money'],
  dailyWaste: ['日均浪费', 'money'],
  diffAmount: ['差额', 'money'],
  systemAmount: ['系统金额', 'money'],
  officialAmount: ['官方金额', 'money'],
  estimatedAmount: ['估算金额', 'money'],
  estimatedIncrease: ['预计增加', 'money'],
  overchargeTotal: ['疑似多收合计', 'money'],
  nextMonthStorage: ['下月预估仓储费', 'money'],
  fee: ['费用', 'money'],
  ownPrice: ['我方价格', 'money'],
  expectedPrice: ['预期价格', 'money'],
  featuredPrice: ['推荐报价价格', 'money'],
  gap: ['价差', 'money'],
  acos: ['广告成本销售比', 'percent'],
  acosThreshold: ['成本销售比阈值', 'percent'],
  rate: ['退货率', 'percent'],
  gapRatio: ['价格高出比例', 'percent'],
  ratio: ['突增倍数', 'times'],
  threshold: ['阈值', 'num'],
  snapshotDate: ['快照日期', 'date'],
  planningDate: ['规划日期', 'date'],
  checkedOn: ['核查日期', 'date'],
  changedOn: ['修改日期', 'date'],
  stockoutDate: ['预计断货日', 'date'],
  fastestReplenishDate: ['最快补货到仓日', 'date'],
  deadline: ['申请期限', 'date'],
  earliestDate: ['最早日期', 'date'],
  latestDate: ['最晚日期', 'date'],
  previousDate: ['上一次日期', 'date'],
  lastAttemptAt: ['最近尝试', 'datetime'],
  lastSuccessAt: ['最近成功', 'datetime'],
  lastChangedAt: ['最近修改', 'datetime'],
  lastFeaturedAt: ['最近获得推荐报价', 'datetime'],
  lostAt: ['失去时间', 'datetime'],
  firstSeenAt: ['首次发现', 'datetime'],
  occurredAt: ['发生时间', 'datetime'],
  authorizedAt: ['最近授权', 'datetime'],
  expiresAt: ['预计失效', 'datetime'],
  closedAt: ['关闭时间', 'datetime'],
  statusUpdatedAt: ['状态更新', 'datetime'],
}

const ENUM_LABELS: Readonly<Record<string, string>> = {
  HIGH: '高风险',
  MEDIUM: '中风险',
  EXCESS: '冗余',
  SHORT: '少收',
  OVER: '多收',
  NONCOMPLIANCE: '不合规',
  NEW: '新进入前 10',
  MENTIONS_UP: '提及量上升',
  RANK_UP: '名次上升',
  ISSUE: '刊登问题',
  COMPLIANCE: '合规',
  SEARCH_SUPPRESSED: '搜索抑制',
  NO_SALES: '花费没有带来销售额',
  HIGH_ACOS: '广告成本销售比过高',
  EXPIRED: '授权已失效',
  EXPIRING: '授权即将失效',
  FAILED: '失败',
  UNAUTHORIZED: '未授权',
  PRICE: '价格高于推荐报价',
  OTHER: '其他原因',
  UNKNOWN: '未知',
  ABOVE_EXPECTED: '价格高于预期',
  LOST_ELIGIBILITY: '因价格失去资格',
}

const trim = (value: number, digits: number) => String(Math.round(value * 10 ** digits) / 10 ** digits)
const pad = (value: number) => String(value).padStart(2, '0')

function datetimeText(value: string): string | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

function scalar(kind: Kind, value: unknown, currency: string, siblings: Record<string, unknown>, key: string): string | null {
  if (kind === 'bool') return typeof value === 'boolean' ? (value ? '是' : '否') : null
  if (kind === 'list') return Array.isArray(value) ? value.filter(item => typeof item === 'string' || typeof item === 'number').join('、') || null : null
  if (typeof value === 'string') {
    // 数值类的字段拿到字符串说明评估器写错了类型：不展示，而不是把乱码当成数字
    if (value.trim() === '' || !['text', 'enum', 'datetime', 'date'].includes(kind)) return null
    if (kind === 'datetime') return datetimeText(value)
    if (kind === 'enum') return ENUM_LABELS[value] ?? value
    return value.length > 300 ? `${value.slice(0, 300)}…` : value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  switch (kind) {
    case 'money':
      return `${currency} ${value.toFixed(2)}`
    case 'percent':
      return `${trim(value * 100, 1)}%`
    case 'times':
      return `${trim(value, 2)} 倍`
    case 'int':
      return String(Math.round(value))
    default:
      // 阈值的含义随规则而变：退货率的阈值是比例，单次点击成本的阈值是倍数
      if (key === 'threshold' && 'rate' in siblings) return `${trim(value * 100, 1)}%`
      if (key === 'threshold' && 'ratio' in siblings) return `${trim(value, 2)} 倍`
      return trim(value, 2)
  }
}

type Item = Record<string, unknown>
const objects = (value: unknown): Item[] => (Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [])
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/** 嵌套的证据（分档、明细、主题、修改记录）：每项一行文字，最多 8 项。 */
const NESTED: Readonly<Record<string, readonly [string, (item: Item) => string]>> = {
  tiers: ['即将跨档的库存', item => `${text(item.qty)} 件 → ${text(item.toLabel)}（${text(item.boundaryDays)} 天，最晚 ${text(item.latestDate)}）`],
  top: ['金额最大的几项', item => `${text(item.subject)}：${text(item.amount)}`],
  topics: ['上升的主题', item => `${text(item.topic)}（${text(item.kindLabel)}）`],
  changes: ['修改记录', item => `${text(item.fieldLabel)}：${text(item.before) || '空'} → ${text(item.after) || '空'}（${text(item.actorLabel)}）`],
}

export function formatEvidence(evidence: unknown): AlertEvidenceRow[] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return []
  const source = evidence as Record<string, unknown>
  const currency = typeof source.currency === 'string' && /^[A-Z]{3}$/.test(source.currency) ? source.currency : 'USD'
  const rows: AlertEvidenceRow[] = []
  const labelsSeen = new Set<string>()
  const push = (label: string, value: string | null) => {
    if (value === null || labelsSeen.has(label)) return
    labelsSeen.add(label)
    rows.push({ label, value })
  }
  for (const [key, value] of Object.entries(source)) {
    const nested = NESTED[key]
    if (nested) {
      const lines = objects(value).slice(0, 8).map(nested[1])
      push(nested[0], lines.length > 0 ? lines.join('；') : null)
      continue
    }
    if (key === 'measuredCm' && Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number')) {
      push('亚马逊测量尺寸（厘米）', value.join(' × '))
      continue
    }
    if (key === 'topReason' && value && typeof value === 'object') {
      const reason = value as Item
      push('最主要的退货原因', text(reason.label) ? `${text(reason.label)}（${text(reason.units)} 件）` : null)
      continue
    }
    const field = FIELDS[key]
    if (field) push(field[0], scalar(field[1], value, currency, source, key))
  }
  return rows
}
