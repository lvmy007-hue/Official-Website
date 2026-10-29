import { useCallback, useMemo, useState } from 'react'
import { Alert, Card } from 'antd'
import {
  BR_GRANULARITIES,
  BR_GRANULARITY_LABEL,
  SS_BUCKET_MAX,
  SS_DEFAULT_SORT,
  SS_DIMENSIONS,
  SS_DIMENSION_LABEL,
  SS_METRICS,
  SS_METRIC_LABEL,
  ssColumnId,
  WEEK_START_LABEL,
  type BrGranularity,
  type SsDimension,
  type SsMetric,
  type SsResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, FreshnessBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type FreshnessInfo, type PageFetcher, type SearchMode } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { flatten, salesStatColumns, SS_SORTABLE, type SalesStatRow } from './sales-stat-columns'

// 销量统计（P6-25，16 章第 2.2 节）：每个日期一列、最后一列小计；维度 ASIN、父 ASIN、SKU、店铺、负责人；粒度日、周、月（周起始日读业务口径）。
// 可用库存与周转天数固定在左；汇总行由服务端对符合筛选的全部行合计；日期范围用页面顶部的范围栏（不选时日 30 天、周 12 周、月 12 个月）。
// 没有记录的日期显示“—”；SKU 维度下多个 SKU 共用的 ASIN 没有数值，页面写明原因，不平均拆分。

const ACTION = '/analytics/sales-stat'
const FIELDS: FilterField[] = [
  { key: 'dimension', label: '维度', kind: 'select', width: 130, options: SS_DIMENSIONS.map(value => ({ value, label: SS_DIMENSION_LABEL[value] })) },
  { key: 'granularity', label: '粒度', kind: 'select', width: 110, options: BR_GRANULARITIES.map(value => ({ value, label: BR_GRANULARITY_LABEL[value] })) },
  { key: 'metric', label: '指标', kind: 'select', width: 150, options: SS_METRICS.map(value => ({ value, label: SS_METRIC_LABEL[value] })) },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '商品', key: 'q', placeholder: '搜索 ASIN、父 ASIN、SKU、标题、店铺' }]
const pick = <T extends string>(all: readonly T[], value: string | undefined, fallback: T): T => all.find(item => item === value) ?? fallback

type Meta = Pick<SsResponse, 'freshness' | 'note' | 'truncated' | 'inventoryBasis' | 'weekStart'>

export default function SalesStatPage() {
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values } = url
  const dimension: SsDimension = pick(SS_DIMENSIONS, values.dimension, 'asin')
  const granularity: BrGranularity = pick(BR_GRANULARITIES, values.granularity, 'DAY')
  const metric: SsMetric = pick(SS_METRICS, values.metric, 'units')
  const [buckets, setBuckets] = useState<string[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const query = useMemo(() => ({ ...apiParams, dimension, granularity, metric, q: values.q || undefined }), [apiParams, dimension, granularity, metric, values.q])

  const columns = useMemo(() => salesStatColumns(buckets, granularity, metric, meta?.inventoryBasis ?? '可用库存 = 可售'), [buckets, granularity, metric, meta?.inventoryBasis])

  const fetchPage = useCallback<PageFetcher<SalesStatRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const sortParam = sort ? `${sort.field}:${sort.direction}` : `${SS_DEFAULT_SORT.field}:${SS_DEFAULT_SORT.dir}`
      const response = await apiFetch<SsResponse>(buildPath(ACTION, { ...query, page, pageSize, sort: sortParam }), { signal })
      setBuckets(response.buckets)
      setMeta({ freshness: response.freshness, note: response.note, truncated: response.truncated, inventoryBasis: response.inventoryBasis, weekStart: response.weekStart })
      return { items: response.rows.map(row => flatten(row, response.buckets)), total: response.total }
    },
    [query],
  )
  // 汇总行：对符合筛选的全部行合计（只取一行的页，读它的 summary）
  const fetchSummary = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const response = await apiFetch<SsResponse>(buildPath(ACTION, { ...query, page: 1, pageSize: 1 }), { signal })
      const totals: Record<string, number | null> = { total: response.summary.total, availableStock: response.summary.availableStock }
      response.buckets.forEach((bucket, index) => {
        totals[ssColumnId(bucket)] = response.summary.values[index] ?? null
      })
      return { totals, currency: null }
    },
    [query],
  )
  const searched = values.q !== undefined && values.q !== ''

  return (
    <div data-testid="sales-stat-page">
      <PageHeader
        title="销量统计"
        description={`每个日期一列，最后一列为小计；维度可选 ASIN、父 ASIN、SKU、店铺、负责人，粒度可选日、周、月（周起始日读业务口径${meta ? `，当前${WEEK_START_LABEL[meta.weekStart]}` : ''}）。日期范围用页面顶部的范围栏。`}
        actions={<AppLink to="/app/analytics/product-performance">商品表现</AppLink>}
      />
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta?.truncated ? (
        <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="范围内销售记录过多，只统计了前面的部分" description="请用顶部范围栏缩小到某些店铺或更短的日期后再看，以免合计不完整。" />
      ) : null}
      {meta?.note && meta.note.includes('不含它们的销量') ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={meta.note} data-testid="ss-gap-note" /> : null}
      <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`日期列最多 ${SS_BUCKET_MAX} 个；没有记录的日期显示“—”（不是 0）；周与月的列以起始日命名，范围边缘只含范围内的天。`} />
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={{ dimension, granularity, metric, ...values }} onChange={url.set} onReset={url.reset} />
        <PagedGrid<SalesStatRow>
          gridId="analytics.sales-stat"
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={SS_SORTABLE}
          defaultSort={{ field: SS_DEFAULT_SORT.field, direction: SS_DEFAULT_SORT.dir }}
          resetKey={JSON.stringify([apiParams, url.signature, dimension, granularity, metric])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          fetchSummary={fetchSummary}
          emptyState={{
            kind: 'empty',
            domain: '销量统计',
            prerequisite: searched ? '没有符合当前搜索的商品；可以放宽条件，或点“重置”。' : (meta?.note ?? '所选范围内还没有销售记录；连接店铺并完成销售与流量同步后显示。'),
          }}
          height={620}
        />
      </Card>
    </div>
  )
}
