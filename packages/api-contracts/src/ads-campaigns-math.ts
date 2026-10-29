import { ADS_CAMPAIGN_TAG_LIMITS, type AdsCampaignRatios, type AdsCampaignRow, type AdsCampaignSort, type AdsTagMode } from './ads-campaigns'
import type { AdsHourlyCell, AdsTermStatus } from './ads-campaigns-tabs'
import { ADS_ANOMALY_RULES } from './ads-overview'
import { adsRatios, budgetUtilizationOf, type AdsTotals } from './ads-overview-math'

// 广告活动页的纯函数（P3-07）：标签、比率、预算利用率、搜索词状态、分时格子、排序、推荐原文的读取。API 与前端共用；全部可空：来源没给的值是 null，不当 0。

export const ADS_WEEKDAY_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

// ---- 标签 ----

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()
const tagKey = (value: string) => collapse(value).toLowerCase()

/** 去掉首尾与重复空白、丢掉空标签、按不分大小写去重（保留先出现的写法）。 */
export function normalizeTags(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const tag = collapse(raw)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    result.push(tag)
  }
  return result
}

/** 按模式改标签：ADD 追加、REMOVE 去掉（不分大小写）、SET 整体替换（空列表就是清空）。 */
export function applyTagChange(current: readonly string[], mode: AdsTagMode, values: readonly string[]): string[] {
  const incoming = normalizeTags(values)
  if (mode === 'SET') return incoming
  if (mode === 'ADD') return normalizeTags([...current, ...incoming])
  const drop = new Set(incoming.map(tagKey))
  return normalizeTags(current).filter(tag => !drop.has(tagKey(tag)))
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const left = normalizeTags(a).map(tagKey).sort()
  const right = normalizeTags(b).map(tagKey).sort()
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

/** 标签合法性：条数与单个长度，不含逗号与控制字符（逗号用来分隔筛选参数）。返回第一条问题；没问题为 null。 */
export function tagProblem(tags: readonly string[]): string | null {
  if (tags.length > ADS_CAMPAIGN_TAG_LIMITS.MAX_TAGS) return `一个活动最多 ${ADS_CAMPAIGN_TAG_LIMITS.MAX_TAGS} 个标签`
  for (const tag of tags) {
    if (tag.length > ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH) return `标签“${tag.slice(0, 8)}…”超过 ${ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH} 个字`
    // eslint-disable-next-line no-control-regex
    if (/[,，\u0000-\u001f]/.test(tag)) return `标签“${tag}”含有逗号或不可见字符`
  }
  return null
}

// ---- 比率与预算 ----

export const ratiosOf = (totals: AdsTotals | null): AdsCampaignRatios | null => (totals ? adsRatios(totals) : null)

/** 花费 ÷ 店铺总销售额；任一项缺失或总销售额不为正为 null。 */
export function adsShareOf(spend: number | null, storeSales: number | null): number | null {
  if (spend === null || storeSales === null || storeSales <= 0) return null
  return spend / storeSales
}

/** 活动自己的预算利用率：只算启用中、日预算且有预算的活动；估算（预算按当前值回看）。 */
export function campaignBudgetUtilization(
  campaign: { state: string; budget: number | null; budgetType: string | null; startDate: string | null; endDate: string | null },
  spend: number | null,
  from: string,
  to: string,
): number | null {
  if (spend === null || campaign.budget === null || campaign.budget <= 0) return null
  if (campaign.budgetType !== 'DAILY' || campaign.state.toUpperCase() !== 'ENABLED') return null
  return budgetUtilizationOf([{ dailyBudget: campaign.budget, spend, startDate: campaign.startDate, endDate: campaign.endDate }], from, to).utilization
}

/** 投放对象或搜索词“花费高但没成交”：花费与点击都达到下限且没有订单（下限是自定默认值）。 */
export function isWastedTarget(
  input: { spend: number | null; clicks: number; orders: number },
  rules: { minSpend: number; minClicks: number } = { minSpend: ADS_ANOMALY_RULES.MIN_SPEND, minClicks: ADS_ANOMALY_RULES.MIN_CLICKS },
): boolean {
  return (input.spend ?? 0) >= rules.minSpend && input.clicks >= rules.minClicks && input.orders === 0
}

// ---- 搜索词 ----

/** 搜索词与投放词的比较口径：不分大小写、合并多余空格。 */
export const termKey = (value: string): string => collapse(value).toLowerCase()

export function termStatus(searchTerm: string, targeted: ReadonlySet<string>, negated: ReadonlySet<string>): AdsTermStatus {
  const key = termKey(searchTerm)
  if (negated.has(key)) return 'NEGATED'
  return targeted.has(key) ? 'TARGETED' : 'UNTARGETED'
}

// ---- 分时 ----

/** 某个时刻在指定时区是周几（周一为 0）与第几个小时。 */
export function weekdayHourOf(at: Date, zone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find(part => part.type === 'weekday')?.value ?? '')
  return { weekday: Math.max(weekday, 0), hour: Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24 }
}

