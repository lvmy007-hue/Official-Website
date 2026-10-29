import { useCallback, useMemo, useState } from 'react'
import { Card, Tabs } from 'antd'
import { REMOVAL_TYPES, REMOVAL_TYPE_LABEL, type RecommendedRemovalResponse, type RecommendedRemovalRow, type RemovalListResponse, type RemovalOrderRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, FreshnessBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type FreshnessInfo, type PageFetcher, type SearchMode } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { useScope } from '../../scope/context'
import { buildPath } from '../../query/api-query'
import { GuideAlert, StateBlock } from './inventory-ui'
import { ORDER_SORTABLE, orderColumns, RECOMMENDED_SORTABLE, recommendedColumns } from './removal-columns'

// 移除与弃置（P2a-09，06 章 6.5；P6-28 迁到 PagedGrid）：移除订单列表（含收货核对状态）与亚马逊推荐移除清单。
// 移除订单只能在亚马逊卖家后台创建：页面给出指引，不提供创建入口；系统负责跟踪订单、核对退回件收货。

type Tab = 'orders' | 'recommended'
type Meta = Pick<RemovalListResponse, 'freshness' | 'guide' | 'state' | 'note'>

const ORDER_FIELDS: FilterField[] = [{ key: 'type', label: '类型', kind: 'select', width: 160, options: REMOVAL_TYPES.map(value => ({ value, label: REMOVAL_TYPE_LABEL[value] })) }]
const ORDER_MODES: SearchMode[] = [{ id: 'keyword', label: '订单', key: 'q', placeholder: '搜索订单号或 SKU' }]

function OrdersPane() {
  const { apiParams } = useScope()
  const url = useUrlFilters(ORDER_FIELDS, ORDER_MODES)
  const q = url.values.q ?? ''
  const type = url.values.type || undefined
  const [meta, setMeta] = useState<Meta | null>(null)
  const columns = useMemo(() => orderColumns(), [])
  const fetchPage = useCallback<PageFetcher<RemovalOrderRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const sortParam = sort ? `${sort.field}:${sort.direction}` : undefined
      const data = await apiFetch<RemovalListResponse>(buildPath('/inventory/removals', { ...apiParams, q: q || undefined, type, page, pageSize, sort: sortParam }), { signal })
      setMeta({ freshness: data.freshness, guide: data.guide, state: data.state, note: data.note })
      return { items: data.items, total: data.total }
    },
    [apiParams, q, type],
  )
  return (
    <>
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta ? <GuideAlert guide={meta.guide} /> : null}
      {meta ? <StateBlock state={meta.state} note={meta.note} /> : null}
      <FilterBar fields={ORDER_FIELDS} modes={ORDER_MODES} values={url.values} onChange={url.set} onReset={url.reset} />
      <PagedGrid<RemovalOrderRow>
        gridId="inventory.removals.orders"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        sortableFields={ORDER_SORTABLE}
        defaultSort={{ field: 'requestDate', direction: 'desc' }}
        resetKey={JSON.stringify([apiParams, url.signature])}
        appliedFilterCount={appliedCount(ORDER_FIELDS, ORDER_MODES, url.values)}
        onClearFilters={url.reset}
        emptyState={{ kind: 'empty', domain: '移除订单', prerequisite: '还没有移除订单记录；在卖家后台创建移除订单并完成同步后显示。' }}
        height={560}
      />
    </>
  )
}

function RecommendedPane() {
  const { apiParams } = useScope()
  const [meta, setMeta] = useState<Meta | null>(null)
  const columns = useMemo(() => recommendedColumns(), [])
  const fetchPage = useCallback<PageFetcher<RecommendedRemovalRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const sortParam = sort ? `${sort.field}:${sort.direction}` : undefined
      const data = await apiFetch<RecommendedRemovalResponse>(buildPath('/inventory/removals/recommended', { ...apiParams, page, pageSize, sort: sortParam }), { signal })
      setMeta({ freshness: data.freshness, guide: data.guide, state: data.state, note: data.note })
      return { items: data.items, total: data.total }
    },
    [apiParams],
  )
  return (
    <>
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta ? <GuideAlert guide={meta.guide} /> : null}
      {meta ? <StateBlock state={meta.state} note={meta.note} /> : null}
      <PagedGrid<RecommendedRemovalRow>
        gridId="inventory.removals.recommended"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        sortableFields={RECOMMENDED_SORTABLE}
        defaultSort={{ field: 'removalQty', direction: 'desc' }}
        resetKey={JSON.stringify([apiParams, 'recommended'])}
        emptyState={{ kind: 'empty', domain: '推荐移除清单', prerequisite: '亚马逊库存规划报告里没有推荐移除的 SKU，或报告尚未同步。' }}
        height={560}
      />
    </>
  )
}

export default function RemovalsPage() {
  const [tab, setTab] = useState<Tab>('orders')
  return (
    <div>
      <PageHeader title="移除与弃置" description="移除订单的跟踪与退回件收货核对，以及亚马逊推荐移除的 SKU；移除订单只能在亚马逊卖家后台创建。" />
      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as Tab)}
          items={[
            { key: 'orders', label: '移除订单', children: <OrdersPane /> },
            { key: 'recommended', label: '推荐移除清单', children: <RecommendedPane /> },
          ]}
        />
      </Card>
    </div>
  )
}
