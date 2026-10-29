import { Button, Tag, Tooltip } from 'antd'
import type { FeeEventRow, ReconciliationStatus } from '@nova/api-contracts'
import { actionColumn, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { money, text, timeText } from '../orders/orders-ui'
import { ReconcileActions } from './FeeActions'

// 费用事件列表的列（07 章 7.5；P6-28 迁到 MassiveGrid）：金额带符号（扣费为负、红色不用，保持中性）；报告类的费用事件没有交易状态，写“无交易状态”；
// 订单号在有订单读取权限时链到订单详情；动作按权限置灰并给出原因。费用事件接口没有排序参数，列都不可排序。

const RECONCILIATION_COLOR: Record<ReconciliationStatus, string> = { UNRECONCILED: 'default', DISCREPANCY: 'error', RECONCILED: 'success' }

export function ReconciliationTag({ row }: { row: Pick<FeeEventRow, 'reconciliationStatus' | 'reconciliationLabel' | 'reconciliationNote'> }) {
  const tag = (
    <Tag color={RECONCILIATION_COLOR[row.reconciliationStatus]} bordered={false}>
      {row.reconciliationLabel}
    </Tag>
  )
  return row.reconciliationNote ? <Tooltip title={`备注：${row.reconciliationNote}`}>{tag}</Tooltip> : tag
}

type Options = { canOrders: boolean; onEvidence: (row: FeeEventRow) => void; onChanged: () => void }

const plain = (title: string, id: string, get: (row: FeeEventRow) => string | null, empty: string, width: number): ErpColDef<FeeEventRow> =>
  renderColumn<FeeEventRow>(title, id, row => (get(row) ? <span className="erp-num">{get(row)}</span> : <Muted>{empty}</Muted>), { width, sortable: false })

export function feeColumns(options: Options): ErpColDef<FeeEventRow>[] {
  return [
    renderColumn<FeeEventRow>('发生时间', 'postedAt', row => timeText(row.postedAt), { width: 160, pin: 'left', sortable: false }),
    renderColumn<FeeEventRow>('店铺', 'storeName', row => row.storeName, { width: 120, sortable: false }),
    renderColumn<FeeEventRow>(
      '费用类型',
      'type',
      row => (
        <span className="erp-cell-stack">
          <span>{row.categoryLabel}</span>
          <span className="erp-cell-sub">{row.subtypeLabel ?? <Muted>无子类型</Muted>}</span>
        </span>
      ),
      { width: 230, sortable: false },
    ),
    renderColumn<FeeEventRow>('金额', 'amount', row => money(row.amount, row.currency), { width: 120, sortable: false, ...RIGHT_ALIGNED }),
    renderColumn<FeeEventRow>('交易状态', 'status', row => (row.transactionStatusLabel ? row.transactionStatusLabel : <Muted>无交易状态</Muted>), { width: 110, sortable: false }),
    renderColumn<FeeEventRow>(
      '订单号',
      'amazonOrderId',
      row =>
        !row.amazonOrderId ? (
          <Muted>无订单</Muted>
        ) : options.canOrders ? (
          <AppLink to={`/app/orders/${encodeURIComponent(row.amazonOrderId)}`}>{row.amazonOrderId}</AppLink>
        ) : (
          <span className="erp-num">{row.amazonOrderId}</span>
        ),
      { width: 180, sortable: false },
    ),
    plain('ASIN', 'asin', row => row.asin, '无', 120),
    plain('SKU', 'sellerSku', row => row.sellerSku, '无', 140),
    plain('结算单', 'settlementId', row => row.settlementId, '未关联', 130),
    plain('货件', 'shipmentId', row => row.shipmentId, '无', 130),
    renderColumn<FeeEventRow>('来源', 'sourceLabel', row => text(row.sourceLabel), { width: 140, sortable: false }),
    renderColumn<FeeEventRow>('对账状态', 'reconciliation', row => <ReconciliationTag row={row} />, { width: 110, sortable: false }),
    actionColumn<FeeEventRow>(
      row => (
        <>
          <Button size="small" type="link" onClick={() => options.onEvidence(row)}>
            查看证据
          </Button>
          <ReconcileActions row={row} onChanged={options.onChanged} />
        </>
      ),
      { width: 280 },
    ),
  ]
}