export interface HourlyInput {
  hourStart: Date
  clicks: number
  orders: number
  spend: number | null
  sales: number | null
}

/** 把小时行按“星期 × 小时”累加；没有行的格子不出现（页面写“无数据”，不当 0）。花费与销售额全是空的格子保持空。 */
export function buildHourlyCells(rows: readonly HourlyInput[], zone: string): AdsHourlyCell[] {
  const cells = new Map<string, AdsHourlyCell>()
  for (const row of rows) {
    const { weekday, hour } = weekdayHourOf(row.hourStart, zone)
    const key = `${weekday}|${hour}`
    const cell = cells.get(key) ?? { weekday, hour, spend: null, clicks: 0, orders: 0, sales: null, samples: 0 }
    cell.clicks += row.clicks
    cell.orders += row.orders
    cell.spend = row.spend === null ? cell.spend : (cell.spend ?? 0) + row.spend
    cell.sales = row.sales === null ? cell.sales : (cell.sales ?? 0) + row.sales
    cell.samples += 1
    cells.set(key, cell)
  }
  return [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)
}

/** 热力图某个指标的格子取值：花费、订单（转化）、ACoS、单次点击成本；分母为 0 或缺失为 null。 */
export function hourlyMetricValue(cell: AdsHourlyCell, metric: 'spend' | 'orders' | 'acos' | 'cpc'): number | null {
  if (metric === 'spend') return cell.spend
  if (metric === 'orders') return cell.orders
  if (metric === 'acos') return cell.spend === null || cell.sales === null || cell.sales === 0 ? null : cell.spend / cell.sales
  return cell.spend === null || cell.clicks === 0 ? null : cell.spend / cell.clicks
}

// ---- 库存 ----

export const stockOf = (sellable: number | null): 'OUT_OF_STOCK' | 'IN_STOCK' | 'UNKNOWN' => (sellable === null ? 'UNKNOWN' : sellable <= 0 ? 'OUT_OF_STOCK' : 'IN_STOCK')

// ---- 列表排序 ----

function sortValue(row: AdsCampaignRow, sort: AdsCampaignSort): number | string | null {
  switch (sort) {
    case 'spend':
      return row.totals?.spend ?? null
    case 'sales':
      return row.totals?.sales ?? null
    case 'orders':
      return row.totals ? row.totals.orders : null
    case 'budget':
      return row.budget
    case 'name':
      return row.name.toLowerCase()
    case 'syncedAt':
      return row.syncedAt
    default:
      return row.ratios?.[sort] ?? null
  }
}

/** 列表排序：空值永远排在最后（不论升降序），并列按名称再按编号，保证翻页顺序稳定。普通字符串比较，不用 localeCompare。 */
export function compareCampaignRows(a: AdsCampaignRow, b: AdsCampaignRow, sort: AdsCampaignSort, dir: 'asc' | 'desc'): number {
  const left = sortValue(a, sort)
  const right = sortValue(b, sort)
  if (left === null && right !== null) return 1
  if (left !== null && right === null) return -1
  if (left !== null && right !== null && left !== right) return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1)
  const byName = a.name.toLowerCase()
  const otherName = b.name.toLowerCase()
  if (byName !== otherName) return byName < otherName ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ---- 推荐与预测的原文（结构随亚马逊版本变化，只做保守读取）----

type Json = unknown
const asRecord = (value: Json): Record<string, Json> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Json>) : null)
const asNumber = (value: Json): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** 在推荐原文的顶层与下一层里找第一个能读成数字的指定字段；找不到为 null。 */
export function payloadNumber(payload: Json, keys: readonly string[]): number | null {
  const top = asRecord(payload)
  if (!top) return null
  for (const key of keys) {
    const value = asNumber(top[key])
    if (value !== null) return value
  }
  for (const child of Object.values(top)) {
    const inner = asRecord(child)
    if (!inner) continue
    for (const key of keys) {
      const value = asNumber(inner[key])
      if (value !== null) return value
    }
  }
  return null
}

/** 推荐原文里的一句话说明（title、description、message、summary 里第一个非空文字），最多 200 字。 */
export function payloadSummary(payload: Json): string | null {
  const top = asRecord(payload)
  if (!top) return null
  for (const key of ['title', 'description', 'message', 'summary']) {
    const value = top[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
  }
  return null
}

/** 把预测原文里的数值与短文字展平成“路径 → 值”，最多 limit 个、最深 4 层（不展示原始结构，只给可读的数值字段）。 */
export function flattenFields(value: Json, limit = 24): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = []
  const walk = (node: Json, path: string, depth: number) => {
    if (out.length >= limit || depth > 4) return
    if (typeof node === 'number' && Number.isFinite(node)) out.push({ path, value: String(node) })
    else if (typeof node === 'string' && node.length <= 40 && node.trim() !== '') out.push({ path, value: node })
    else if (Array.isArray(node)) node.slice(0, 8).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1))
    else {
      const record = asRecord(node)
      if (record) for (const [key, child] of Object.entries(record)) walk(child, path ? `${path}.${key}` : key, depth + 1)
    }
  }
  walk(value, '', 0)
  return out
}
