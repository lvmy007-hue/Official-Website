import { useCallback, useMemo, useState } from 'react'
import { Alert, Card } from 'antd'
import {
  PP_DEFAULT_SORT,
  PP_DIMENSIONS,
  PP_DIMENSION_LABEL,
  PP_METRICS,
  type PpAsyncResponse,
  type PpDimension,
  type PpMetricKey,
  type PpQueryResponse,
  type PpRow,
  type PpSummaryResponse,
  type PpTrendResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import {
  FilterBar,
  FreshnessBar,
  PageHeader,
  PagedGrid,
  useUrlFilters,
  type FilterField,
  type FreshnessInfo,
  type PageFetcher,
  type SearchMode,
  type TreeOptions,
  type ViewFilterBinding,
} from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { useSession } from '../../session/session'
import { PP_SORTABLE, productPerformanceColumns, type PpCaps } from './product-performance-columns'

// 商品表现宽表（P6-22，16 章第 2.1 节）：全站宽表的示范页。同一套指标按维度（ASIN、父 ASIN、SKU、店铺、负责人、品牌、品类）重新聚合；
// 每个指标列显示本期、上期、涨跌；汇总行由服务端对符合筛选的全部行合计；父 ASIN 行可展开子体。
// 利润、成本、广告、库存列按权限降级（没有权限的列不出现）；迷你趋势与库存、售后慢指标是异步列，只对可见行请求。
// 日期范围与对比期用页面顶部的全局范围；没有来源的指标（ACoAS、ASoAS、CPC、广告订单占比）如实写“尚未接入”，不显示成 0。

const ACTION = '/analytics/product-performance'
const FIELDS: FilterField[] = [{ key: 'dimension', label: '维度', kind: 'select', width: 130, options: PP_DIMENSIONS.map(value => ({ value, label: PP_DIMENSION_LABEL[value] })) }]
const MODES: SearchMode[] = [{ id: 'keyword', label: '商品', key: 'q', placeholder: '搜索 ASIN、父 ASIN、SKU、标题、品牌' }]

type Meta = Pick<PpQueryResponse, 'allowed' | 'restrictions' | 'gaps' | 'truncated' | 'compare' | 'freshness' | 'note'>

function post<T>(action: string, scope: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(buildPath(`${ACTION}/${action}`, scope), { method: 'POST', body: JSON.stringify(body), signal })
}

export default function ProductPerformancePage() {
  const { apiParams } = useScope()
  const { canPermission } = useSession()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const dimension: PpDimension = PP_DIMENSIONS.find(item => item === values.dimension) ?? 'asin'
  const [meta, setMeta] = useState<Meta | null>(null)
  const filters = useMemo(() => ({ dimension, q: values.q || undefined }), [dimension, values.q])

  // 列的显示与服务端同一套规则：利润列要利润读取 + 利润字段，ROI 再要成本字段，广告、库存各要读取权限
  const caps = useMemo<PpCaps>(() => {
    const profit = canPermission('profit.read') && canPermission('field.profit')
    return { profit, cost: profit && canPermission('field.cost'), ads: canPermission('ads.read'), inventory: canPermission('inventory.read') }
  }, [canPermission])

  const columns = useMemo(
    () =>
      productPerformanceColumns(caps, {
        slow: async (ids, signal) => {
          const data = await post<PpAsyncResponse>('async-columns', apiParams, { dimension, ids }, signal)
          setMeta(current => (current ? { ...current, gaps: { ...current.gaps, ...data.gaps } } : current))
          return { rows: data.rows }
        },
        trend: async (ids, signal) => ({ rows: (await post<PpTrendResponse>('trend', apiParams, { dimension, ids, metric: 'sales' }, signal)).rows }),
      }),
    [caps, apiParams, dimension],
  )

  const fetchPage = useCallback<PageFetcher<PpRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const response = await post<PpQueryResponse>('query', apiParams, { ...filters, sort: sort ?? PP_DEFAULT_SORT, page, pageSize }, signal)
      setMeta({
        allowed: response.allowed,
        restrictions: response.restrictions,
        gaps: response.gaps,
        truncated: response.truncated,
        compare: response.compare,
        freshness: response.freshness,
        note: response.note,
      })
      return { items: response.items, total: response.total }
    },
    [apiParams, filters],
  )
  const fetchSummary = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const response = await post<PpSummaryResponse>('summary', apiParams, filters, signal)
      return { totals: response.totals as Record<string, number | null>, currency: response.currency }
    },
    [apiParams, filters],
  )

  // 父 ASIN 行展开子体：取该父体名下的 ASIN 行（最多 200 个）
  const tree = useMemo<TreeOptions<PpRow> | undefined>(
    () =>
      dimension === 'parentAsin'
        ? {
            hasChildren: row => row.hasChildren,
            loadChildren: async (row, signal) =>
              (await post<PpQueryResponse>('query', apiParams, { dimension: 'asin', parentAsin: row.asin, sort: PP_DEFAULT_SORT, page: 1, pageSize: 200 }, signal)).items,
          }
        : undefined,
    [dimension, apiParams],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (next, dim) => replaceAll(next) + (dim === null ? 0 : 1) }), [values, replaceAll])
  const gapList = meta ? (Object.entries(meta.gaps) as Array<[PpMetricKey, string]>).filter(([key]) => meta.allowed.includes(key)) : []
  const searched = values.q !== undefined && values.q !== ''

  return (
    <div data-testid="product-performance-page">
      <PageHeader
        title="商品表现"
        description="同一套指标按 ASIN、父 ASIN、SKU、店铺、负责人、品牌、品类重新聚合：每个指标显示本期、上期与涨跌，汇总行由服务端合计。日期范围与对比期用页面顶部的范围栏。"
        actions={<AppLink to="/app/analytics/asins">ASIN 与父体分析</AppLink>}
      />
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta?.truncated ? (
        <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="范围内商品或利润记录过多，只统计了前面的部分" description="请用顶部范围栏缩小到某些店铺后再看，以免合计不完整。" />
      ) : null}
      {meta && meta.restrictions.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ margin: '8px 0' }}
          message="部分列因权限没有显示"
          description={meta.restrictions.map(item => `${item.metrics.map(key => PP_METRICS[key].label).join('、')}：${item.reason}`).join('；')}
          data-testid="pp-restrictions"
        />
      ) : null}
      {gapList.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ margin: '8px 0' }}
          message="以下指标尚未接入或暂无记录，列里显示“—”（不是 0）"
          description={[...new Set(gapList.map(([key, text]) => `${PP_METRICS[key].label}：${text}`))].join('；')}
          data-testid="pp-gaps"
        />
      ) : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={{ dimension, ...values }} onChange={url.set} onReset={url.reset} />
        <PagedGrid<PpRow>
          gridId="analytics.product-performance"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={PP_SORTABLE}
          defaultSort={PP_DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, url.signature, dimension])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          fetchSummary={fetchSummary}
          tree={tree}
          emptyState={{
            kind: 'empty',
            domain: '商品表现',
            prerequisite: searched ? '没有符合当前搜索的商品；可以放宽条件，或点“重置”。' : (meta?.note ?? '所选范围内还没有商品或销售记录；连接店铺并完成商品目录、销售与流量同步后显示。'),
          }}
          height={620}
        />
      </Card>
    </div>
  )
}
