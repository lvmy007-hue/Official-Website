import type { ReactNode } from 'react'
import { Tag } from 'antd'
import { ORDER_REFUND_LABEL, ORDER_RISK_LABEL, type OrderRefundState, type OrderRiskKind, type OrderSettlementState } from '@nova/api-contracts'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 订单页面共用的小件：金额与时间显示（没有数据写“尚无记录”，不写 0）、退款与结算与风险标签。

export const money = (value: number | null | undefined, currency = 'USD'): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, currency, { digits: 2 })}</span>

export const count = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

export const timeText = (value: string | null | undefined): ReactNode => (value ? <span className="erp-num">{formatDateTime(value)}</span> : <Muted>尚无记录</Muted>)

export const text = (value: string | null | undefined): ReactNode => value || <Muted>尚无记录</Muted>

const REFUND_COLOR: Record<OrderRefundState, string> = { NONE: 'default', PARTIAL: 'warning', FULL: 'error', PENDING_DATA: 'default' }

/** 退款：没有财务交易时写“待财务交易”，不能说“无退款”。 */
export function RefundCell({ refund, currency = 'USD' }: { refund: { state: OrderRefundState; amount: number | null }; currency?: string }) {
  if (refund.state === 'PENDING_DATA') return <Muted>{ORDER_REFUND_LABEL.PENDING_DATA}</Muted>
  if (refund.state === 'NONE') return <Muted>{ORDER_REFUND_LABEL.NONE}</Muted>
  return (
    <Tag color={REFUND_COLOR[refund.state]} bordered={false}>
      {ORDER_REFUND_LABEL[refund.state]}
      {refund.amount === null ? '' : ` ${formatMoney(refund.amount, currency, { digits: 2 })}`}
    </Tag>
  )
}

const SETTLEMENT_COLOR: Record<OrderSettlementState, string> = { NONE: 'default', DEFERRED: 'gold', RELEASED: 'success', UNKNOWN: 'warning' }

export function SettlementTag({ settlement }: { settlement: { state: OrderSettlementState; label: string } }) {
  if (settlement.state === 'NONE') return <Muted>{settlement.label}</Muted>
  return (
    <Tag color={SETTLEMENT_COLOR[settlement.state]} bordered={false}>
      {settlement.label}
    </Tag>
  )
}

const RISK_COLOR: Record<OrderRiskKind, string> = { CANCEL_REQUEST: 'warning', REFUND: 'error', RETURN: 'warning', REPLACEMENT: 'processing', TAX_ANOMALY: 'warning', FINANCE_DIFF: 'error' }

export function RiskTags({ risks }: { risks: readonly OrderRiskKind[] }) {
  if (risks.length === 0) return <Muted>无</Muted>
  return (
    <>
      {risks.map(kind => (
        <Tag key={kind} color={RISK_COLOR[kind]} bordered={false}>
          {ORDER_RISK_LABEL[kind]}
        </Tag>
      ))}
    </>
  )
}

/** 净收益：没有 field.profit 时整列不出现；有权限但财务交易没同步时写原因，不写 0。 */
export function NetIncomeCell({ value, currency }: { value: number | null | undefined; currency: string }) {
  if (value === null || value === undefined) return <Muted>待财务交易</Muted>
  return <span className="erp-num">{formatMoney(value, currency, { digits: 2 })}</span>
}
