import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Alert, Card, Descriptions, Space, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { AWD_PACKAGE_TYPE_LABEL, AWD_REGION_LABEL, awdPackageUnits, type AwdOrderDetail, type AwdPackageInput, type AwdShipmentRow } from '@nova/api-contracts'
import { DataState, PageHeader, RowDetailDrawer, SimpleGrid, stateFromError, useRowDetail } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { LabelActions } from './awd-tables'
import { OrderActions } from './awd-order-actions'
import { OrderStatusTag, qty } from './awd-ui'
import { AwdOrderDrawer } from './AwdOrderDrawer'

// 入库订单详情（P2a-08）：状态与处理中提示、地址与包装、亚马逊货件（含标签）、时间线。
// 订单状态在提交、确认后是“预期状态”，下一次同步（每 2 小时）才会按亚马逊的真实状态校正；失败原因写在页面顶部。

const dims = (pack: AwdPackageInput) => {
  const d = pack.measurements.dimensions
  const w = pack.measurements.weight
  return `${w.value} ${w.unit === 'KILOGRAMS' ? '千克' : '磅'}；${d ? `${d.length}×${d.width}×${d.height} ${d.unit === 'CENTIMETERS' ? '厘米' : '英寸'}` : '尺寸未填'}`
}

const contentOf = (pack: AwdPackageInput) =>
  pack.packages?.length
    ? pack.packages.map(inner => `${inner.count} 箱 × [${(inner.products ?? []).map(item => `${item.sku}×${item.quantity}`).join('、')}]`).join('；')
    : (pack.products ?? []).map(item => `${item.sku} × ${item.quantity}${item.expiration ? `（到期 ${item.expiration}）` : ''}`).join('、')

const packageColumns: ColumnsType<AwdPackageInput> = [
  { title: '包装方式', dataIndex: 'type', width: 100, render: (value: AwdPackageInput['type']) => AWD_PACKAGE_TYPE_LABEL[value] },
  { title: '数量', dataIndex: 'count', width: 80, align: 'right' },
  { title: '重量与尺寸（每个）', key: 'dims', width: 280, render: (_value, row) => dims(row) },
  { title: '内容', key: 'content', render: (_value, row) => contentOf(row) },
]

const shipmentColumns: ColumnsType<AwdShipmentRow> = [
  { title: '货件编号', dataIndex: 'shipmentId', width: 190 },
  { title: '状态', dataIndex: 'statusLabel', width: 100 },
  { title: '承运商', dataIndex: 'carrier', width: 100, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '运单号', dataIndex: 'trackingNumber', width: 150, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '预计件数', dataIndex: 'expectedUnits', align: 'right', width: 100, render: qty },
  { title: '已接收件数', dataIndex: 'receivedUnits', align: 'right', width: 110, render: qty },
  { title: '标签', key: 'label', width: 200, render: (_value, row) => <LabelActions shipment={row} /> },
]

