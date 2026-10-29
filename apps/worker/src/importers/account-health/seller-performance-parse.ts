import { createHash } from 'node:crypto'
import { NonRetryableError } from '@nova/workflow'
import {
  ACCOUNT_HEALTH_LIMITS,
  SELLER_PERFORMANCE_REPORT_TYPE,
  classifyPolicyKind,
  normalizeAccountStatus,
  normalizeTargetCondition,
  splitMetricKey,
  type AccountStatus,
  type HealthTargetCondition,
  type PolicyIssueKind,
} from '@nova/api-contracts'

// 卖家表现报告（importers.md R-42，GET_V2_SELLER_PERFORMANCE_REPORT）的解析（P5-02）：纯函数，不碰数据库。
// 报告是 JSON，真实字段没有用真实店铺逐项核对（CR-092 未验证清单），所以解析是“宽松但不猜”的：
//   - accountStatuses：按站点取账户状态（GOOD→正常、AT_RISK→有风险、CRITICAL→停用，原文保留在 detail）；
//   - performanceMetrics：递归找“带数值的指标对象”（rate / value / count 之类），配送方式（afn / mfn）折成键的后缀；
//     报告自带的目标值与比较条件原样入库，缺了任何一个就不判定达标；
//   - 名字里带 violation / complaint / issue / defect / policy 的对象数组：当作政策合规问题条目，没有编号就按内容生成稳定的编号；
//   - 一个站点标识不是美国站的容器直接跳过；认不出的字段忽略，但整份报告一项都认不出就以 PARSE_HEADER 失败并留存原始文件，不当作“账户一切正常”。

const US = 'ATVPDKIKX0DER'
const MAX_DEPTH = 4
const MAX_DETAIL_FIELDS = 12
const SKIP_KEYS = new Set(['marketplaceid', 'reportdate', 'reportversion', 'reporttype', 'daterange', 'reportingdaterange', 'timeperiod', 'accountstatuses', 'performancemetrics'])
const VALUE_KEYS = ['rate', 'value', 'defectrate', 'percentage', 'count', 'defectscount', 'total', 'score']
const TARGET_KEYS = ['targetvalue', 'target', 'threshold', 'goal']
const CONDITION_KEYS = ['targetcondition', 'condition', 'comparison', 'operator']
const WINDOW_KEYS = ['windowdays', 'timeperiod', 'numberofdays', 'reportingperiod']
const ISSUE_KEY_PATTERN = /(violation|complaint|issue|defect|policy|suspen|warning)/
const ID_KEYS = ['issueid', 'id', 'violationid', 'complaintid', 'defectid', 'caseid', 'referenceid', 'notificationid']
const TITLE_KEYS = ['title', 'name', 'description', 'reason', 'policyname', 'violationtype', 'type', 'summary']
const DATE_KEYS = ['createddate', 'date', 'reporteddate', 'firstseen', 'openeddate', 'creationdate', 'receiveddate']
const ASIN_KEYS = ['asin', 'asins', 'affectedasins', 'childasin', 'parentasin']
const IMPACT_KEYS = ['impact', 'effect', 'action', 'consequence']
const RATING_KEYS = ['accounthealthrating', 'ahr']

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export interface ParsedMetric {
  metricKey: string
  value: number
  target: number | null
  targetCondition: HealthTargetCondition | null
  unit: 'RATIO' | 'COUNT'
  windowDays: number | null
  detail: Record<string, string | number | boolean>
}

export interface ParsedIssue {
  issueId: string
  kind: PolicyIssueKind
  title: string
  asins: string[]
  impactText: string | null
  firstSeenAt: Date | null
  detail: Record<string, string | number | boolean>
}

export interface ParsedPerformanceReport {
  status: { status: AccountStatus | null; raw: string | null } | null
  rating: { score: number | null; status: string | null } | null
  metrics: ParsedMetric[]
  issues: ParsedIssue[]
  /** 报告里有“问题条目数组”这一节（可以是空的）；没有这一节时不据此解决任何问题。 */
  hasIssueSection: boolean
}

/** 取对象里第一个出现的键（键名按小写去符号比较）。 */
function pick(record: Record<string, unknown>, names: readonly string[]): unknown {
  const wanted = new Set(names)
  for (const [key, value] of Object.entries(record)) if (wanted.has(norm(key)) && value !== null && value !== undefined && value !== '') return value
  return undefined
}

/** 数值：数字原样；字符串去掉千分位，带百分号的除以 100（比率统一成小数）；其余返回 null。 */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/,/g, '')
  const percent = text.endsWith('%')
  const cleaned = percent ? text.slice(0, -1).trim() : text
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const parsed = Number(cleaned)
  return percent ? parsed / 100 : parsed
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null)

