import { Alert, Descriptions, Timeline, Typography } from 'antd'
import type {
  OrderChargeLine,
  OrderFeeLine,
  OrderChargesResponse,
  OrderIdentityResponse,
  OrderItemRow,
  OrderItemsResponse,
  OrderPackageRow,
  OrderPackagesResponse,
  OrderRisk,
  OrderRisksResponse,
  OrderTimelineResponse,
} from '@nova/api-contracts'
import { DetailGrid } from './DetailGrid'
import { chargeColumns, feeColumns, itemColumns, packageColumns, riskColumns } from './order-detail-columns'
import { formatMoney } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { money, timeText } from './orders-ui'

// 订单详情的基础页签：概览、订单行、收入与费用、履约与包裹、时间线、风险标记。页签只在被打开时才取数。
// 没有数据的位置写“尚无记录”，没接入的写“尚未接入”，都不写 0。

export const useOrderTab = <T,>(id: string, suffix: string) => useApiQuery<T>({ domain: 'list', path: `/orders/${encodeURIComponent(id)}/${suffix}`, scoped: false })

export function OverviewTab({ detail }: { detail: OrderIdentityResponse }) {
  const { promise, basis, keyTimes } = detail.overview
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered title="配送承诺">
        <Descriptions.Item label="最晚发货">{timeText(promise.latestShipDate)}</Descriptions.Item>
        <Descriptions.Item label="最早送达">{timeText(promise.earliestDelivery)}</Descriptions.Item>
        <Descriptions.Item label="最晚送达">{timeText(promise.latestDelivery)}</Descriptions.Item>
        <Descriptions.Item label="承运商">{basis.carriers.length ? basis.carriers.join('、') : <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="配送服务">{basis.services.length ? basis.services.join('、') : <Muted>尚无记录</Muted>}</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" style={{ margin: '8px 0 16px' }}>
        {basis.note}
      </Typography.Paragraph>
      <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered title="关键时间" data-testid="order-key-times">
        {keyTimes.map(item => (
          <Descriptions.Item key={item.key} label={item.label}>
            {timeText(item.at)}
          </Descriptions.Item>
        ))}
      </Descriptions>
    </div>
  )
}

export function ItemsTab({ id }: { id: string }) {
  const query = useOrderTab<OrderItemsResponse>(id, 'items')
  const data = query.data
  return (
    <div>
      {data?.cancellation ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`${data.cancellation.cancelledByLabel}${data.cancellation.cancelledAt ? '已取消订单' : '提出了取消请求，订单尚未取消'}`}
          description={`原因代码：${data.cancellation.reasonCode || '未提供'}`}
        />
      ) : null}
      <DetailGrid<OrderItemRow>
        gridId="orders.detail.items"
        height={320}
        columns={itemColumns}
        rows={data?.items}
        getRowId={row => row.orderItemId}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '订单行', prerequisite: '订单行由订单接口同步；这个订单还没有订单行记录。' }}
      />
      {data ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="关联商品：尚未接入" description={data.associatedItems.note} /> : null}
    </div>
  )
}

function MatchAlert({ match, currency }: { match: OrderChargesResponse['match']; currency: string }) {
  const diff = (label: string, pair: { order: number; finance: number; diff: number } | null) =>
    pair
      ? `${label}：订单接口 ${formatMoney(pair.order, currency, { digits: 2 })}，财务交易 ${formatMoney(pair.finance, currency, { digits: 2 })}，差 ${formatMoney(pair.diff, currency, { digits: 2 })}`
      : null
  const lines = [diff('收入', match.revenue), diff('税', match.tax)].filter(Boolean)
  const type = match.state === 'MATCHED' ? 'success' : match.state === 'DIFF' ? 'warning' : 'info'
  return (
    <Alert
      type={type}
      showIcon
      style={{ marginBottom: 12 }}
      message={match.state === 'MATCHED' ? '与财务交易一致' : match.state === 'DIFF' ? '与财务交易有差异' : '暂时无法与财务交易比对'}
      description={
        <>
          {match.note}
          {lines.map(line => (
            <div key={line}>{line}</div>
          ))}
        </>
      }
    />
  )
}

