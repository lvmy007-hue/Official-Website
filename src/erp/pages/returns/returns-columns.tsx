import type { ReturnAwaitingRow, ReturnListRow } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { RefundCell, count, money, text, timeText } from '../orders/orders-ui'
import { CategoryText, DispositionTag, ReimbursementCell } from './returns-ui'

// 退货列表与“退款后未收到退货”清单的列（07 章 7.2；P6-13 迁到 MassiveGrid / PagedGrid 骨架）：
// 订单号链到退货详情，买家备注不在列表里；退货原因按三层显示——原因代码、中文释义、大类；退款金额是订单口径。
// 退货接口只支持按退货日期排序（游标分页），所以只有“退货日期”一列可排序。

/** 白名单：列标识 → 服务端排序字段。 */
export const RETURN_SORTABLE = { returnDate: 'returnDate' } as const
export const RETURN_DEFAULT_SORT: SortSpec = { field: 'returnDate', direction: 'desc' }

const code = (value: string | null | undefined) => (value ? <span className="erp-num">{value}</span> : <Muted>尚无记录</Muted>)

export const returnColumns: ErpColDef<ReturnListRow>[] = [
  renderColumn<ReturnListRow>(
    '订单号',
    'order',
    row => (
      <div>
        <AppLink to={`/app/returns/${encodeURIComponent(row.id)}`}>{row.amazonOrderId}</AppLink>
        <div className="erp-num">{row.storeName}</div>
      </div>
    ),
    { group: '退货', pin: 'left', width: 200, sortable: false },
  ),
  renderColumn<ReturnListRow>('退货日期', 'returnDate', row => timeText(row.returnDate), { group: '退货', width: 170 }),
  renderColumn<ReturnListRow>('ASIN', 'asin', row => code(row.asin), { group: '商品', width: 130, sortable: false }),
  renderColumn<ReturnListRow>('SKU', 'sku', row => code(row.sku), { group: '商品', width: 150, sortable: false }),
  renderColumn<ReturnListRow>('数量', 'quantity', row => count(row.quantity), { group: '商品', width: 80, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<ReturnListRow>('原因代码', 'reasonCode', row => code(row.reason), { group: '退货原因', width: 190, sortable: false }),
  renderColumn<ReturnListRow>('中文释义', 'reasonLabel', row => row.reasonLabel ?? <Muted>未提供原因</Muted>, { group: '退货原因', width: 170, sortable: false }),
  renderColumn<ReturnListRow>('大类', 'reasonCategory', row => <CategoryText category={row.reasonCategory} />, { group: '退货原因', width: 130, sortable: false }),
  renderColumn<ReturnListRow>('处置状态', 'disposition', row => <DispositionTag view={row.disposition} />, { group: '处理', width: 140, sortable: false }),
  renderColumn<ReturnListRow>('运营中心', 'fc', row => text(row.fulfillmentCenterId), { group: '处理', width: 110, sortable: false }),
  renderColumn<ReturnListRow>('退货件编号', 'lpn', row => code(row.licensePlateNumber), { group: '处理', width: 150, sortable: false }),
  renderColumn<ReturnListRow>('退款（订单口径）', 'refund', row => <RefundCell refund={row.refund} currency={row.currency} />, { group: '退款与赔付', width: 180, sortable: false }),
  renderColumn<ReturnListRow>(
    '退款后是否收到退货',
    'receipt',
    row => (row.receipt.state === 'PENDING_DATA' || row.receipt.state === 'NO_REFUND' ? <Muted>{row.receipt.label}</Muted> : row.receipt.label),
    { group: '退款与赔付', width: 180, sortable: false },
  ),
  renderColumn<ReturnListRow>('赔付状态', 'reimbursement', row => <ReimbursementCell view={row.reimbursement} />, { group: '退款与赔付', width: 140, sortable: false }),
]

export const awaitingColumns: ErpColDef<ReturnAwaitingRow>[] = [
  renderColumn<ReturnAwaitingRow>(
    '订单号',
    'order',
    row => (
      <div>
        {row.orderId ? <AppLink to={`/app/orders/${encodeURIComponent(row.orderId)}`}>{row.amazonOrderId}</AppLink> : <span className="erp-num">{row.amazonOrderId}</span>}
        <div className="erp-num">{row.storeName}</div>
      </div>
    ),
    { pin: 'left', width: 200, sortable: false },
  ),
  renderColumn<ReturnAwaitingRow>('第一笔退款入账', 'firstRefundAt', row => timeText(row.firstRefundAt), { width: 180, sortable: false }),
  renderColumn<ReturnAwaitingRow>('已过天数', 'daysSinceRefund', row => <span className="erp-num">{row.daysSinceRefund} 天</span>, { width: 110, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<ReturnAwaitingRow>('退款金额', 'refundAmount', row => money(row.refundAmount, row.currency), { width: 130, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<ReturnAwaitingRow>(
    '商品',
    'items',
    row =>
      row.items.length === 0 ? (
        <Muted>订单行尚未同步</Muted>
      ) : (
        <span className="erp-num">{row.items.map(item => `${[item.sku, item.asin].filter(Boolean).join(' · ')} × ${item.quantity}`).join('；')}</span>
      ),
    { width: 360, sortable: false },
  ),
]
