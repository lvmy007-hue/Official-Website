import type { ReactNode } from 'react'
import { Tag } from 'antd'
import {
  type SettlementBreakdownRow,
  type SettlementDisbursementRow,
  type SettlementExceptionRow,
  type SettlementLineRow,
  type SettlementReconciliationResponse,
  type SettlementRow,
} from '@nova/api-contracts'
import { EXCEPTION_CATEGORY_HINT } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { count, money, timeText } from '../orders/orders-ui'
import { StatusTag, dayText, periodText } from './settlements-ui'

// 结算交易页的表格列（07 章 7.7）。金额带符号、按结算币种显示，不跨币种相加；没有数据写“尚无记录”或原因，不写 0。

/** 报告没到时各类合计没有；到了才显示（“0”是报告里这一类确实没有行）。 */
const total = (row: SettlementRow, key: keyof NonNullable<SettlementRow['totals']>) => (row.totals ? money(row.totals[key], row.currency) : <Muted>报告未到</Muted>)

const moneyCol = (title: string, key: string, width: number, get: (row: SettlementRow) => ReactNode) => renderColumn<SettlementRow>(title, key, get, { width, sortable: false, ...RIGHT_ALIGNED })
const totalCol = (title: string, key: 'INCOME' | 'FEE' | 'REFUND' | 'REIMBURSEMENT') => moneyCol(title, key, 110, row => total(row, key))

export const settlementColumns: ErpColDef<SettlementRow>[] = [
  renderColumn<SettlementRow>(
    '结算单',
    'settlement',
    row => (
      <span className="erp-cell-stack">
        <LiveLink component="SettlementDetailPage" id={row.id}>
          <span className="erp-num">{row.externalSettlementId}</span>
        </LiveLink>
        <span className="erp-cell-sub">{row.storeName}</span>
      </span>
    ),
    { width: 190, pin: 'left', sortable: false },
  ),
  renderColumn<SettlementRow>('结算周期（UTC）', 'period', row => periodText(row.periodStart, row.periodEnd), { width: 190, sortable: false }),
  renderColumn<SettlementRow>('打款日', 'depositDate', row => dayText(row.depositDate), { width: 110, sortable: false }),
  moneyCol('打款金额', 'disbursement', 120, row => money(row.disbursementAmount, row.currency)),
  moneyCol('期初余额', 'opening', 110, row => money(row.openingBalance, row.currency)),
  totalCol('收入', 'INCOME'),
  totalCol('费用', 'FEE'),
  totalCol('退款', 'REFUND'),
  totalCol('赔付', 'REIMBURSEMENT'),
  moneyCol('交易条数', 'txnCount', 100, row => (row.txnCount > 0 ? count(row.txnCount) : <Muted>报告未到</Muted>)),
  renderColumn<SettlementRow>('核对状态', 'status', row => <StatusTag status={row.status} label={row.statusLabel} pendingReason={row.pendingReason} />, { width: 170, sortable: false }),
  moneyCol('差额', 'diff', 110, row => (row.status === 'PENDING' ? <Muted>待核对</Muted> : money(row.diffAmount, row.currency))),
  renderColumn<SettlementRow>(
    '待处理异常',
    'openExceptions',
    row =>
      row.openExceptions > 0 ? (
        <Tag color="error" bordered={false}>
          {row.openExceptions}
        </Tag>
      ) : (
        <Muted>无</Muted>
      ),
    { width: 120, pin: 'right', sortable: false, ...RIGHT_ALIGNED },
  ),
]

function OrderCell({ orderId, found, canView }: { orderId: string | null; found: boolean; canView: boolean }) {
  if (!orderId) return <Muted>账户级</Muted>
  if (!canView) return <span className="erp-num">{orderId}</span>
  if (found)
    return (
      <LiveLink component="OrderDetailPage" id={orderId}>
        <span className="erp-num">{orderId}</span>
      </LiveLink>
    )
  return (
    <span>
      <span className="erp-num">{orderId}</span> <Muted>（我方订单里没有）</Muted>
    </span>
  )
}

// 以下列随结算单详情页签（P6-28 迁到 MassiveGrid / LocalGrid）。`canViewOrders` 来自列表响应，用取值函数传入，列定义保持稳定，避免响应到达后整表重建。
type Cell<T> = (row: T) => ReactNode
const col = <T extends object>(title: string, key: string, width: number, render: Cell<T>, extra: ErpColDef<T> = {}) => renderColumn<T>(title, key, render, { width, sortable: false, ...extra })
const num = <T extends object>(title: string, key: string, width: number, render: Cell<T>) => col<T>(title, key, width, render, RIGHT_ALIGNED)