export function ChargesTab({ id }: { id: string }) {
  const query = useOrderTab<OrderChargesResponse>(id, 'charges')
  const data = query.data
  return (
    <div>
      {data ? <MatchAlert match={data.match} currency={data.currency} /> : null}
      {data?.revenue ? (
        <Descriptions size="small" column={{ xs: 1, md: 3, xl: 4 }} bordered title="订单收入（订单接口给出）" data-testid="order-revenue">
          <Descriptions.Item label="商品">{money(data.revenue.item, data.currency)}</Descriptions.Item>
          <Descriptions.Item label="运费">{money(data.revenue.shipping, data.currency)}</Descriptions.Item>
          <Descriptions.Item label="促销折扣">{money(data.revenue.promotion, data.currency)}</Descriptions.Item>
          <Descriptions.Item label="其他">{money(data.revenue.other, data.currency)}</Descriptions.Item>
          <Descriptions.Item label="不含税合计">{money(data.revenue.totalExTax, data.currency)}</Descriptions.Item>
          <Descriptions.Item label="税">{money(data.revenue.tax, data.currency)}</Descriptions.Item>
          <Descriptions.Item label="含税合计">{money(data.revenue.total, data.currency)}</Descriptions.Item>
        </Descriptions>
      ) : data ? (
        <Alert type="info" showIcon message="订单收入：尚无记录" description="订单接口还没有给出这个订单的逐项金额。" />
      ) : null}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        收入明细
      </Typography.Title>
      <DetailGrid<OrderChargeLine>
        gridId="orders.detail.charges"
        height={300}
        columns={chargeColumns}
        rows={data?.lines}
        getRowId={row => `${row.orderItemId}|${row.kind}|${row.componentKey}`}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '收入明细', prerequisite: '订单接口还没有给出这个订单的逐项金额。' }}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        亚马逊费用（财务交易明细）
      </Typography.Title>
      <DetailGrid<OrderFeeLine>
        gridId="orders.detail.fees"
        height={300}
        columns={feeColumns}
        rows={data?.fees}
        getRowId={row => `${row.path}|${row.postedAt}`}
        loading={query.isFetching}
        emptyState={{ kind: 'empty', domain: '费用明细', prerequisite: '这个订单还没有财务交易明细，亚马逊通常在发货后才生成；明细按路径关键字归为费用，不是官方分类。' }}
      />
      {data && data.feeTotal !== null ? <div style={{ marginTop: 8 }}>费用合计：{money(data.feeTotal, data.currency)}</div> : null}
      {data?.netIncome ? (
        <Alert
          style={{ marginTop: 12 }}
          type={data.netIncome.state === 'OK' ? 'success' : 'info'}
          showIcon
          message={data.netIncome.state === 'OK' ? <>净收益（财务交易合计）：{money(data.netIncome.value, data.currency)}</> : '净收益：待财务交易'}
          description={data.netIncome.note}
        />
      ) : null}
    </div>
  )
}

export function PackagesTab({ id }: { id: string }) {
  const query = useOrderTab<OrderPackagesResponse>(id, 'packages')
  return (
    <div>
      <DetailGrid<OrderPackageRow>
        gridId="orders.detail.packages"
        height={300}
        columns={packageColumns}
        rows={query.data?.packages}
        getRowId={row => `${row.packageId}|${row.trackingNumber ?? ''}`}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '包裹', prerequisite: '订单发货后，订单接口或物流报告（每日同步）会带来承运商与追踪号。' }}
      />
      {query.data ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="逐段物流节点：尚未接入" description={query.data.tracking.note} /> : null}
    </div>
  )
}

const KIND_COLOR: Record<string, string> = { PURCHASE: 'blue', STATUS: 'green', CANCELLATION: 'red', PACKAGE: 'cyan' }

export function TimelineTab({ id }: { id: string }) {
  const query = useOrderTab<OrderTimelineResponse>(id, 'timeline')
  const data = query.data
  return (
    <div>
      <Timeline
        items={(data?.items ?? []).map((item, index) => ({
          key: `${item.at}|${index}`,
          color: KIND_COLOR[item.kind],
          children: (
            <div>
              {item.title}
              <div>
                <span className="erp-num">{timeText(item.at)}</span> <Typography.Text type="secondary">· {item.source}</Typography.Text>
              </div>
            </div>
          ),
        }))}
      />
      {data ? <Alert type="info" showIcon message="订单变更推送：尚未接入" description={data.push.note} /> : null}
    </div>
  )
}

export function RisksTab({ id }: { id: string }) {
  const query = useOrderTab<OrderRisksResponse>(id, 'risks')
  const items: OrderRisk[] | undefined = query.data?.items
  return (
    <div>
      <Typography.Paragraph type="secondary">风险标记依据财务交易、退货与取消记录判断；财务交易还没同步的订单，退款与税务异常无法判断。</Typography.Paragraph>
      <DetailGrid<OrderRisk>
        gridId="orders.detail.risks"
        height={240}
        columns={riskColumns}
        rows={items}
        getRowId={row => row.kind}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '风险标记', prerequisite: '这个订单目前没有风险标记。' }}
      />
    </div>
  )
}
