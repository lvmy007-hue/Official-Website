import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Alert, Card, Tree } from 'antd'
import type { AdsLevel, AdsLevelSummary } from '@nova/api-contracts'
import { FilterBar, MassiveGrid, PageHeader, useUrlFilters, type CursorFetcher, type ErpColDef, type FilterField, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { apiFetch } from '../../../api'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { BucketChips, LEVEL_HIDDEN_FIELDS, RangeFilter } from './ads-level-filters'
import { analysisColumn, summaryTotals } from './ads-level-columns'

// 广告层级统一骨架（P6-23，16 章第 8 节）：广告活动、广告组、投放、搜索词、广告商品五个列表共用这一个组件，没有各自写的表格。
// 骨架负责：左侧广告组合树、筛选栏（页面给的字段 + 隐藏的区间与分类键，都写在地址栏里）、指标区间、分类计数条、汇总行（服务端口径）、
// 列分组与服务端视图（MassiveGrid）、末列“分析”趋势小窗、勾选后的批量操作栏。数据的取法（路径、固定参数）与列由各页面给。

export type LevelListResponse<T> = {
  items: T[]
  pageInfo: { hasMore: boolean; nextCursor: string | null; approxTotal?: number | null }
  /** 汇总：活动、广告组、搜索词、投放放在 summary，广告商品放在 level（它的 summary 是另一份内容）。 */
  summary?: unknown
  level?: AdsLevelSummary
  filterOptions?: { portfolios?: Array<{ id: string; name: string }> }
  range?: { from: string; to: string; defaulted: boolean }
  truncated?: boolean
  note?: string | null
  state?: string
}

export type AdsLevelGridProps<T extends object, R extends LevelListResponse<T>> = {
  level: AdsLevel
  title: string
  description: string
  gridId: string
  testId: string
  /** 列表接口路径，例如 /ads/campaigns。 */
  path: string
  /** 固定带上的参数，例如词级中心的 tab。 */
  fixedParams?: Record<string, string>
  /** 筛选字段：读到列表之前 response 为 null（选项还不全，下拉不校验）。区间与分类字段由骨架补。 */
  fieldsOf: (response: R | null) => FilterField[]
  modes: SearchMode[]
  columns: ErpColDef<T>[]
  sortableFields: Readonly<Record<string, string>>
  defaultSort: SortSpec
  getRowId: (row: T) => string
  summaryOf: (response: R) => Pick<AdsLevelSummary, 'totals' | 'ratios'> | undefined
  emptyDomain: string
  emptyNote: string
  /** 末列分析图标：趋势小窗的接口路径；返回 null 或不传时置灰并写 disabledReason。 */
  trendPathOf?: (row: T) => string | null
  trendDisabledReason?: string
  /** 勾选后的批量操作；done 用来写入完成后刷新并清空勾选。 */
  renderBulkActions?: (rows: T[], done: () => void) => ReactNode
  /** 每次读到第一页时回调（页面要读额外的元数据）。 */
  onFirstPage?: (response: R) => void
  /** 表格上方的附加说明。 */
  notes?: (response: R | null) => ReactNode
  /** 是否显示分类计数条（默认显示）。 */
  buckets?: boolean
  height?: number
}

export function AdsLevelGrid<T extends object, R extends LevelListResponse<T>>(props: AdsLevelGridProps<T, R>) {
  const { level, path, fixedParams, fieldsOf, modes, summaryOf } = props
  const { apiParams } = useScope()
  const [meta, setMeta] = useState<R | null>(null)
  const fields = useMemo(() => [...fieldsOf(meta), ...LEVEL_HIDDEN_FIELDS], [fieldsOf, meta])
  const url = useUrlFilters(fields, modes)
  const { values, replaceAll } = url
  const [nonce, setNonce] = useState(0)
  const done = useCallback(() => setNonce(value => value + 1), [])
  const requestParams = useMemo(() => ({ ...apiParams, ...fixedParams, ...values }), [apiParams, fixedParams, values])

  const fetchPage = useCallback<CursorFetcher<T>>(
    async ({ cursor, limit, sort, signal }) => {
      const response = await apiFetch<R>(buildPath(path, { ...requestParams, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined }), { signal })
      if (cursor === null) {
        setMeta(response)
        props.onFirstPage?.(response)
      }
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    // onFirstPage 每次渲染都是新函数，只按请求参数重建数据源
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, requestParams],
  )
  // 汇总行：只取服务端对“筛选后全部对象”的合计（不是当前页之和）
  const fetchSummary = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const response = await apiFetch<R>(buildPath(path, { ...requestParams, pageSize: 1 }), { signal })
      const summary = summaryOf(response)
      if (!summary) throw new Error('接口没有返回汇总')
      return { totals: summaryTotals(summary), currency: 'USD' }
    },
    [path, requestParams, summaryOf],
  )
  const columns = useMemo(
    () => [...props.columns, analysisColumn<T>({ trendPathOf: props.trendPathOf, disabledReason: props.trendDisabledReason })],
    [props.columns, props.trendPathOf, props.trendDisabledReason],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const filtered = Object.keys(values).length > 0
  const visibleFields = useMemo(() => fields.filter(field => !field.hidden), [fields])
  const portfolios = meta?.filterOptions?.portfolios ?? []
  const hasPortfolioFilter = fields.some(field => field.key === 'portfolioId')
  const countParams = useMemo(() => ({ ...apiParams, ...fixedParams }), [apiParams, fixedParams])

  return (
    <div data-testid={props.testId}>
      <PageHeader title={props.title} description={props.description} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {hasPortfolioFilter ? (
          <Card size="small" title="广告组合" style={{ width: 200, flex: '0 0 200px' }} data-testid="ads-portfolio-tree">
            <Tree
              blockNode
              selectedKeys={[values.portfolioId ?? '__all']}
              treeData={[{ key: '__all', title: '全部广告组合' }, ...portfolios.map(item => ({ key: item.id, title: item.name }))]}
              onSelect={(keys, info) => {
                if (!info.selected) return
                const key = String(keys[0])
                url.set({ portfolioId: key === '__all' ? undefined : key })
              }}
            />
            {portfolios.length === 0 ? <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginTop: 6 }}>尚无广告组合记录</div> : null}
          </Card>
        ) : null}
        <Card size="small" style={{ flex: 1, minWidth: 0 }}>
          {meta?.range?.defaulted ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`未选择日期范围，当前显示 ${meta.range.from} 至 ${meta.range.to} 的指标`} /> : null}
          {meta?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`${props.emptyDomain}数量超过读取上限，只处理了前一部分；请用筛选缩小范围`} /> : null}
          {meta?.note && meta.state === 'OK' ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={meta.note} /> : null}
          {props.notes?.(meta)}
          <FilterBar fields={visibleFields} modes={modes} values={values} onChange={url.set} onReset={url.reset} leading={<RangeFilter values={values} onApply={url.set} />} />
          {props.buckets === false ? null : <BucketChips level={level} params={countParams} values={values} onPick={bucket => url.set({ bucket })} />}
          <MassiveGrid<T>
            gridId={props.gridId}
            serverViews
            viewFilters={viewFilters}
            columns={columns}
            fetchPage={fetchPage}
            fetchSummary={fetchSummary}
            getRowId={props.getRowId}
            sortableFields={props.sortableFields}
            defaultSort={props.defaultSort}
            resetKey={JSON.stringify([apiParams, fixedParams, url.signature, nonce])}
            appliedFilterCount={appliedCount(fields, modes, values)}
            onClearFilters={url.reset}
            renderBulkActions={props.renderBulkActions ? rows => props.renderBulkActions?.(rows, done) : undefined}
            emptyState={{ kind: 'empty', domain: props.emptyDomain, prerequisite: filtered ? `没有符合条件的${props.emptyDomain}；可以放宽筛选条件。` : (meta?.note ?? props.emptyNote) }}
            height={props.height ?? 620}
          />
        </Card>
      </div>
    </div>
  )
}