function scalarDetail(record: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(record)) {
    if (Object.keys(out).length >= MAX_DETAIL_FIELDS) break
    if (skip.has(norm(key))) continue
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 200)
  }
  return out
}

/** 站点过滤：容器带站点标识且不是美国站就跳过；没带标识的一律当美国站。 */
const isOtherMarket = (container: Record<string, unknown>, marketplaceId: string) => {
  const id = textOf(pick(container, ['marketplaceid']))
  return id !== null && id !== marketplaceId
}

function windowDaysOf(record: Record<string, unknown>): number | null {
  const raw = pick(record, WINDOW_KEYS)
  const match = raw === undefined ? null : /(\d{1,4})/.exec(String(raw))
  const days = match ? Number(match[1]) : null
  return days !== null && days > 0 && days <= 3650 ? days : null
}

/** 指标键：路径里的普通段拼成驼峰，afn / mfn 段折成 .afn / .mfn 后缀。 */
function metricKeyOf(path: readonly string[]): string {
  const fulfillment = path.filter(segment => /^(afn|mfn)$/i.test(segment)).pop()
  const names = path.filter(segment => !/^(afn|mfn)$/i.test(segment))
  const base = names.map((segment, index) => (index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1))).join('')
  return fulfillment ? `${base}.${fulfillment.toLowerCase()}` : base
}

function leafOf(path: readonly string[], record: Record<string, unknown>): ParsedMetric | null {
  const value = numberOf(pick(record, VALUE_KEYS))
  if (value === null) return null
  const key = metricKeyOf(path)
  const ratio = /rate$/.test(norm(splitMetricKey(key).base)) || pick(record, ['rate', 'defectrate']) !== undefined
  const valueKeys = new Set([...VALUE_KEYS, ...TARGET_KEYS, ...CONDITION_KEYS, ...WINDOW_KEYS])
  return {
    metricKey: key.slice(0, 120),
    value,
    target: numberOf(pick(record, TARGET_KEYS)),
    targetCondition: normalizeTargetCondition(pick(record, CONDITION_KEYS)),
    unit: ratio ? 'RATIO' : 'COUNT',
    windowDays: windowDaysOf(record),
    detail: scalarDetail(record, valueKeys),
  }
}

function collectMetrics(path: readonly string[], value: unknown, depth: number, out: ParsedMetric[]): void {
  if (path.length > 0 && typeof value === 'number') {
    const key = metricKeyOf(path)
    if (Number.isFinite(value)) out.push({ metricKey: key.slice(0, 120), value, target: null, targetCondition: null, unit: /rate$/.test(norm(key)) ? 'RATIO' : 'COUNT', windowDays: null, detail: {} })
    return
  }
  if (!isObject(value) || depth > MAX_DEPTH) return
  const leaf = path.length > 0 ? leafOf(path, value) : null
  if (leaf) out.push(leaf)
  for (const [key, child] of Object.entries(value)) {
    const name = norm(key)
    if (SKIP_KEYS.has(name) || VALUE_KEYS.includes(name) || TARGET_KEYS.includes(name) || CONDITION_KEYS.includes(name) || WINDOW_KEYS.includes(name)) continue
    // 指标对象自己的数字字段（订单数、件数等）进 detail，不当作独立指标；只有嵌套的子对象才继续往下找
    if (isObject(child) || (typeof child === 'number' && !leaf)) collectMetrics([...path, key], child, depth + 1, out)
  }
}

function asinsOf(record: Record<string, unknown>): string[] {
  const raw = pick(record, ASIN_KEYS)
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\s]+/) : []
  const asins = list.map(item => (typeof item === 'string' ? item.trim().toUpperCase() : '')).filter(item => /^[A-Z0-9]{10}$/.test(item))
  return [...new Set(asins)].slice(0, ACCOUNT_HEALTH_LIMITS.asinsMax)
}

