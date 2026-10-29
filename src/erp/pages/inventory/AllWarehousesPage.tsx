import { useCallback, useMemo, useState } from 'react'
import { Alert, Card } from 'antd'
import { AW_DEFAULT_SORT, type AwColumnKey, type AwResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, FreshnessBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type FreshnessInfo, type PageFetcher, type SearchMode, type TreeOptions } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { allWarehousesColumns, AW_SORTABLE, toFlatRow, type AwFlatRow } from './all-warehouses-columns'

// 跨仓总览（P6-25，16 章第 4 节）：每个 SKU 一行，列为 FBA、AWD、国内仓的在库与各段在途，最后是三个合计（已到仓、在途、合计）和货值；
// SKU 行可展开到每个仓。已到仓与在途互斥相加，同一件货只算一次（AWD 发往 FBA 与 FBA 入库中重叠，只展示不计入）。
// 每个数量列的问号写明数据来源（表与字段）；没有权限的列不出现并说明原因；没有来源的格显示“—”，不是 0。

const ACTION = '/inventory/all-warehouses'
const FIELDS: FilterField[] = []
const MODES: SearchMode[] = [{ id: 'keyword', label: 'SKU', key: 'q', placeholder: '搜索 SKU 或商品标题' }]

type Meta = Pick<AwResponse, 'note' | 'restrictions' | 'costRestricted' | 'truncated' | 'freshness' | 'state'>

export default function AllWarehousesPage() {
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values } = url
  const [meta, setMeta] = useState<Meta | null>(null)
  const query = useMemo(() => ({ ...apiParams, q: values.q || undefined }), [apiParams, values.q])

  const columns = useMemo(() => {
    const restricted = new Set<AwColumnKey>((meta?.restrictions ?? []).flatMap(item => item.metrics))
    return allWarehousesColumns({ restricted, costRestricted: meta?.costRestricted ?? false })
  }, [meta?.restrictions, meta?.costRestricted])

  const fetchPage = useCallback<PageFetcher<AwFlatRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const sortParam = sort ? `${sort.field}:${sort.direction}` : `${AW_DEFAULT_SORT.field}:${AW_DEFAULT_SORT.dir}`
      const response = await apiFetch<AwResponse>(buildPath(ACTION, { ...query, page, pageSize, sort: sortParam }), { signal })
      setMeta({
        note: response.note,
        restrictions: response.restrictions,
        costRestricted: response.costRestricted,
        truncated: response.truncated,
        freshness: response.freshness,
        state: response.state,
      })
      return { items: response.items.map(toFlatRow), total: response.total }
    },
    [query],
  )
  const fetchSummary = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const response = await apiFetch<AwResponse>(buildPath(ACTION, { ...query, page: 1, pageSize: 1 }), { signal })
      const { cells, onHand, inTransit, total, stockValue } = response.summary
      return { totals: { ...cells, onHand, inTransit, total, stockValue } as Record<string, number | null>, currency: 'USD' }
    },
    [query],
  )
  const tree = useMemo<TreeOptions<AwFlatRow>>(() => ({ hasChildren: row => row.childRows.length > 0, getChildren: row => row.childRows }), [])
  const searched = values.q !== undefined && values.q !== ''

  return (
    <div data-testid="all-warehouses-page">
      <PageHeader
        title="跨仓总览"
        description="每个 SKU 一行，汇总 FBA、AWD、国内仓的在库与在途；点行首的箭头展开到每个仓。已到仓与在途互斥相加，同一件货只算一次。每个数量列的问号写明取自哪个表的哪个字段。"
        actions={<AppLink to="/app/inventory/ledger">库存台账</AppLink>}
      />
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta?.truncated ? <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="SKU 过多，只统计了前面的部分" description="请用顶部范围栏缩小到某些店铺后再看，以免合计不完整。" /> : null}
      {meta && meta.restrictions.length > 0 ? (
        <Alert type="info" showIcon style={{ margin: '8px 0' }} message="部分列因权限没有显示" description={meta.restrictions.map(item => item.reason).join('；')} data-testid="aw-restrictions" />
      ) : null}
      {meta?.costRestricted ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message="没有成本字段权限，单件成本与货值没有显示" data-testid="aw-cost-restricted" /> : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<AwFlatRow>
          gridId="inventory.all-warehouses"
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={AW_SORTABLE}
          defaultSort={{ field: AW_DEFAULT_SORT.field, direction: AW_DEFAULT_SORT.dir }}
          resetKey={JSON.stringify([apiParams, url.signature])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          fetchSummary={fetchSummary}
          tree={tree}
          emptyState={{
            kind: 'empty',
            domain: '跨仓库存',
            prerequisite: searched ? '没有符合当前搜索的 SKU；可以放宽条件，或点“重置”。' : (meta?.note ?? '还没有库存记录；连接店铺并完成库存同步、或登记国内仓流水后显示。'),
          }}
          height={620}
        />
      </Card>
    </div>
  )
}
