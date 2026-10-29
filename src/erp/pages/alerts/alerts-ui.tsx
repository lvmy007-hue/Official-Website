import type { ReactNode } from 'react'
import { Tag } from 'antd'
import { ALERT_SEVERITY_LABEL, type AlertEntityRef, type AlertImpact, type AlertListItem } from '@nova/api-contracts'
import { formatMoney } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'

// 预警页面共用的小件（P5-01）：严重度与状态标签、影响金额区间、对象链接、负责人。
// 没有数据的写法：没有影响金额依据写“尚无依据估算”（不写 0）、没有负责人写“尚未分派”、没有详情页的对象写“尚无详情页”。

const SEVERITY_COLOR: Record<string, string> = { CRITICAL: 'error', WARNING: 'warning', INFO: 'default' }
const STATUS_COLOR: Record<string, string> = { NEW: 'processing', ACKED: 'cyan', HANDLED: 'success', IGNORED: 'default', AUTO_CLOSED: 'default' }

export function SeverityTag({ severity }: { severity: keyof typeof ALERT_SEVERITY_LABEL }) {
  return (
    <Tag color={SEVERITY_COLOR[severity]} bordered={false}>
      {ALERT_SEVERITY_LABEL[severity]}
    </Tag>
  )
}

export function AlertStatusTag({ status, label }: { status: string; label: string }) {
  return (
    <Tag color={STATUS_COLOR[status] ?? 'default'} bordered={false}>
      {label}
    </Tag>
  )
}

export function impactText(impact: AlertImpact | null): ReactNode {
  if (!impact || (impact.min === null && impact.max === null)) return <Muted>尚无依据估算</Muted>
  const money = (value: number) => formatMoney(value, impact.currency, { digits: 0 })
  if (impact.min !== null && impact.max !== null && impact.min !== impact.max) return <span className="erp-num">{`${money(impact.min)} ~ ${money(impact.max)}`}</span>
  return <span className="erp-num">{money((impact.max ?? impact.min) as number)}</span>
}

export function EntityCell({ entity }: { entity: AlertEntityRef }) {
  return entity.path ? (
    <AppLink to={entity.path}>{entity.label}</AppLink>
  ) : (
    <span>
      {entity.label}
      <Muted>（尚无详情页）</Muted>
    </span>
  )
}

export const ownerText = (owner: AlertListItem['owner']): ReactNode => (owner ? owner.name : <Muted>尚未分派</Muted>)
