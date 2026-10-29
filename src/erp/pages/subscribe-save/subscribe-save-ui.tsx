import type { ReactNode } from 'react'
import { Alert, Tag } from 'antd'
import { SNS_CARD_STATE_TEXT, SNS_GATE_LABEL, type SnsCard, type SnsGateReason, type SnsSync } from '@nova/api-contracts'
import { Delta, MetricStrip } from '../../components'
import { formatMoney, formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { StatCard } from '../analytics/business-reports-ui'

// 订阅省页面的小件：指标卡、同步提示、补货采用标记、各种“没有数字”的写法。
// 原则：任何没有数字的地方都写原因（尚无记录 / 尚未接入 / 数据已过期），绝不拿 0 冒充。

/** 数字或原因：没有值写“尚无记录”。 */
export const countOr = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

export const moneyOr = (value: number | null | undefined, currency: string | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, currency || 'USD', { digits: 2 })}</span>

const money = (value: number, currency: string | null) => formatMoney(value, currency ?? 'USD', { digits: 2 })

function CardView({ card, compared }: { card: SnsCard; compared: boolean }) {
  const text = (value: number) => (card.unit === 'money' ? money(value, card.currency) : formatNumber(value, { digits: 0 }))
  const ratio = card.value !== null && card.previous !== null && card.previous !== 0 ? (card.value - card.previous) / Math.abs(card.previous) : null
  return (
    <StatCard
      title={card.label}
      testId={`sns-card-${card.key}`}
      footer={
        <>
          {card.state === 'OK' && compared && card.previous !== null ? (
            <>
              <Delta label="对比期" ratio={ratio} goodWhen="up" />
              <span className="erp-num">对比期 {text(card.previous)}</span>
            </>
          ) : null}
          {card.state === 'OK' && compared && card.previous === null && (card.key === 'shippedUnits' || card.key === 'revenue') ? <Muted>对比期尚无记录</Muted> : null}
          {card.others.map(other => (
            <span key={other.currency} className="erp-num">
              另有 {money(other.amount, other.currency)}
            </span>
          ))}
          {card.state !== 'NOT_CONNECTED' && card.note ? <Muted>{card.note}</Muted> : null}
        </>
      }
    >
      {card.state === 'OK' && card.value !== null ? <span className="erp-num">{text(card.value)}</span> : <Muted>{SNS_CARD_STATE_TEXT[card.state === 'OK' ? 'NO_DATA' : card.state]}</Muted>}
    </StatCard>
  )
}

export function Cards({ cards, compared }: { cards: readonly SnsCard[]; compared: boolean }) {
  const notes = cards.filter(card => card.state === 'NOT_CONNECTED' && card.note)
  return (
    <>
      <MetricStrip>
        {cards.map(card => (
          <CardView key={card.key} card={card} compared={compared} />
        ))}
      </MetricStrip>
      {notes.map(card => (
        <Alert key={card.key} type="info" showIcon style={{ marginBottom: 8 }} message={`${card.label}：尚未接入`} description={card.note} data-testid="sns-cancel-note" />
      ))}
    </>
  )
}

/** 同步提示：失败、未授权或延迟时给原因；角色没批的详细说明由页面顶部状态条给出。 */
export function SyncNotice({ sync }: { sync: SnsSync }) {
  if (sync.rolePending) return null
  if (sync.status === 'FAILED' || sync.status === 'UNAUTHORIZED' || sync.status === 'DELAYED') {
    return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`订阅省同步：${sync.statusLabel}`} description={sync.errorMessage ?? undefined} data-testid="sns-sync-warning" />
  }
  return null
}

/** 补货采用：采用写“采用”；没采用写第一条不满足的原因。 */
export function GateTag({ gate }: { gate: { used: boolean; reason: SnsGateReason | null } }) {
  if (gate.used) {
    return (
      <Tag color="success" bordered={false} style={{ marginInlineEnd: 0 }}>
        已用于补货
      </Tag>
    )
  }
  return (
    <span>
      <Tag bordered={false} style={{ marginInlineEnd: 4 }}>
        未采用
      </Tag>
      <Muted>{gate.reason ? SNS_GATE_LABEL[gate.reason] : '原因未知'}</Muted>
    </span>
  )
}
