import { Alert, Descriptions, Typography } from 'antd'
import { ORDER_REFUND_LABEL, type OrderReturnRow, type OrderReturnsResponse, type OrderTransactionRow, type OrderTransactionsResponse } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { useOrderTab } from './orders-tabs'
import { DetailGrid } from './DetailGrid'
import { refundColumns, returnColumns, transactionColumns, type RefundRow } from './order-detail-columns'
import { money, RefundCell, SettlementTag } from './orders-ui'

// 订单详情里需要额外权限的两个页签：退款与退货（returns.read）、财务交易（finance.read）。没有权限时页签不出现，接口也会拒绝。

export function ReturnsTab({ id, currency }: { id: string; currency: string }) {
  const query = useOrderTab<OrderReturnsResponse>(id, 'returns')
  const data = query.data
  const link = (order: { id: string | null; amazonOrderId: string }) =>
    order.id ? <AppLink to={`/app/orders/${encodeURIComponent(order.id)}`}>{order.amazonOrderId}</AppLink> : <span className="erp-num">{order.amazonOrderId}</span>
  return (
    <div>
      {data ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered title="退款（财务交易里的退款明细）" data-testid="order-refund-summary">
          <Descriptions.Item label="退款状态">
            <RefundCell refund={data.refund} currency={currency} />
          </Descriptions.Item>
          <Descriptions.Item label="退款合计">{data.refundTotal === null ? <Muted>{ORDER_REFUND_LABEL.PENDING_DATA}</Muted> : money(data.refundTotal, currency)}</Descriptions.Item>
          <Descriptions.Item label="退款笔数">{data.refunds.length === 0 ? <Muted>尚无记录</Muted> : <span className="erp-num">{data.refunds.length}</span>}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {data && data.refunds.length > 0 ? (
        <DetailGrid<RefundRow>
          gridId="orders.detail.refunds"
          height={200}
          columns={refundColumns}
          rows={data.refunds}
          getRowId={row => `${row.postedAt}|${row.amount}`}
          emptyState={{ kind: 'empty', domain: '退款', prerequisite: '没有退款记录。' }}
        />
      ) : null}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        退货记录
      </Typography.Title>
      <DetailGrid<OrderReturnRow>
        gridId="orders.detail.returns"
        height={260}
        columns={returnColumns}
        rows={data?.returns}
        getRowId={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '退货', prerequisite: '这个订单目前没有退货记录；退货报告每日同步一次。' }}
      />
      {data ? (
        <Descriptions size="small" column={1} bordered style={{ marginTop: 16 }} title="替换关系" data-testid="order-replacement">
          <Descriptions.Item label="本单是否为替换订单">{data.replacement.isReplacement ? `是${data.replacement.reason ? `（${data.replacement.reason}）` : ''}` : '否'}</Descriptions.Item>
          <Descriptions.Item label="原订单">{data.replacement.original ? link(data.replacement.original) : <Muted>无</Muted>}</Descriptions.Item>
          <Descriptions.Item label="替换出的订单">
            {data.replacement.replacedBy.length === 0 ? (
              <Muted>无</Muted>
            ) : (
              data.replacement.replacedBy.map(item => (
                <div key={item.id}>
                  {link(item)}
                  {item.reason ? <Muted>（{item.reason}）</Muted> : null}
                </div>
              ))
            )}
          </Descriptions.Item>
        </Descriptions>
      ) : null}
    </div>
  )
}

export function TransactionsTab({ id }: { id: string }) {
  const query = useOrderTab<OrderTransactionsResponse>(id, 'transactions')
  const data = query.data
  return (
    <div>
      {data ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ marginBottom: 12 }}>
          <Descriptions.Item label="结算状态">
            <SettlementTag settlement={data.settlement} />
          </Descriptions.Item>
          <Descriptions.Item label="交易条数">{data.total === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{data.total}</span>}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {data?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="这个订单的财务交易很多，只显示了最近的一部分" /> : null}
      <DetailGrid<OrderTransactionRow>
        gridId="orders.detail.transactions"
        height={420}
        columns={transactionColumns}
        rows={data?.items}
        getRowId={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '财务交易', prerequisite: '这个订单还没有财务交易记录；亚马逊通常在发货后才生成，财务交易每 4 小时同步一次。' }}
      />
    </div>
  )
}
