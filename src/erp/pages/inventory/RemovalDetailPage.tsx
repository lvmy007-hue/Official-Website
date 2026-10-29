import { useParams } from '@tanstack/react-router'
import { Alert, Card, Descriptions, Space, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { RemovalDetailResponse, RemovalLine, RemovalReceiptRow, RemovalReconRow, RemovalShipmentRow } from '@nova/api-contracts'
import { DataState, FreshnessBar, PageHeader, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { fee, GuideAlert, Muted, qty, ReceiptStateTag } from './inventory-ui'
import { ReceiptAction } from './ReceiptAction'

// 移除订单详情（P2a-09，06 章 6.5）：订单信息、明细行、货件、时间线、退回地址、收货核对与登记记录。
// 亚马逊的移除订单报告里没有退回地址：如实写“尚未接入”，不显示空地址。收货核对的应收是订单已发货数量，实收来自人工登记。

const lineColumns: ColumnsType<RemovalLine> = [
  { title: 'SKU', dataIndex: 'sku', width: 160 },
  { title: '处置状态', dataIndex: 'disposition', width: 110, render: (value: string) => value || <Muted>尚无记录</Muted> },
  { title: '请求', dataIndex: 'requestedQty', align: 'right', width: 80, render: qty },
  { title: '已发货', dataIndex: 'shippedQty', align: 'right', width: 80, render: qty },
  { title: '已弃置', dataIndex: 'disposedQty', align: 'right', width: 80, render: qty },
  { title: '已取消', dataIndex: 'cancelledQty', align: 'right', width: 80, render: qty },
  { title: '处理中', dataIndex: 'inProcessQty', align: 'right', width: 80, render: qty },
  { title: '费用', key: 'fee', align: 'right', width: 110, render: (_value, row) => fee(row.fee, row.currency) },
]

const shipmentColumns: ColumnsType<RemovalShipmentRow> = [
  { title: '货件编号', dataIndex: 'shipmentId', width: 150 },
  { title: 'SKU', dataIndex: 'sku', width: 160 },
  { title: '承运商', dataIndex: 'carrier', width: 100, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '运单号', dataIndex: 'trackingNumber', width: 160, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '发货数量', dataIndex: 'shippedQty', align: 'right', width: 90, render: qty },
  { title: '发货日期', dataIndex: 'shipDate', width: 110, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
]

const reconColumns: ColumnsType<RemovalReconRow> = [
  { title: 'SKU', dataIndex: 'sku', width: 160 },
  { title: '应收（已发货）', dataIndex: 'expectedQty', align: 'right', width: 120, render: qty },
  { title: '实收', dataIndex: 'receivedQty', align: 'right', width: 80, render: qty },
  { title: '良品', dataIndex: 'sellableQty', align: 'right', width: 80, render: qty },
  { title: '损坏', dataIndex: 'damagedQty', align: 'right', width: 80, render: qty },
  {
    title: '差异',
    dataIndex: 'difference',
    align: 'right',
    width: 80,
    render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{value > 0 ? `+${value}` : value}</span>),
  },
  { title: '核对结果', key: 'state', width: 120, render: (_value, row) => <ReceiptStateTag state={row.state} /> },
]

const receiptColumns: ColumnsType<RemovalReceiptRow> = [
  { title: '收货日期', dataIndex: 'receivedAt', width: 110 },
  { title: 'SKU', dataIndex: 'sku', width: 160 },
  { title: '实收', dataIndex: 'receivedQty', align: 'right', width: 80, render: qty },
  { title: '良品', dataIndex: 'sellableQty', align: 'right', width: 80, render: qty },
  { title: '损坏', dataIndex: 'damagedQty', align: 'right', width: 80, render: qty },
  { title: '登记人', dataIndex: 'receivedBy', width: 120 },
  { title: '备注', dataIndex: 'note', render: (value: string | null) => value ?? <Muted>无</Muted> },
]

// 时间线的日期可能只有年月日（订单报告里的日期）：原样显示，不换算时区
const when = (at: string) => (/^\d{4}-\d{2}-\d{2}$/.test(at) ? at : formatDateTime(at))

function Overview({ detail }: { detail: RemovalDetailResponse }) {
  const order = detail.order
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered>
      <Descriptions.Item label="店铺">{order.storeName}</Descriptions.Item>
      <Descriptions.Item label="类型">{order.typeLabel}</Descriptions.Item>
      <Descriptions.Item label="状态">{order.statusLabel}</Descriptions.Item>
      <Descriptions.Item label="请求日期">{order.requestDate}</Descriptions.Item>
      <Descriptions.Item label="最近更新">{order.lastUpdatedDate ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
      <Descriptions.Item label="服务速度">{order.serviceSpeed ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
      <Descriptions.Item label="请求 / 已发货 / 已弃置">
        {order.requestedQty} / {order.shippedQty} / {order.disposedQty}
      </Descriptions.Item>
      <Descriptions.Item label="订单费用">{fee(order.fee, order.currency)}</Descriptions.Item>
      <Descriptions.Item label="收货核对">
        <ReceiptStateTag state={order.receiptState} />
      </Descriptions.Item>
      <Descriptions.Item label="退回地址" span={3}>
        <Muted>尚未接入</Muted>
        <Typography.Text type="secondary"> {detail.returnAddress.note}</Typography.Text>
      </Descriptions.Item>
    </Descriptions>
  )
}

export default function RemovalDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<RemovalDetailResponse>({ domain: 'list', path: `/inventory/removals/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'inventory.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data

  return (
    <div>
      <PageHeader title={`移除订单 ${detail.order.orderId}`} description="移除订单的明细、货件、时间线与退回件收货核对。" actions={<ReceiptAction id={id} detail={detail} />} />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <AppLink to="/app/inventory/removals">返回移除与弃置</AppLink>
        <FreshnessBar freshness={detail.freshness} />
        {detail.order.type !== 'RETURN' ? <Alert type="info" showIcon message="这不是退回订单" description={detail.canReceive.reason ?? '只有退回类订单需要登记收货。'} /> : null}
        <Overview detail={detail} />
        <Card size="small" title="收货核对">
          <SimpleGrid<RemovalReconRow>
            gridId="inventory.removal-detail-page"
            columns={reconColumns}
            rows={detail.reconciliation}
            rowKey={row => row.sku}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '没有已发货的 SKU，无需核对' }}
          />
          {detail.receipts.length ? (
            <SimpleGrid<RemovalReceiptRow>
              gridId="inventory.removal-detail-page-2"
              columns={receiptColumns}
              rows={detail.receipts}
              rowKey={row => row.id}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          ) : (
            <div style={{ marginTop: 8 }}>
              <Muted>尚无收货登记</Muted>
            </div>
          )}
        </Card>
        <Card size="small" title="订单明细">
          <SimpleGrid<RemovalLine>
            gridId="inventory.removal-detail-page-3"
            columns={lineColumns}
            rows={detail.lines}
            rowKey={row => `${row.sku}|${row.disposition}`}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
        </Card>
        <Card size="small" title="货件">
          {detail.shipments.length ? (
            <SimpleGrid<RemovalShipmentRow>
              gridId="inventory.removal-detail-page-4"
              columns={shipmentColumns}
              rows={detail.shipments}
              rowKey={row => `${row.shipmentId}|${row.sku}`}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          ) : (
            <Muted>尚无货件记录</Muted>
          )}
        </Card>
        <Card size="small" title="时间线">
          {detail.timeline.length ? (
            <Timeline
              items={detail.timeline.map(item => ({
                children: (
                  <>
                    <Typography.Text strong>{item.title}</Typography.Text> <Typography.Text type="secondary">{when(item.at)}</Typography.Text>
                    {item.detail ? <div>{item.detail}</div> : null}
                  </>
                ),
              }))}
            />
          ) : (
            <Muted>尚无记录</Muted>
          )}
        </Card>
        <GuideAlert guide={detail.guide} />
      </Space>
    </div>
  )
}
