import {
  ADS_METRICS_BASE_KEYS,
  ADS_METRICS_DATASETS,
  ADS_METRICS_LIMITS,
  ADS_REPORT_AD_PRODUCT_LABEL,
  addSums,
  bucketKeyOf,
  emptySums,
  type AdsMetricsDatasetKey,
  type AdsMetricsDimension,
  type AdsMetricsSums,
  type DashGranularity,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, type ResolvedScope } from '../auth'
import { addDays, zonedDayStart } from '../overview'
import { DATASET_SOURCES } from './ads-metrics-datasets'

// 广告指标（自由分析）的读取（P3-15）：在数据库里按所选维度对应的列分组求和，再在内存里把日期折成周或月的桶、把同一对象的多个名称合并。
// 只读美元行（不同币种不相加），非美元的行数单独返回提示；分组数碰到上限就如实标记“已截断”，合计与排序只覆盖读到的部分。

type Loose = ReturnType<typeof JSON.parse>

export interface MetricsCell {
  /** 稳定键（用于合并与行键）。 */
  key: string
  /** 显示值；没有名称时为空，由调用方按编号补名称或退回编号。 */
  label: string | null
}
export interface MetricsGroup {
  dims: Partial<Record<AdsMetricsDimension, MetricsCell>>
  sums: AdsMetricsSums
}
export interface MetricsLoadInput {
  tenantId: string
  scope: ResolvedScope
  dataset: AdsMetricsDatasetKey
  dimensions: readonly AdsMetricsDimension[]
  grain: DashGranularity
  period: { from: string; to: string }
  zone: string
  adsProfileId?: string
  adProduct?: string
}
export interface MetricsLoadResult {
  groups: MetricsGroup[]
  truncated: boolean
  otherCurrencyRows: number
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

/** 小时起点按企业时区显示成“YYYY-MM-DD HH:00”。 */
export function hourLabel(date: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:00`
}

function cellOf(dimension: AdsMetricsDimension, row: Loose, columns: readonly string[], input: MetricsLoadInput): MetricsCell {
  const first = row[columns[0]]
  if (dimension === 'date') {
    const key = bucketKeyOf((first as Date).toISOString().slice(0, 10), input.grain)
    return { key, label: key }
  }
  if (dimension === 'hour') return { key: (first as Date).toISOString(), label: hourLabel(first as Date, input.zone) }
  if (dimension === 'halo') return { key: String(first), label: first ? '是' : '否' }
  if (dimension === 'adProduct') return { key: text(first), label: ADS_REPORT_AD_PRODUCT_LABEL[text(first) as keyof typeof ADS_REPORT_AD_PRODUCT_LABEL] ?? (text(first) || null) }
  const name = columns.length > 1 ? text(row[columns[1]]) : ''
  // 目标：有编号用编号当键；没有编号（旧数据）用表达式当键
  const key = text(first) || name
  return { key, label: name || text(first) || null }
}

export async function loadMetricGroups(prisma: PrismaService, input: MetricsLoadInput): Promise<MetricsLoadResult> {
  const source = DATASET_SOURCES[input.dataset]
  const info = ADS_METRICS_DATASETS[input.dataset]
  const delegate = source.delegate(prisma)
  const range =
    source.dateColumn === 'reportDate'
      ? { gte: new Date(`${input.period.from}T00:00:00Z`), lte: new Date(`${input.period.to}T00:00:00Z`) }
      : { gte: zonedDayStart(input.period.from, input.zone), lt: zonedDayStart(addDays(input.period.to, 1), input.zone) }
  const base = {
    tenantId: input.tenantId,
    ...adsRelationWhere(input.scope),
    ...source.fixed,
    [source.dateColumn]: range,
    ...(input.adsProfileId ? { adsProfileId: input.adsProfileId } : {}),
    ...(input.adProduct && info.hasAdProduct ? { adProduct: input.adProduct } : {}),
  }
  const where = { ...base, currency: 'USD' }
  const sumColumns = [...new Set(Object.values(source.sums))]
  const _sum = Object.fromEntries(sumColumns.map(column => [column, true]))
  const columns = [...new Set(input.dimensions.flatMap(dimension => source.columns[dimension] ?? []))]
  const otherCurrency = delegate.count({ where: { ...base, currency: { not: 'USD' } } })
  const sumsOf = (row: Loose): AdsMetricsSums => {
    const sums = emptySums()
    for (const key of ADS_METRICS_BASE_KEYS) {
      const column = source.sums[key]
      if (column) sums[key] = num(row._sum?.[column])
    }
    return sums
  }
  // 没选维度：只要一个合计行
  if (columns.length === 0) {
    const [row, otherCurrencyRows] = await Promise.all([delegate.aggregate({ where, _sum, _count: { _all: true } }), otherCurrency])
    return { groups: row._count._all > 0 ? [{ dims: {}, sums: sumsOf(row) }] : [], truncated: false, otherCurrencyRows }
  }
  const [rows, otherCurrencyRows] = await Promise.all([
    delegate.groupBy({ by: columns, where, _sum, orderBy: columns.map(column => ({ [column]: 'asc' })), take: ADS_METRICS_LIMITS.groupLimit + 1 }),
    otherCurrency,
  ])
  const truncated = rows.length > ADS_METRICS_LIMITS.groupLimit
  const merged = new Map<string, MetricsGroup>()
  for (const row of rows.slice(0, ADS_METRICS_LIMITS.groupLimit)) {
    const dims: MetricsGroup['dims'] = {}
    for (const dimension of input.dimensions) dims[dimension] = cellOf(dimension, row, source.columns[dimension] ?? [], input)
    const key = input.dimensions.map(dimension => dims[dimension]?.key ?? '').join('\u0001')
    const found = merged.get(key)
    if (!found) merged.set(key, { dims, sums: sumsOf(row) })
    else {
      found.sums = addSums([found.sums, sumsOf(row)])
      // 同一对象的名称在不同天可能不同：保留第一个有名称的
      for (const dimension of input.dimensions) if (found.dims[dimension] && !found.dims[dimension]?.label && dims[dimension]?.label) found.dims[dimension] = dims[dimension]
    }
  }
  return { groups: [...merged.values()], truncated, otherCurrencyRows }
}
