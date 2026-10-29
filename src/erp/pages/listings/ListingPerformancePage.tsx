import { useCallback, useMemo, useRef, useState } from 'react'
import { Card, Input, Select, Space } from 'antd'
import { PRODUCT_CHANNEL_LABEL, PRODUCT_CHANNELS, PRODUCT_LISTING_LABEL, type ListingPerfResponse, type ListingPerfRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FreshnessBar, MassiveGrid, PageHeader, type CursorFetcher, type ViewFilterBinding } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { useSession } from '../../session/session'
import { CompareDrawer } from './listing-perf-compare'
import { DEFAULT_CONTEXT, LISTING_SORTABLE, listingColumns, type ListingColumnContext } from './listing-perf-columns'
import { DEFAULT_VIEW, parseView, viewValues, type ListingFilters, type ListingView } from './listing-perf-state'
import { AnomalyCards, GateNotes, TrendBlock } from './listing-perf-top'

// 刊登表现（P4-09，05 章 5.3；P6-28 迁到 MassiveGrid）：顶部是趋势与异常分布，下面是一行一个店铺 × SKU 的表现表。
// 销售与流量按店铺 × ASIN 汇总（同 ASIN 的多个 SKU 共用，行上标“共用”）；筛选、排序、翻页都在服务端（游标无限滚动，排序点列头）；
// 列设置、固定列、保存视图（含这页的筛选）与“对比所选”（2 到 5 个商品并排）由表格自带；
// 没有数据写“尚无记录”，没有权限写“无权限”，来源还没建好写“尚未接入”，不补 0。

const DEFAULT_SORT = { field: 'sales', direction: 'desc' } as const

function Pick({
  label,
  value,
  options,
  onChange,
  width = 140,
}: {
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
  width?: number
}) {
  return <Select allowClear showSearch optionFilterProp="label" style={{ width }} placeholder={label} aria-label={label} value={value} options={options} onChange={next => onChange(next)} />
}

const same = (value: string[] | undefined) => (value ?? []).map(item => ({ value: item, label: item }))

function filtersOf(view: ListingView): ListingFilters {
  const { q, brand, category, status, fulfillment, ownerId, anomaly } = view
  return { q, brand, category, status, fulfillment, ownerId, anomaly }
}

export default function ListingPerformancePage() {
  const { canPermission } = useSession()
  const { apiParams } = useScope()
  const [view, setView] = useState<ListingView>(DEFAULT_VIEW)
  const [meta, setMeta] = useState<ListingPerfResponse | null>(null)
  const [comparing, setComparing] = useState<ListingPerfRow[] | null>(null)
  // 权限与来源状态随每次读到的第一页更新；列定义取它的当前值，所以列本身不变
  const context = useRef<ListingColumnContext>(DEFAULT_CONTEXT)
  const columns = useMemo(() => listingColumns(() => context.current), [])

  const change = (patch: Partial<ListingView>) => setView(current => ({ ...current, ...patch }))
  const filters = useMemo(() => filtersOf(view), [view])
  const filtered = Object.values(filters).some(Boolean)
  const appliedCount = Object.values(filters).filter(Boolean).length

  const fetchPage = useCallback<CursorFetcher<ListingPerfRow>>(
    async ({ cursor, limit, sort, signal }) => {
      const params = { ...apiParams, ...filters, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined }
      const data = await apiFetch<ListingPerfResponse>(buildPath('/listings/performance', params), { signal })
      if (cursor === null) {
        context.current = { gates: data.gates, pending: data.pending }
        setMeta(data)
      }
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    [apiParams, filters],
  )
  const viewFilters = useMemo<ViewFilterBinding>(
    () => ({
      value: viewValues(view),
      dimension: null,
      apply: next => {
        const parsed = parseView(next)
        setView(parsed.view)
        return parsed.ignored
      },
    }),
    [view],
  )
  const options = meta?.filterOptions

  return (
    <div data-testid="listing-performance-page">
      <PageHeader
        title="刊登表现"
        description="一行是一个店铺 × SKU：会话、浏览量、销量、销售额、转化率、购物车获得率，以及广告销售、退货率与可售天数；点标题进入 ASIN 360。可以按条件筛选、点列头排序、保存视图、配置显示的列，选 2 到 5 个商品并排对比。"
        actions={canPermission('analytics.read') ? <AppLink to="/app/analytics/product-performance">在商品表现中查看</AppLink> : undefined}
      />
      <FreshnessBar freshness={meta?.freshness} />
      {meta ? <TrendBlock data={meta} /> : null}
      <Card size="small" style={{ marginTop: 8 }}>
        {meta ? <GateNotes data={meta} /> : null}
        {meta ? <AnomalyCards data={meta} active={view.anomaly} onPick={anomaly => change({ anomaly })} /> : null}
        <Space wrap style={{ marginBottom: 8 }}>
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索 ASIN、SKU、标题"
            aria-label="搜索商品"
            key={`q|${view.q ?? ''}`}
            defaultValue={view.q}
            onSearch={value => change({ q: value.trim() || undefined })}
          />
          <Pick label="品牌" value={view.brand} options={same(options?.brands)} onChange={value => change({ brand: value })} width={130} />
          <Pick label="类目" value={view.category} options={same(options?.categories)} onChange={value => change({ category: value })} width={160} />
          <Pick
            label="刊登状态"
            value={view.status}
            options={(options?.statuses ?? []).map(status => ({ value: status, label: PRODUCT_LISTING_LABEL[status] ?? status }))}
            onChange={value => change({ status: value })}
            width={110}
          />
          <Pick
            label="配送方式"
            value={view.fulfillment}
            options={PRODUCT_CHANNELS.map(channel => ({ value: channel, label: PRODUCT_CHANNEL_LABEL[channel] }))}
            onChange={value => change({ fulfillment: value as ListingView['fulfillment'] })}
            width={140}
          />
          <Pick label="负责人" value={view.ownerId} options={(options?.owners ?? []).map(item => ({ value: item.id, label: item.name }))} onChange={value => change({ ownerId: value })} width={120} />
        </Space>
        <MassiveGrid<ListingPerfRow>
          gridId="listings.performance"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={LISTING_SORTABLE}
          defaultSort={DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, filters])}
          appliedFilterCount={appliedCount}
          onClearFilters={() => setView(DEFAULT_VIEW)}
          onCompare={rows => setComparing(rows)}
          emptyState={{
            kind: 'empty',
            domain: '商品',
            prerequisite: filtered ? '没有符合条件的商品；可以放宽筛选条件。' : (meta?.note ?? '还没有同步到商品；连接店铺并同步商品目录后显示。'),
          }}
          height={620}
        />
        {meta ? <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{meta.basis}</p> : null}
      </Card>
      <CompareDrawer rows={comparing ?? []} open={comparing !== null} onClose={() => setComparing(null)} />
    </div>
  )
}
