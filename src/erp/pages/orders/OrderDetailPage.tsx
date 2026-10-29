import { useParams } from '@tanstack/react-router'
import { ORDERS_BUYER_FIELD, ORDERS_FINANCE_PERMISSION, ORDERS_RETURNS_PERMISSION, ORDER_RISK_LABEL, type OrderIdentityResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { BuyerInfoTab } from './BuyerInfoTab'
import { ReturnsTab, TransactionsTab } from './orders-tabs-finance'
import { ChargesTab, ItemsTab, OverviewTab, PackagesTab, RisksTab, TimelineTab } from './orders-tabs'
import { RefundCell, SettlementTag, count, money, NetIncomeCell } from './orders-ui'

// 订单详情（P2b-01，07 章 7.1；P6-05 起用整页详情骨架）：头部信息卡（编码字段组与最多 6 项关键指标，滚动时收缩吸顶）→ 吸顶页签（9 个）。页签只在被打开时才取数。
// 退款与退货、财务交易、买家信息三个页签要额外权限：没有权限时页签不出现（接口也会拒绝）。

const metricsOf = (detail: OrderIdentityResponse): IdentityMetric[] => {
  const { order } = detail
  const metrics: IdentityMetric[] = [
    { label: '订单金额', value: money(order.amount, order.currency) },
    {
      label: '件数（订单行）',
      value: (
        <span>
          {count(order.units)}
          {order.lineCount > 0 ? <Muted>（{order.lineCount} 行）</Muted> : null}
        </span>
      ),
    },
    { label: '结算', value: <SettlementTag settlement={detail.settlement} /> },
    { label: '退款', value: <RefundCell refund={detail.refund} currency={order.currency} /> },
    { label: '退货', value: detail.returnCount > 0 ? <span className="erp-num">{detail.returnCount} 笔</span> : <Muted>无</Muted> },
  ]
  if (detail.netIncome) metrics.push({ label: '净收益（财务交易合计）', value: <NetIncomeCell value={detail.netIncome.value} currency={detail.netIncome.currency} /> })
  return metrics
}

const statusesOf = (detail: OrderIdentityResponse): StatusTag[] => {
  const { order } = detail
  const tags: StatusTag[] = [{ text: order.statusLabel, color: order.status === 'Canceled' ? 'error' : 'default' }]
  if (order.fulfillmentLabel) tags.push({ text: order.fulfillmentLabel })
  if (order.isReplacement) tags.push({ text: '替换订单', color: 'processing' })
  for (const program of order.programs) tags.push({ text: program })
  for (const risk of detail.risks) tags.push({ text: ORDER_RISK_LABEL[risk], color: risk === 'REFUND' || risk === 'FINANCE_DIFF' ? 'error' : 'warning' })
  return tags
}

export default function OrderDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { canPermission } = useSession()
  const query = useApiQuery<OrderIdentityResponse>({ domain: 'list', path: `/orders/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'orders.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  const { order } = detail
  const tabs = [
    { key: 'overview', label: '概览', children: <OverviewTab detail={detail} /> },
    { key: 'items', label: '订单行', children: <ItemsTab id={id} /> },
    { key: 'charges', label: '收入与费用', children: <ChargesTab id={id} /> },
    { key: 'packages', label: '履约与包裹', children: <PackagesTab id={id} /> },
    ...(canPermission(ORDERS_RETURNS_PERMISSION) ? [{ key: 'returns', label: '退款与退货', children: <ReturnsTab id={id} currency={order.currency} /> }] : []),
    ...(canPermission(ORDERS_FINANCE_PERMISSION) ? [{ key: 'transactions', label: '财务交易', children: <TransactionsTab id={id} /> }] : []),
    ...(detail.buyerInfo.access === 'ALLOWED' && canPermission(ORDERS_BUYER_FIELD)
      ? [{ key: 'buyer', label: '买家信息', children: <BuyerInfoTab id={id} state={detail.buyerInfo.state} expiresAt={detail.buyerInfo.expiresAt} /> }]
      : []),
    { key: 'timeline', label: '时间线', children: <TimelineTab id={id} /> },
    { key: 'risks', label: '风险标记', children: <RisksTab id={id} /> },
  ]
  return (
    <DetailLayout
      title={order.amazonOrderId}
      codes={[{ label: '店铺', value: order.storeName }, ...(order.salesChannel ? [{ label: '销售渠道', value: order.salesChannel }] : []), { label: '站点', value: order.marketplaceId }]}
      statuses={statusesOf(detail)}
      metrics={metricsOf(detail)}
      freshness={{ lastSuccessAt: detail.freshness.lastSuccessAt, sources: detail.freshness.sources, qualityIssues: detail.freshness.qualityIssues }}
      tabs={tabs}
    />
  )
}
