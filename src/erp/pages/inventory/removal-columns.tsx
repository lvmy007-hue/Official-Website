import type { RecommendedRemovalRow, RemovalOrderRow } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, textColumn, type ErpColDef } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { fee, Muted, qty, ReceiptStateTag } from './inventory-ui'

// 移除订单列表与推荐移除清单的列（06 章 6.5；P6-28 迁到 PagedGrid）：没有数字写“尚无记录”，费用没有记录不写 0。

/** 服务端只允许这两个排序字段（RemovalListQuerySchema、RecommendedRemovalQuerySchema）。 */
export const ORDER_SORTABLE: Readonly<Record<string, string>> = { requestDate: 'requestDate' }
export const RECOMMENDED_SORTABLE: Readonly<Record<string, string>> = { removalQty: 'removalQty' }

const qtyColumn = <T extends object>(title: string, key: keyof T & string, get: (row: T) => number | null, width: number, extra: ErpColDef<T> = {}) =>
  renderColumn<T>(title, key, row => qty(get(row)), { width, sortable: false, ...RIGHT_ALIGNED, ...extra })

export function orderColumns(): ErpColDef<RemovalOrderRow>[] {
  return [
    renderColumn<RemovalOrderRow>('订单号', 'orderId', row => <AppLink to={`/app/inventory/removals/${encodeURIComponent(row.id)}`}>{row.orderId}</AppLink>, { pin: 'left', width: 190 }),
    textColumn<RemovalOrderRow>('店铺', 'storeName', { width: 140 }),
    textColumn<RemovalOrderRow>('类型', 'typeLabel', { width: 90 }),
    textColumn<RemovalOrderRow>('状态', 'statusLabel', { width: 110 }),
    textColumn<RemovalOrderRow>('请求日期', 'requestDate', { width: 120 }),
    qtyColumn<RemovalOrderRow>('SKU 数', 'skuCount', row => row.skuCount, 90),
    qtyColumn<RemovalOrderRow>('请求数量', 'requestedQty', row => row.requestedQty, 100),
    qtyColumn<RemovalOrderRow>('已发货', 'shippedQty', row => row.shippedQty, 90),
    qtyColumn<RemovalOrderRow>('已弃置', 'disposedQty', row => row.disposedQty, 90),
    qtyColumn<RemovalOrderRow>('已取消', 'cancelledQty', row => row.cancelledQty, 90),
    renderColumn<RemovalOrderRow>('费用', 'fee', row => fee(row.fee, row.currency), { width: 120, ...RIGHT_ALIGNED }),
    renderColumn<RemovalOrderRow>(
      '承运商 / 运单号',
      'carrier',
      row =>
        row.carriers.length === 0 && row.trackingNumbers.length === 0 ? (
          <Muted>尚无记录</Muted>
        ) : (
          <span className="erp-cell-stack">
            <span>{row.carriers.join('、') || <Muted>尚无记录</Muted>}</span>
            <span className="erp-cell-sub">{row.trackingNumbers.join('、')}</span>
          </span>
        ),
      { width: 220 },
    ),
    renderColumn<RemovalOrderRow>('收货核对', 'receipt', row => <ReceiptStateTag state={row.receiptState} />, { width: 150 }),
    qtyColumn<RemovalOrderRow>('已收件数', 'receivedQty', row => row.receivedQty, 100),
  ]
}

export function recommendedColumns(): ErpColDef<RecommendedRemovalRow>[] {
  return [
    textColumn<RecommendedRemovalRow>('店铺', 'storeName', { width: 140, pin: 'left' }),
    renderColumn<RecommendedRemovalRow>(
      'SKU / ASIN',
      'sku',
      row => (
        <span className="erp-cell-stack">
          <span>{row.sku}</span>
          <span className="erp-cell-sub">{row.asin || row.fnsku}</span>
        </span>
      ),
      { width: 200 },
    ),
    renderColumn<RecommendedRemovalRow>('商品名称', 'productName', row => row.productName ?? <Muted>尚无记录</Muted>, { width: 260 }),
    qtyColumn<RecommendedRemovalRow>('推荐移除数量', 'removalQty', row => row.removalQty, 130, { sortable: true }),
    qtyColumn<RecommendedRemovalRow>('可售数量', 'available', row => row.available, 100),
    renderColumn<RecommendedRemovalRow>('推荐原因', 'reason', row => row.reason ?? <Muted>尚无记录</Muted>, { width: 200 }),
    renderColumn<RecommendedRemovalRow>('预计节省', 'estimatedSavings', row => (row.estimatedSavings === null ? <Muted>尚未接入</Muted> : fee(row.estimatedSavings, 'USD')), {
      width: 120,
      ...RIGHT_ALIGNED,
    }),
    textColumn<RecommendedRemovalRow>('报告日期', 'snapshotDate', { width: 120 }),
  ]
}
