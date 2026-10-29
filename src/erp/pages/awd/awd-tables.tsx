import { Button, Space } from 'antd'
import type { AwdInventoryRow, AwdLabelResponse, AwdOrderRow, AwdShipmentRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, renderColumn, RIGHT_ALIGNED, textColumn, type ErpColDef } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { OrderStatusTag, qty } from './awd-ui'
import { openSignedUrl } from '../../security/safe-url'

// 上游仓储三个列表的列：库存、入库订单、入库货件。没有记录的单元格写“尚无记录”，不写 0。

const text = (value: string | null | undefined) => (value ? value : <Muted>尚无记录</Muted>)
const time = (value: string | null | undefined) => (value ? formatDateTime(value) : <Muted>尚无记录</Muted>)

const qtyColumn = <T extends object>(title: string, key: string, get: (row: T) => number | null, width: number) =>
  renderColumn<T>(title, key, row => qty(get(row)), { width, sortable: false, ...RIGHT_ALIGNED })
const textCol = <T extends object>(title: string, key: string, get: (row: T) => string | null | undefined, width: number) =>
  renderColumn<T>(title, key, row => text(get(row)), { width, sortable: false })

// 服务端对这三个列表有固定排序（库存按 SKU、订单按更新时间、货件按亚马逊更新时间），没有可选排序字段。
export function inventoryColumns(): ErpColDef<AwdInventoryRow>[] {
  return [
    textColumn<AwdInventoryRow>('店铺', 'storeName', { width: 140, pin: 'left', sortable: false }),
    textColumn<AwdInventoryRow>('SKU', 'sku', { width: 180, pin: 'left', sortable: false }),
    qtyColumn<AwdInventoryRow>('可用', 'availableQty', row => row.availableQty, 90),
    qtyColumn<AwdInventoryRow>('在库', 'onhandQty', row => row.onhandQty, 90),
    qtyColumn<AwdInventoryRow>('预留给补货', 'reservedForReplenishment', row => row.reservedForReplenishment, 110),
    qtyColumn<AwdInventoryRow>('入库中（到上游仓储）', 'inboundToAwdQty', row => row.inboundToAwdQty, 160),
    qtyColumn<AwdInventoryRow>('发往亚马逊物流在途', 'outboundToFbaInTransit', row => row.outboundToFbaInTransit, 160),
    textCol<AwdInventoryRow>('最早到期日', 'expiryDate', row => row.expiryDate, 120),
    textColumn<AwdInventoryRow>('快照日期', 'snapshotDate', { width: 120, sortable: false }),
  ]
}

export function orderColumns(): ErpColDef<AwdOrderRow>[] {
  return [
    renderColumn<AwdOrderRow>('订单', 'order', row => <AppLink to={`/app/awd/orders/${encodeURIComponent(row.id)}`}>{row.orderId ?? row.externalReferenceId ?? row.id}</AppLink>, {
      width: 220,
      pin: 'left',
      sortable: false,
    }),
    textColumn<AwdOrderRow>('店铺', 'storeName', { width: 140, sortable: false }),
    renderColumn<AwdOrderRow>('状态', 'status', row => <OrderStatusTag order={row} />, { width: 220, sortable: false }),
    qtyColumn<AwdOrderRow>('预计件数', 'expectedUnits', row => row.expectedUnits, 100),
    qtyColumn<AwdOrderRow>('已接收件数', 'receivedUnits', row => row.receivedUnits, 110),
    textCol<AwdOrderRow>('目的区域', 'destinationRegion', row => row.destinationRegion, 110),
    renderColumn<AwdOrderRow>('更新时间', 'updatedAt', row => time(row.updatedAt), { width: 170, sortable: false }),
    renderColumn<AwdOrderRow>('提示', 'lastErrorMessage', row => (row.lastErrorMessage ? <span style={{ color: 'var(--ant-color-error)' }}>{row.lastErrorMessage}</span> : null), {
      width: 280,
      sortable: false,
    }),
  ]
}

/** 标签：已生成时可下载（服务端签发 5 分钟有效的链接）；也可以发起获取或重新获取。 */
export function LabelActions({ shipment }: { shipment: Pick<AwdShipmentRow, 'id' | 'shipmentId' | 'labelStatus' | 'status'> }) {
  const request = useApiMutation<void, { state: string; jobId: string }>({ method: 'POST', path: `/awd/shipments/${encodeURIComponent(shipment.id)}/labels`, invalidate: ['list'], silent: true })
  const download = async () => {
    const result = await apiFetch<AwdLabelResponse>(`/awd/shipments/${encodeURIComponent(shipment.id)}/labels`)
    openSignedUrl(result.url)
  }
  return (
    <Space size={4}>
      {shipment.labelStatus === 'GENERATED' ? (
        <Button size="small" type="link" onClick={() => void download()}>
          下载标签
        </Button>
      ) : null}
      <FormAction
        label={shipment.labelStatus === 'GENERATED' ? '重新获取' : shipment.labelStatus === 'GENERATING' ? '标签生成中' : '获取标签'}
        guard={{
          permission: 'awd.read',
          condition: { ok: shipment.status !== 'CANCELLED' && shipment.labelStatus !== 'GENERATING', reason: shipment.status === 'CANCELLED' ? '货件已取消' : '标签正在生成，请稍后刷新' },
        }}
        title={`获取货件 ${shipment.shipmentId} 的标签`}
        description="向亚马逊请求货件标签，生成需要几分钟；完成后这里会出现“下载标签”。这是只读请求，不会修改亚马逊上的任何数据。"
        okText="开始获取"
        successText="已提交，几分钟后刷新查看"
        buttonProps={{ size: 'small', type: 'link' }}
        onSubmit={() => request.mutateAsync()}
      />
    </Space>
  )
}

export function shipmentColumns(): ErpColDef<AwdShipmentRow>[] {
  return [
    textColumn<AwdShipmentRow>('货件编号', 'shipmentId', { width: 190, pin: 'left', sortable: false }),
    renderColumn<AwdShipmentRow>('入库订单', 'order', row => (row.orderRowId ? <AppLink to={`/app/awd/orders/${encodeURIComponent(row.orderRowId)}`}>{row.orderId}</AppLink> : text(row.orderId)), {
      width: 200,
      sortable: false,
    }),
    textColumn<AwdShipmentRow>('状态', 'statusLabel', { width: 110, sortable: false }),
    textCol<AwdShipmentRow>('承运商', 'carrier', row => row.carrier, 110),
    textCol<AwdShipmentRow>('运单号', 'trackingNumber', row => row.trackingNumber, 150),
    textCol<AwdShipmentRow>('目的区域', 'destination', row => row.destination, 110),
    qtyColumn<AwdShipmentRow>('预计件数', 'expectedUnits', row => row.expectedUnits, 100),
    qtyColumn<AwdShipmentRow>('已接收件数', 'receivedUnits', row => row.receivedUnits, 110),
    renderColumn<AwdShipmentRow>('最迟发货', 'shipBy', row => time(row.shipBy), { width: 170, sortable: false }),
    renderColumn<AwdShipmentRow>('更新时间', 'updatedAt', row => time(row.updatedAt), { width: 170, sortable: false }),
    renderColumn<AwdShipmentRow>('标签', 'label', row => <LabelActions shipment={row} />, { width: 220, pin: 'right', sortable: false }),
  ]
}
