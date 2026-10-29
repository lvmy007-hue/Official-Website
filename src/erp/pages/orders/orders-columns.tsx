import { Tag } from 'antd'
import type { OrderListRow } from '@nova/api-contracts'
import type { ICellRendererParams } from 'ag-grid-community'
import { RIGHT_ALIGNED, renderColumn, type AsyncColumnSpec, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { NetIncomeCell, RefundCell, RiskTags, SettlementTag, count, money, text, timeText } from './orders-ui'

// 订单列表的列（07 章 7.1；P6-04 迁到 MassiveGrid 骨架）：订单号链到详情；买家信息永远不在列表里。
// 订单接口只支持按下单时间排序（游标分页），所以只有“下单时间”一列可排序。

/** 白名单：列标识 → 服务端排序字段。 */
export const ORDER_SORTABLE = { purchaseDate: 'purchaseDate' } as const
export const ORDER_DEFAULT_SORT: SortSpec = { field: 'purchaseDate', direction: 'desc' }

/** 净收益是异步列：列表先出，只对屏幕上的行批量取（POST /orders/net-income）。 */
export type OrderNetFetcher = AsyncColumnSpec['fetch']

export function orderColumns(netFetcher: OrderNetFetcher | null): ErpColDef<OrderListRow>[] {
  const columns: ErpColDef<OrderListRow>[] = [
    renderColumn<OrderListRow>(
      '订单号',
      'order',
      row => (
        <div>
          <AppLink to={`/app/orders/${encodeURIComponent(row.id)}`}>{row.amazonOrderId}</AppLink>
          <div className="erp-num">{row.storeName}</div>
        </div>
      ),
      { group: '订单', pin: 'left', width: 200 },
    ),
    renderColumn<OrderListRow>('下单时间', 'purchaseDate', row => timeText(row.purchaseDate), { group: '订单', width: 170 }),
    renderColumn<OrderListRow>(
      '状态',
      'status',
      row => (
        <div>
          <Tag bordered={false}>{row.statusLabel}</Tag>
          {row.isReplacement ? (
            <Tag color="processing" bordered={false}>
              替换订单
            </Tag>
          ) : null}
        </div>
      ),
      { group: '订单', width: 150 },
    ),
    renderColumn<OrderListRow>('金额', 'amount', row => money(row.amount, row.currency), { group: '订单', width: 110, ...RIGHT_ALIGNED }),
    renderColumn<OrderListRow>('件数', 'units', row => count(row.units), { group: '订单', width: 80, ...RIGHT_ALIGNED }),
    renderColumn<OrderListRow>('履约', 'fulfillment', row => text(row.fulfillmentLabel), { group: '履约', width: 110 }),
    renderColumn<OrderListRow>('承运商', 'carrier', row => text(row.carrier), { group: '履约', width: 110 }),
    renderColumn<OrderListRow>(
      '追踪号',
      'tracking',
      row =>
        row.trackingNumber ? (
          <span className="erp-num">
            {row.trackingNumber}
            {row.trackingCount > 1 ? <Muted> 等 {row.trackingCount} 个</Muted> : null}
          </span>
        ) : (
          <Muted>尚无记录</Muted>
        ),
      { group: '履约', width: 190 },
    ),
    renderColumn<OrderListRow>('预计送达', 'delivery', row => timeText(row.latestDelivery ?? row.earliestDelivery), { group: '履约', width: 170 }),
    renderColumn<OrderListRow>('退款', 'refund', row => <RefundCell refund={row.refund} currency={row.currency} />, { group: '财务与售后', width: 160 }),
    renderColumn<OrderListRow>('退货', 'returns', row => (row.returnCount > 0 ? <span className="erp-num">{row.returnCount} 笔</span> : <Muted>无</Muted>), {
      group: '财务与售后',
      width: 90,
      ...RIGHT_ALIGNED,
    }),
    renderColumn<OrderListRow>('结算', 'settlement', row => <SettlementTag settlement={row.settlement} />, { group: '财务与售后', width: 120 }),
  ]
  if (netFetcher) {
    columns.push({
      headerName: '净收益（财务交易合计）',
      colId: 'net',
      field: 'net' as never,
      minWidth: 80,
      // 异步列把响应里的 { value, currency } 当作单元格值传进来
      cellRenderer: (params: ICellRendererParams) => <NetIncomeCell value={params.value?.value} currency={params.value?.currency ?? params.data?.currency ?? ''} />,
      group: '财务与售后',
      width: 190,
      async: { key: 'net', fetch: netFetcher },
      ...RIGHT_ALIGNED,
    })
  }
  columns.push(renderColumn<OrderListRow>('风险', 'risks', row => <RiskTags risks={row.risks} />, { group: '财务与售后', width: 200 }))
  return columns
}
