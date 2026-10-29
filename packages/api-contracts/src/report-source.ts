import type { MetricDefinition } from './metrics-catalog.js'
import { METRIC_DEFINITIONS } from './metrics-catalog.js'
import { expressionText } from './metric-expr.js'
import { PP_DIMENSION_LABEL, PP_DIMENSIONS, PP_METRICS, PP_PERMISSION, type PpMetricKey } from './product-performance.js'
import { PROFIT_DIMENSIONS } from './profit-view.js'

// 自定义报表数据源（P6-32）：代码登记，不建表。查询必须复用各模块已有的查询服务，这里只声明维度、指标与权限。
// 没有字典编号的列可以当报表列，但不能被公式引用。

export const REPORT_PAGE_MAX = 200
export const CUSTOM_RANGE_MAX_DAYS = 366
export const REPORT_QUERY_TIMEOUT_MS = 8_000
export const REPORT_EXPORT_ROW_MAX = 2000
export const REPORT_EXPORT_TIMEOUT_MS = 20_000
export const CUSTOM_METRIC_MAX = 100
export const CUSTOM_REPORT_MAX = 100
export const REPORTS_READ = 'reports.read'
export const REPORTS_CUSTOM_WRITE = 'reports.custom.write'
export const REPORTS_CUSTOM_SHARE = 'reports.custom.share'

export type ReportFormat = 'money' | 'number' | 'percent' | 'decimal'

export interface SourceColumn {
  key: string
  label: string
  metricId: string | null
  format: ReportFormat
}

export interface SourceDimension {
  code: string
  label: string
}

export interface ReportSourceSpec {
  code: string
  name: string
  permission: string
  dimensions: SourceDimension[]
  columns: SourceColumn[]
}

const column = (key: string, label: string, metricId: string | null, format: ReportFormat): SourceColumn => ({ key, label, metricId, format })

const ppColumns = (): SourceColumn[] =>
  (Object.keys(PP_METRICS) as PpMetricKey[]).flatMap(key => {
    const info = PP_METRICS[key]
    const metricId = 'metric' in info ? info.metric : undefined
    if (!metricId || ('slow' in info && info.slow) || 'gap' in info) return []
    return [column(key, info.label, metricId, info.format)]
  })

export const CUSTOM_REPORT_SOURCES: readonly ReportSourceSpec[] = [
  {
    code: 'product-performance',
    name: '商品表现',
    permission: PP_PERMISSION,
    dimensions: PP_DIMENSIONS.map(code => ({ code, label: PP_DIMENSION_LABEL[code] })),
    columns: ppColumns(),
  },
  {
    code: 'order-profit',
    name: '订单利润',
    permission: 'profit.read',
    dimensions: PROFIT_DIMENSIONS.map(code => ({ code, label: code === 'PARENT' ? '父 ASIN' : code })),
    columns: [
      column('revenue', '利润口径收入', null, 'money'),
      column('units', '销量件数', null, 'number'),
      column('profit', '净利润', 'M-005', 'money'),
      column('margin', '利润率', 'M-006', 'percent'),
      column('adsAllocated', '分摊广告花费', 'M-007', 'money'),
    ],
  },
  {
    code: 'ads',
    name: '广告',
    permission: 'ads.read',
    dimensions: [{ code: 'campaign', label: '广告活动' }],
    columns: [
      column('spend', '广告花费', 'M-007', 'money'),
      column('sales', '广告销售额', 'M-500', 'money'),
      column('orders', '广告订单', null, 'number'),
      column('acos', '广告成本销售比', 'M-501', 'percent'),
    ],
  },
  {
    code: 'inventory',
    name: '库存',
    permission: 'inventory.read',
    dimensions: [{ code: 'sku', label: 'SKU' }],
    columns: [column('sellable', '可售总量', 'M-200', 'number'), column('inbound', '在途总量', 'M-201', 'number'), column('daysOfCover', '我方可售天数', 'M-206', 'decimal')],
  },
  {
    code: 'returns',
    name: '退货',
    permission: 'returns.read',
    dimensions: [{ code: 'case', label: '退货单' }],
    columns: [column('quantity', '退货件数', null, 'number'), column('refundAmount', '退款金额', null, 'money')],
  },
]

export const sourceByCode = (code: string): ReportSourceSpec | undefined => CUSTOM_REPORT_SOURCES.find(item => item.code === code)

export const allDimensionCodes = (): Set<string> => new Set(CUSTOM_REPORT_SOURCES.flatMap(source => source.dimensions.map(item => item.code)))

export interface ReportSchedule {
  frequency: 'DAILY' | 'WEEKLY'
  hour: number
  weekday?: number
  lastRunAt?: string
  /** 最近一次定时生成失败的原因；成功后清空。 */
  lastError?: string | null
}

export function isReportDue(schedule: ReportSchedule, now: Date): boolean {
  if (now.getUTCHours() !== schedule.hour) return false
  if (schedule.frequency === 'WEEKLY' && now.getUTCDay() !== (schedule.weekday ?? 1)) return false
  if (!schedule.lastRunAt) return true
  return schedule.lastRunAt.slice(0, 13) !== now.toISOString().slice(0, 13)
}

export function rangeTooLong(from?: string, to?: string): boolean {
  if (!from || !to) return false
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return true
  return (end - start) / 86_400_000 > CUSTOM_RANGE_MAX_DAYS
}

/** 公式引用的字典指标需要的权限。缺任一则整条自定义指标不返回。 */
export function gatesOfMetric(id: string): string[] {
  const def = METRIC_DEFINITIONS.find(item => item.id === id)
  if (!def) return []
  const gates = new Set<string>()
  const domain = def.ruleUse?.domain
  if (domain === 'profit') gates.add('field.profit')
  if (domain === 'ads' || def.group === '广告') gates.add('ads.read')
  if (domain === 'inventory' || def.group === '库存与补货') gates.add('inventory.read')
  if (def.name.includes('成本')) gates.add('field.cost')
  return [...gates]
}

export function gatesOfRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.flatMap(gatesOfMetric))]
}

export function customMetricDefinition(row: { key: string; name: string; expression: unknown; version: number }): MetricDefinition {
  return {
    id: row.key,
    name: row.name,
    type: '自定义',
    group: '自定义指标',
    definition: expressionText(row.expression) || '自定义公式',
    source: '自定义指标',
    refresh: '随数据源查询',
    version: row.version,
    pages: ['我的报表'],
    ruleUse: null,
    reconcileWith: [],
    mismatchReasons: ['按查看人的字段权限取数；缺权限时这一列不返回'],
    configurableAt: { label: '自定义指标', route: '/app/reports/custom-metrics' },
  }
}

export interface ReportQueryRow {
  id: string
  label: string
  values: Record<string, number | null>
}

export interface ReportQueryResult {
  columns: SourceColumn[]
  rows: ReportQueryRow[]
  pageInfo: { nextCursor: string | null; hasMore: boolean; pageSize: number }
  restrictions: string[]
  truncated: boolean
  elapsedMs: number
}