export const lineColumns = (canViewOrders: () => boolean): ErpColDef<SettlementLineRow>[] => [
  col<SettlementLineRow>('行号', 'lineNo', 80, row => <span className="erp-num">{row.lineNo}</span>, { pin: 'left' }),
  col<SettlementLineRow>('过账时间', 'postedAt', 160, row => timeText(row.postedAt)),
  col<SettlementLineRow>('类别', 'category', 100, row => row.categoryLabel),
  col<SettlementLineRow>('交易类型', 'transactionType', 140, row => row.transactionType || <Muted>无</Muted>),
  col<SettlementLineRow>('科目', 'subject', 240, row => (
    <span className="erp-cell-stack">
      {row.amountType || <Muted>无</Muted>}
      <span className="erp-cell-sub">{row.amountDescription}</span>
    </span>
  )),
  col<SettlementLineRow>('订单号', 'order', 210, row => <OrderCell orderId={row.amazonOrderId} found={row.orderFound} canView={canViewOrders()} />),
  col<SettlementLineRow>('SKU / ASIN', 'sku', 180, row =>
    row.sku ? (
      <span className="erp-cell-stack">
        <span className="erp-num">{row.sku}</span>
        <span className="erp-cell-sub">{row.asin ?? ''}</span>
      </span>
    ) : (
      <Muted>无</Muted>
    ),
  ),
  num<SettlementLineRow>('数量', 'quantity', 90, row => (row.quantity === null ? <Muted>无</Muted> : count(row.quantity))),
  num<SettlementLineRow>('金额', 'amount', 120, row => money(row.amount, row.currency)),
  col<SettlementLineRow>('费用事件', 'fee', 110, row =>
    row.feeEventId ? (
      <Tag color="success" bordered={false}>
        已对应
      </Tag>
    ) : row.category === 'FEE' ? (
      <Muted>未对应</Muted>
    ) : (
      <Muted>无</Muted>
    ),
  ),
]

export const exceptionColumns = (canViewOrders: () => boolean): ErpColDef<SettlementExceptionRow>[] => [
  col<SettlementExceptionRow>('异常类型', 'kind', 150, row => row.kindLabel, { pin: 'left' }),
  col<SettlementExceptionRow>('差异分类', 'category', 110, row => (
    <Tag color={row.category === 'UNEXPLAINED' ? 'error' : 'warning'} bordered={false} title={row.categoryHint}>
      {row.categoryLabel}
    </Tag>
  )),
  col<SettlementExceptionRow>('订单号', 'order', 210, row => <OrderCell orderId={row.amazonOrderId} found={row.orderFound} canView={canViewOrders()} />),
  num<SettlementExceptionRow>('报告金额', 'report', 120, row => money(row.reportAmount, row.currency)),
  num<SettlementExceptionRow>('接口金额', 'api', 120, row => money(row.apiAmount, row.currency)),
  num<SettlementExceptionRow>('差额', 'amount', 120, row => money(row.amount, row.currency)),
  col<SettlementExceptionRow>('说明', 'note', 300, row => row.note ?? <Muted>{row.categoryHint}</Muted>),
  col<SettlementExceptionRow>('状态', 'status', 90, row => row.statusLabel),
]

export const breakdownColumns = (currency: string): ErpColDef<SettlementBreakdownRow>[] => [
  col<SettlementBreakdownRow>('类别', 'category', 110, row => row.categoryLabel),
  col<SettlementBreakdownRow>('金额类型', 'amountType', 170, row => row.amountType || <Muted>无</Muted>),
  col<SettlementBreakdownRow>('说明', 'amountDescription', 280, row => row.amountDescription || <Muted>无</Muted>),
  num<SettlementBreakdownRow>('条数', 'count', 90, row => count(row.count)),
  num<SettlementBreakdownRow>('金额', 'amount', 130, row => money(row.amount, currency)),
]

export const disbursementColumns: ErpColDef<SettlementDisbursementRow>[] = [
  col<SettlementDisbursementRow>('来源', 'source', 130, row => row.sourceLabel),
  col<SettlementDisbursementRow>('打款日', 'date', 120, row => dayText(row.date)),
  num<SettlementDisbursementRow>('金额', 'amount', 140, row => money(row.amount, row.currency)),
  col<SettlementDisbursementRow>('说明', 'note', 360, row => row.note),
]

type ReconException = SettlementReconciliationResponse['exceptions'][number]
export const reconExceptionColumns = (currency: string): ErpColDef<ReconException>[] => [
  col<ReconException>('分类', 'label', 120, row => row.label),
  num<ReconException>('条数', 'count', 90, row => count(row.count)),
  num<ReconException>('差额绝对值合计', 'amount', 160, row => money(row.amount, currency)),
  col<ReconException>('含义', 'hint', 420, row => EXCEPTION_CATEGORY_HINT[row.category]),
]
