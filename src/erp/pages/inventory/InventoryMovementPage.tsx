import { useCallback, useMemo, useState } from 'react'
import { Alert, Card } from 'antd'
import { MV_DEFAULT_SORT, MV_FLOW_KEYS, type MvResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, FreshnessBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type FreshnessInfo, type PageFetcher, type SearchMode } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { flattenMovement, flowId, movementColumns, MV_SORTABLE, type MovementGridRow } from './movement-columns'

// 进销存报表（P6-25，16 章第 4 节）：每个 SKU、每个月一行，期初 + 本月各类变动 = 期末，并给出发货件数、周转天数、存销比与货值。
// 数量不平衡的行标红并显示差额（台账缺事件或有未识别变动），不自动抹平；货值按月内生效的成本版本取价。汇总行由服务端对符合筛选的全部行合计。

const ACTION = '/inventory/movement'
const FIELDS: FilterField[] = [
  {
    key: 'unbalanced',
    label: '数量',
    kind: 'select',
    width: 150,
    options: [
      { value: 'true', label: '只看不平衡' },
      { value: 'false', label: '全部' },
    ],
  },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: 'SKU', key: 'q', placeholder: '搜索 SKU 或 ASIN' }]

type Meta = Pick<MvResponse, 'note' | 'costRestricted' | 'truncated' | 'freshness' | 'unbalancedCount' | 'from' | 'to'>

export default function InventoryMovementPage() {
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values } = url
  const [meta, setMeta] = useState<Meta | null>(null)
  const query = useMemo(() => ({ ...apiParams, q: values.q || undefined, unbalanced: values.unbalanced === 'true' ? 'true' : undefined }), [apiParams, values.q, values.unbalanced])
  const columns = useMemo(() => movementColumns(meta?.costRestricted ?? false), [meta?.costRestricted])

  const fetchPage = useCallback<PageFetcher<MovementGridRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const sortParam = sort ? `${sort.field}:${sort.direction}` : `${MV_DEFAULT_SORT.field}:${MV_DEFAULT_SORT.dir}`
      const response = await apiFetch<MvResponse>(buildPath(ACTION, { ...query, page, pageSize, sort: sortParam }), { signal })
      setMeta({
        note: response.note,
        costRestricted: response.costRestricted,
        truncated: response.truncated,
        freshness: response.freshness,
        unbalancedCount: response.unbalancedCount,
        from: response.from,
        to: response.to,
      })
      return { items: response.items.map(flattenMovement), total: response.total }
    },
    [query],
  )
  const fetchSummary = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const { totals } = await apiFetch<MvResponse>(buildPath(ACTION, { ...query, page: 1, pageSize: 1 }), { signal })
      const flows = Object.fromEntries(MV_FLOW_KEYS.map(key => [flowId(key), totals.flows[key]]))
      return {
        totals: { openingQty: totals.openingQty, endingQty: totals.endingQty, difference: totals.difference, openingValue: totals.openingValue, endingValue: totals.endingValue, ...flows } as Record<
          string,
          number | null
        >,
        currency: 'USD',
      }
    },
    [query],
  )
  const searched = (values.q !== undefined && values.q !== '') || values.unbalanced === 'true'

  return (
    <div data-testid="inventory-movement-page">
      <PageHeader
        title="进销存报表"
        description="每个 SKU、每个月一行：期初 + 本月各类变动 = 期末，并给出发货件数、周转天数、存销比与货值（按月内生效的成本版本取价）。日期范围用页面顶部的范围栏，按月取整。"
        actions={<AppLink to="/app/inventory/ledger">库存台账</AppLink>}
      />
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta?.truncated ? (
        <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="范围内台账记录过多，只统计了前面的部分" description="请用顶部范围栏缩小到某些店铺或更短的日期后再看，以免合计不完整。" />
      ) : null}
      {meta && meta.unbalancedCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '8px 0' }}
          message={`有 ${meta.unbalancedCount} 行数量不平衡`}
          description="期初加本月全部变动与期末不相等，多为台账缺事件或有未识别的变动；请到库存台账核对，系统不会自动抹平。"
          data-testid="mv-unbalanced"
        />
      ) : null}
      {meta?.costRestricted ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message="没有成本字段权限，单件成本与货值没有显示" data-testid="mv-cost-restricted" /> : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<MovementGridRow>
          gridId="inventory.movement"
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={MV_SORTABLE}
          defaultSort={{ field: MV_DEFAULT_SORT.field, direction: MV_DEFAULT_SORT.dir }}
          resetKey={JSON.stringify([apiParams, url.signature])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          fetchSummary={fetchSummary}
          emptyState={{
            kind: 'empty',
            domain: '进销存',
            prerequisite: searched ? '没有符合当前条件的行；可以放宽条件，或点“重置”。' : (meta?.note ?? '范围内还没有库存台账汇总；连接店铺并完成库存台账同步后显示。'),
          }}
          height={620}
        />
      </Card>
    </div>
  )
}