function issueOf(arrayKey: string, record: Record<string, unknown>): ParsedIssue {
  const title = (textOf(pick(record, TITLE_KEYS)) ?? arrayKey).slice(0, ACCOUNT_HEALTH_LIMITS.titleMax)
  const asins = asinsOf(record)
  const given = textOf(pick(record, ID_KEYS))
  const dateRaw = textOf(pick(record, DATE_KEYS))
  const date = dateRaw ? new Date(dateRaw) : null
  const issueId = given
    ? given.slice(0, 120)
    : `h:${createHash('sha256')
        .update([norm(arrayKey), title, [...asins].sort().join(','), JSON.stringify(scalarDetail(record))].join('\u001f'))
        .digest('hex')
        .slice(0, 24)}`
  const kindText = textOf(pick(record, ['kind', 'category', 'violationtype', 'type']))
  return {
    issueId,
    kind: classifyPolicyKind(arrayKey, kindText, title),
    title,
    asins,
    impactText: textOf(pick(record, IMPACT_KEYS))?.slice(0, ACCOUNT_HEALTH_LIMITS.impactMax) ?? null,
    firstSeenAt: date && !Number.isNaN(date.getTime()) ? date : null,
    detail: { source: arrayKey, ...scalarDetail(record) },
  }
}

/** 返回是否见到了“问题条目数组”这一节（哪怕是空数组）：只有见到了，才能据此判断“报告里不再出现的问题已解决”。 */
function collectIssues(container: Record<string, unknown>, out: ParsedIssue[], depth = 0): boolean {
  let section = false
  for (const [key, value] of Object.entries(container)) {
    if (SKIP_KEYS.has(norm(key))) continue
    if (Array.isArray(value) && ISSUE_KEY_PATTERN.test(norm(key))) {
      section = true
      for (const item of value) if (isObject(item)) out.push(issueOf(key, item))
    } else if (isObject(value) && depth < 2) section = collectIssues(value, out, depth + 1) || section
  }
  return section
}

function statusOf(root: Record<string, unknown>, marketplaceId: string): ParsedPerformanceReport['status'] {
  const list = root.accountStatuses
  if (Array.isArray(list)) {
    const items = list.filter(isObject).filter(item => !isOtherMarket(item, marketplaceId))
    const item = items.find(entry => textOf(pick(entry, ['marketplaceid'])) === marketplaceId) ?? items[0]
    if (item) {
      const raw = textOf(pick(item, ['status', 'accountstatus']))
      return { status: normalizeAccountStatus(raw), raw }
    }
  }
  const direct = textOf(pick(root, ['accountstatus']))
  return direct ? { status: normalizeAccountStatus(direct), raw: direct } : null
}

function ratingOf(root: Record<string, unknown>): ParsedPerformanceReport['rating'] {
  const raw = pick(root, RATING_KEYS)
  if (raw === undefined) return null
  if (isObject(raw)) return { score: numberOf(pick(raw, ['score', 'ahrscore', 'value', 'rating'])), status: textOf(pick(raw, ['status', 'ahrstatus', 'ratingstatus'])) }
  const score = numberOf(raw)
  return score !== null ? { score, status: null } : { score: null, status: textOf(raw) }
}

/** 解析整份报告；一项都认不出时抛 PARSE_HEADER（调用方会留存原始文件）。 */
export function parseSellerPerformance(raw: unknown, marketplaceId: string = US): ParsedPerformanceReport {
  if (!isObject(raw)) throw new NonRetryableError('PARSE_HEADER', `${SELLER_PERFORMANCE_REPORT_TYPE} 的内容不是 JSON 对象，报告格式可能已变化`)
  const metrics: ParsedMetric[] = []
  const issues: ParsedIssue[] = []
  const containers = Array.isArray(raw.performanceMetrics) ? raw.performanceMetrics.filter(isObject) : isObject(raw.performanceMetrics) ? [raw.performanceMetrics] : [raw]
  let hasIssueSection = false
  for (const container of containers.filter(item => !isOtherMarket(item, marketplaceId))) {
    collectMetrics([], container, 0, metrics)
    hasIssueSection = collectIssues(container, issues) || hasIssueSection
  }
  if (containers[0] !== raw) hasIssueSection = collectIssues(raw, issues) || hasIssueSection
  // 同一个指标键只留第一份（多个容器重复给同一指标时不让后者悄悄覆盖前者）
  const seen = new Set<string>()
  const unique = metrics.filter(metric => (seen.has(metric.metricKey) ? false : (seen.add(metric.metricKey), true)))
  const seenIssues = new Set<string>()
  const uniqueIssues = issues.filter(issue => (seenIssues.has(issue.issueId) ? false : (seenIssues.add(issue.issueId), true)))
  const result: ParsedPerformanceReport = { status: statusOf(raw, marketplaceId), rating: ratingOf(raw), metrics: unique, issues: uniqueIssues, hasIssueSection }
  if (!result.status && !result.rating && result.metrics.length === 0 && result.issues.length === 0)
    throw new NonRetryableError('PARSE_HEADER', `${SELLER_PERFORMANCE_REPORT_TYPE} 里没有认出账户状态、评级、指标或问题条目，报告格式可能已变化`)
  return result
}
