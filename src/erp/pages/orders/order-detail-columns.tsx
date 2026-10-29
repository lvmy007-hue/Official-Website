import { Tag } from 'antd'
import type { ReactNode } from 'react'
import type { OrderChargeLine, OrderFeeLine, OrderItemRow, OrderPackageRow, OrderReturnRow, OrderReturnsResponse, OrderRisk, OrderTransactionRow } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatDate } from '../../format'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { money, text, timeText } from './orders-ui'

// 订单详情各页签的列（P6-28 第 7 批：由旧 antd 表迁到 LocalGrid）。口径与迁移前一致：没有的写“尚无记录”，不当 0。

type Cell<T> = (row: T) => ReactNode
const col = <T extends object>(title: string, key: string, width: number, render: Cell<T>, extra: ErpColDef<T> = {}) => renderColumn<T>(title, key, render, { width, sortable: false, ...extra })
const num = <T extends object>(title: string, key: string, width: number, render: Cell<T>) => col<T>(title, key, width, render, RIGHT_ALIGNED)
const WRAP = { wrapText: true, autoHeight: true } as const

export type RefundRow = OrderReturnsResponse['refunds'][number]

export const itemColumns: ErpColDef<OrderItemRow>[] = [
  col<OrderItemRow>(
    '商品',
    'product',
    300,
    row => (
      <div>
        <div>{row.title ?? <Muted>尚无标题</Muted>}</div>
        <div className="erp-num">
          {row.sku ?? '无 SKU'} · {row.asin ?? '无 ASIN'}
        </div>
        {row.productId ? (
          <LiveLink component="Asin360Page" id={row.productId}>
            商品全景（ASIN 360）
          </LiveLink>
        ) : null}
      </div>
    ),
    WRAP,
  ),
  col<OrderItemRow>('状态', 'itemStatus', 100, row => text(row.itemStatus)),
  num<OrderItemRow>('下单 / 已发', 'qty', 110, row => <span className="erp-num">{`${row.quantityOrdered} / ${row.quantityShipped}`}</span>),
  num<OrderItemRow>('行小计', 'itemPrice', 110, row => money(row.itemPrice, row.currency)),
  num<OrderItemRow>('单价', 'unitPrice', 100, row => money(row.unitPrice, row.currency)),
  num<OrderItemRow>('促销折扣', 'promotionDiscount', 100, row => money(row.promotionDiscount, row.currency)),
  num<OrderItemRow>('税', 'taxAmount', 90, row => money(row.taxAmount, row.currency)),
]

export const chargeColumns: ErpColDef<OrderChargeLine>[] = [
  col<OrderChargeLine>('订单行', 'orderItemId', 200, row => <span className="erp-num">{row.sku ? `${row.sku}（${row.orderItemId}）` : row.orderItemId}</span>),
  col<OrderChargeLine>('类别', 'kindLabel', 110, row => row.kindLabel),
  col<OrderChargeLine>('明细', 'componentKey', 160, row => row.componentKey),
  num<OrderChargeLine>('金额', 'amount', 110, row => money(row.amount, row.currency)),
]

export const feeColumns: ErpColDef<OrderFeeLine>[] = [
  col<OrderFeeLine>('费用项', 'label', 300, row => row.label),
  col<OrderFeeLine>('入账时间', 'postedAt', 160, row => timeText(row.postedAt)),
  num<OrderFeeLine>('金额', 'amount', 110, row => money(row.amount, row.currency)),
]

export const packageColumns: ErpColDef<OrderPackageRow>[] = [
  col<OrderPackageRow>('包裹', 'packageId', 150, row => <span className="erp-num">{row.packageId}</span>),
  col<OrderPackageRow>('承运商', 'carrier', 110, row => text(row.carrier)),
  col<OrderPackageRow>('追踪号', 'trackingNumber', 170, row => text(row.trackingNumber)),
  col<OrderPackageRow>('配送服务', 'shippingService', 130, row => text(row.shippingService)),
  col<OrderPackageRow>('包裹状态', 'packageStatus', 110, row => text(row.packageStatus)),
  col<OrderPackageRow>('发货时间', 'shipDate', 160, row => timeText(row.shipDate)),
  col<OrderPackageRow>('送达时间', 'deliveredAt', 160, row => timeText(row.deliveredAt)),
  col<OrderPackageRow>('配送中心', 'fulfillmentCenter', 100, row => text(row.fulfillmentCenter)),
]

export const riskColumns: ErpColDef<OrderRisk>[] = [
  col<OrderRisk>('风险', 'label', 120, row => <Tag color={row.level === 'HIGH' ? 'error' : 'warning'}>{row.label}</Tag>),
  col<OrderRisk>('级别', 'level', 80, row => (row.level === 'HIGH' ? '高' : '中')),
  col<OrderRisk>('原因', 'reason', 360, row => row.reason, WRAP),
]

export const refundColumns: ErpColDef<RefundRow>[] = [
  col<RefundRow>('入账时间', 'postedAt', 170, row => timeText(row.postedAt)),
  num<RefundRow>('金额', 'amount', 120, row => money(row.amount, row.currency)),
  col<RefundRow>('交易状态', 'status', 120, row => text(row.status)),
]

export const returnColumns: ErpColDef<OrderReturnRow>[] = [
  col<OrderReturnRow>('退货单', 'returnId', 150, row => (
    <LiveLink component="ReturnDetailPage" id={row.id}>
      {row.returnId || '查看详情'}
    </LiveLink>
  )),
  col<OrderReturnRow>('商品', 'product', 200, row => <span className="erp-num">{`${row.sku} · ${row.asin}`}</span>),
  num<OrderReturnRow>('数量', 'quantity', 80, row => <span className="erp-num">{row.quantity}</span>),
  col<OrderReturnRow>('退货原因', 'reason', 200, row => text(row.reason), WRAP),
  col<OrderReturnRow>('处置', 'disposition', 120, row => text(row.disposition)),
  col<OrderReturnRow>('状态', 'status', 100, row => row.status),
  num<OrderReturnRow>('退款金额', 'refundAmount', 110, row => money(row.refundAmount)),
  col<OrderReturnRow>('退货日期', 'returnDate', 120, row => <span className="erp-num">{formatDate(row.returnDate)}</span>),
]

export const transactionColumns: ErpColDef<OrderTransactionRow>[] = [
  col<OrderTransactionRow>('入账时间', 'postedAt', 170, row => timeText(row.postedAt)),
  col<OrderTransactionRow>('类型', 'transactionType', 160, row => text(row.transactionType)),
  col<OrderTransactionRow>('说明', 'description', 220, row => text(row.description), WRAP),
  col<OrderTransactionRow>('状态', 'statusLabel', 110, row => row.statusLabel),
  num<OrderTransactionRow>('金额', 'amount', 120, row => money(row.amount, row.currency)),
  col<OrderTransactionRow>('对账', 'reconciliationStatus', 100, row => row.reconciliationStatus),
  col<OrderTransactionRow>('结算周期', 'settlement', 200, row =>
    row.settlement ? (
      <span className="erp-num">{`${row.settlement.externalSettlementId}${row.settlement.depositDate ? ` · ${formatDate(row.settlement.depositDate)}` : ''}`}</span>
    ) : (
      <Muted>尚未归入结算周期</Muted>
    ),
  ),
]