function Overview({ order }: { order: AwdOrderDetail }) {
  const units = order.packages.length ? awdPackageUnits(order.packages) : null
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered>
      <Descriptions.Item label="店铺">{order.storeName}</Descriptions.Item>
      <Descriptions.Item label="亚马逊订单编号">{order.orderId ?? <Muted>尚未提交亚马逊</Muted>}</Descriptions.Item>
      <Descriptions.Item label="我方参考号">{order.externalReferenceId ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
      <Descriptions.Item label="状态">
        <OrderStatusTag order={order} />
      </Descriptions.Item>
      <Descriptions.Item label="预计件数">{qty(order.expectedUnits ?? units)}</Descriptions.Item>
      <Descriptions.Item label="已接收件数">{qty(order.receivedUnits)}</Descriptions.Item>
      <Descriptions.Item label="期望入库区域">
        {order.preferredRegion ? (AWD_REGION_LABEL[order.preferredRegion as keyof typeof AWD_REGION_LABEL] ?? order.preferredRegion) : <Muted>未指定</Muted>}
      </Descriptions.Item>
      <Descriptions.Item label="实际目的区域">{order.destinationRegion ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
      <Descriptions.Item label="更新时间">{formatDateTime(order.updatedAt)}</Descriptions.Item>
      <Descriptions.Item label="发货地址" span={3}>
        {order.originAddress ? (
          [
            order.originAddress.name,
            order.originAddress.addressLine1,
            order.originAddress.addressLine2,
            order.originAddress.city,
            order.originAddress.stateOrRegion,
            order.originAddress.postalCode,
            order.originAddress.countryCode,
          ]
            .filter(Boolean)
            .join('，')
        ) : (
          <Muted>尚未填写</Muted>
        )}
      </Descriptions.Item>
      {order.note ? (
        <Descriptions.Item label="备注" span={3}>
          {order.note}
        </Descriptions.Item>
      ) : null}
    </Descriptions>
  )
}

/** 亚马逊货件：点行在抽屉里看该货件的商品明细（取代行内展开）。 */
function ShipmentsGrid({ shipments }: { shipments: AwdShipmentRow[] }) {
  const detail = useRowDetail()
  return (
    <>
      <SimpleGrid<AwdShipmentRow>
        gridId="awd.order-shipments"
        columns={shipmentColumns}
        rows={shipments}
        rowKey={row => row.id}
        onRowOpen={row => detail.open(row.id)}
        emptyState={{ kind: 'empty', domain: '亚马逊入库货件', prerequisite: '订单提交并确认后才会有货件' }}
      />
      <RowDetailDrawer rows={shipments} rowKey={row => row.id} openKey={detail.openKey} onClose={detail.close} title={row => `货件 ${row.shipmentId}`} width={640}>
        {row => (
          <SimpleGrid<NonNullable<AwdShipmentRow['items']>[number]>
            gridId="awd.order-shipment-items"
            rows={row.items ?? []}
            rowKey={item => item.sku}
            emptyState={{ kind: 'empty', domain: '货件商品', prerequisite: '亚马逊还没有返回这个货件的商品明细' }}
            columns={[
              { title: 'SKU', dataIndex: 'sku' },
              { title: '预计', dataIndex: 'expectedQty', align: 'right', render: qty },
              { title: '已接收', dataIndex: 'receivedQty', align: 'right', render: qty },
              { title: '单位', dataIndex: 'unit', render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
              { title: '到期日', dataIndex: 'expiryDate', render: (value: string | null) => value ?? <Muted>无</Muted> },
            ]}
          />
        )}
      </RowDetailDrawer>
    </>
  )
}

export default function AwdOrderDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [editing, setEditing] = useState(false)
  const query = useApiQuery<AwdOrderDetail>({ domain: 'list', path: `/awd/orders/${encodeURIComponent(id)}`, scoped: false })
  const stores = useApiQuery<{ stores: Array<{ id: string; name: string }> }>({ domain: 'reference', path: '/scope/options', scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'awd.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const order = query.data

  return (
    <div>
      <PageHeader
        title={`入库订单 ${order.orderId ?? order.externalReferenceId ?? order.id}`}
        description="上游仓储（AWD）入库订单：包装、亚马逊货件与操作记录。"
        actions={<OrderActions order={order} onEdit={() => setEditing(true)} />}
      />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <AppLink to="/app/awd">返回上游仓储</AppLink>
        {order.pendingAction ? <Alert type="info" showIcon message="有操作正在由后台任务处理" description="处理完成前不能再做其他操作；订单状态会在完成后更新，也可能被下一次同步校正。" /> : null}
        {order.lastErrorMessage ? <Alert type="error" showIcon message="上一次操作没有成功" description={order.lastErrorMessage} /> : null}
        {!order.write.allowed && order.actions.length > 0 ? <Alert type="warning" showIcon message="调用亚马逊的操作暂时不可用" description={order.write.reason ?? undefined} /> : null}
        {order.draft ? (
          <Alert
            type="info"
            showIcon
            message="由补货建议生成的草稿"
            description={`建议补货：${order.draft.items.map(item => `${item.sku} × ${item.qty}`).join('、') || '无'}。包装与发货地址补全后才能提交亚马逊。`}
          />
        ) : null}
        <Overview order={order} />
        <Card size="small" title="包装">
          {order.packages.length ? (
            <SimpleGrid<AwdPackageInput>
              gridId="awd.order-packages"
              columns={packageColumns}
              rows={order.packages}
              rowKey={row => `${row.type}|${order.packages.indexOf(row)}`}
              emptyState={{ kind: 'empty', domain: '包装', prerequisite: '还没有填写包装' }}
            />
          ) : (
            <Muted>还没有填写包装</Muted>
          )}
        </Card>
        <Card size="small" title="亚马逊入库货件">
          {order.shipments.length ? (
            <ShipmentsGrid shipments={order.shipments} />
          ) : (
            <Muted>{order.orderId ? '亚马逊还没有为这个订单生成货件（确认订单后才会生成）' : '订单提交并确认后才会有货件'}</Muted>
          )}
        </Card>
        <Card size="small" title="操作记录">
          {order.timeline.length ? (
            <Timeline
              items={order.timeline.map(item => ({
                children: (
                  <>
                    <Typography.Text strong>{item.title}</Typography.Text> <Typography.Text type="secondary">{formatDateTime(item.at)}</Typography.Text>
                    {item.detail ? <div>{item.detail}</div> : null}
                  </>
                ),
              }))}
            />
          ) : (
            <Muted>尚无记录</Muted>
          )}
        </Card>
      </Space>
      <AwdOrderDrawer open={editing} onClose={() => setEditing(false)} stores={stores.data?.stores ?? []} write={order.write} order={order} />
    </div>
  )
}
