import { useCallback, useMemo, useState } from 'react'
import { Alert, Card } from 'antd'
import {
  ORDER_RISK_FILTERS,
  ORDER_RISK_LABEL,
  ORDER_SETTLEMENT_LABEL,
  ORDER_STATUS_OPTIONS,
  orderStatusLabel,
  type OrderListResponse,
  type OrderListRow,
  type OrderNetIncomeResponse,
} from '@nova/api-contracts'
import { FilterBar, FreshnessBar, MassiveGrid, PageHeader, useUrlFilters, type CursorFetcher, type FilterField, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { apiFetch } from '../../../api'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { useSession } from '../../session/session'
import { ORDER_DEFAULT_SORT, ORDER_SORTABLE, orderColumns, type OrderNetFetcher } from './orders-columns'

// 订单（P2b-01，07 章 7.1；P6-04 迁到 MassiveGrid 骨架与统一筛选栏）：只看亚马逊物流订单。游标分页（无限滚动），默认只看最近 30 天。
// 买家个人信息不在这里出现；退款、退货、结算、风险来自财务交易与退货记录，没有财务交易时写“待财务交易”，不写“无退款”或 0。
// 筛选都写在地址栏里；搜索框可以粘贴多行批量查订单号或追踪号（精确匹配，最多 500 个）；日期范围取全局范围栏。

const TRI = [
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
]
const FIELDS: FilterField[] = [
  { key: 'status', label: '订单状态', kind: 'select', options: ORDER_STATUS_OPTIONS.map(value => ({ value, label: orderStatusLabel(value) })) },
  {
    key: 'settlement',
    label: '结算状态',
    kind: 'select',
    options: [
      { value: 'NONE', label: ORDER_SETTLEMENT_LABEL.NONE },
      { value: 'DEFERRED', label: ORDER_SETTLEMENT_LABEL.DEFERRED },
      { value: 'RELEASED', label: ORDER_SETTLEMENT_LABEL.RELEASED },
    ],
  },
  { key: 'risk', label: '风险', kind: 'select', options: ORDER_RISK_FILTERS.map(value => ({ value, label: ORDER_RISK_LABEL[value] })) },
  { key: 'refunded', label: '是否退款', kind: 'select', placement: 'more', options: TRI },
  { key: 'returned', label: '是否退货', kind: 'select', placement: 'more', options: TRI },
  { key: 'replacement', label: '是否替换', kind: 'select', placement: 'more', options: TRI },
  { key: 'promotion', label: '是否促销', kind: 'select', placement: 'more', options: TRI },
  { key: 'sku', label: 'SKU', kind: 'text', placement: 'more' },
  { key: 'asin', label: 'ASIN', kind: 'text', placement: 'more' },
]
const MODES: SearchMode[] = [{ id: 'order', label: '订单号或追踪号', key: 'q', batchKey: 'qs', batchLabel: '订单号 / 追踪号', placeholder: '搜索订单号或追踪号；可粘贴多行批量查' }]

type ListMeta = Pick<OrderListResponse, 'freshness' | 'range' | 'filterLimited' | 'note'>

export default function OrdersPage() {
  const { apiParams } = useScope()
  const { canPermission } = useSession()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<ListMeta | null>(null)
  // 净收益是异步列（主列表先出，只对屏幕上的行批量取）；没有 field.profit 时整列不出现
  const showProfit = canPermission('field.profit')
  const netFetcher = useCallback<OrderNetFetcher>(
    (ids, signal) => apiFetch<OrderNetIncomeResponse>(buildPath('/orders/net-income', apiParams), { method: 'POST', body: JSON.stringify({ ids }), signal }),
    [apiParams],
  )
  const columns = useMemo(() => orderColumns(showProfit ? netFetcher : null), [showProfit, netFetcher])

  const fetchPage = useCallback<CursorFetcher<OrderListRow>>(
    async ({ cursor, limit, sort, signal }) => {
      const path = buildPath('/orders', { ...apiParams, ...values, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined })
      const response = await apiFetch<OrderListResponse>(path, { signal })
      // 范围、新鲜度与提示以第一块为准（后续块的游标只管翻页）
      if (cursor === null) {
        setMeta({
          freshness: response.freshness,
          range: response.range,
          filterLimited: response.filterLimited,
          note: response.note,
        })
      }
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    [apiParams, values],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const filtered = Object.keys(values).length > 0

  return (
    <div>
      <PageHeader title="订单" description="亚马逊物流订单：状态、金额、履约、退款、退货、结算与风险。未选择时间范围时只看最近 30 天；买家个人信息只能在订单详情里填写理由后查看。" />
      <Card size="small">
        <FreshnessBar freshness={meta?.freshness} />
        {meta?.range.defaulted ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择下单日期范围，当前显示 ${meta.range.from} 至 ${meta.range.to} 的订单`} /> : null}
        {meta?.filterLimited ? (
          <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="退款、退货或结算筛选命中的订单太多，结果可能不完整" description="请缩小下单日期范围或选择店铺后再筛选。" />
        ) : null}
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <MassiveGrid<OrderListRow>
          gridId="orders.list"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={ORDER_SORTABLE}
          defaultSort={ORDER_DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, url.signature])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          emptyState={{
            kind: 'empty',
            domain: '订单',
            prerequisite: filtered
              ? '没有符合条件的订单；可以放宽筛选条件或扩大下单日期范围。'
              : (meta?.note ?? '所选日期范围内尚无订单记录；店铺授权并完成订单同步后显示（订单每 15 分钟补偿同步一次）。'),
          }}
          height={620}
        />
      </Card>
    </div>
  )
}
