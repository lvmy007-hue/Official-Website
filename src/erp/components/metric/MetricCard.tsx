import type { ReactNode } from 'react'
import { Button, Card, Progress, Statistic, Tooltip, Typography } from 'antd'
import { formatMoney, formatNumber, formatPercent, NUMERIC_CLASS, toNumber, toneClassName, toneOf } from '../../format'
import { MiniTrend } from './MiniTrend'

// 指标卡（03 章 3.2 第 5 项；3.4 第 1 项）：数值、同比、环比、目标对比、可追溯入口。
// 指标名悬停显示统一口径（公式、来源、刷新频率、口径版本）；每个数字都能点开“可追溯”。

export type MetricDefinition = { description?: string; formula?: string; source: string; refresh: string; version: string }

export type MetricCardProps = {
  label: string
  value: number | string | null | undefined
  format: 'money' | 'number' | 'percent'
  currency?: string
  digits?: number
  /** 同比、环比用变化比率（0.12 表示 +12%）；没有可比数据时传 null，显示“—”。 */
  yoy?: number | null
  mom?: number | null
  /** 指标变好的方向：成本、退款率等越低越好的指标传 down。 */
  goodWhen?: 'up' | 'down'
  target?: { value: number; label?: string }
  trend?: number[]
  definition?: MetricDefinition
  /** 点开数字的追溯弹层；不传则不显示入口。 */
  onTrace?: () => void
  /** 数值缺失时的原因（例如“广告尚未授权”），代替空白。 */
  unavailableReason?: string
  /** 模型估算类指标标注。 */
  estimate?: ReactNode
}

function formatValue(props: Pick<MetricCardProps, 'value' | 'format' | 'currency' | 'digits'>): string {
  const { value, format, currency, digits } = props
  if (format === 'money') return formatMoney(value, currency ?? 'USD', { digits: digits ?? 2 })
  if (format === 'percent') return formatPercent(value, { digits: digits ?? 1 })
  return formatNumber(value, { digits: digits ?? 0 })
}

export function Delta({ label, ratio, goodWhen }: { label: string; ratio: number | null | undefined; goodWhen?: 'up' | 'down' }) {
  const n = toNumber(ratio)
  if (n === null) {
    return (
      <span className="erp-num" aria-label={`${label}：无可比数据`} style={{ color: 'var(--ant-color-text-quaternary)' }}>
        {label} —
      </span>
    )
  }
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : ''
  return (
    <span className={`${NUMERIC_CLASS} ${toneClassName(toneOf(n, goodWhen))}`} aria-label={`${label}：${formatPercent(n, { sign: true })}`}>
      {label} {arrow}
      {formatPercent(Math.abs(n))}
    </span>
  )
}

export function MetricDefinitionTip({ definition }: { definition: MetricDefinition }) {
  return (
    <div style={{ maxWidth: 280 }}>
      {definition.description ? <div>{definition.description}</div> : null}
      {definition.formula ? <div>公式：{definition.formula}</div> : null}
      <div>来源：{definition.source}</div>
      <div>刷新：{definition.refresh}</div>
      <div>口径版本：{definition.version}</div>
    </div>
  )
}

export function MetricCard(props: MetricCardProps) {
  const missing = toNumber(props.value) === null
  const title = props.definition ? (
    <Tooltip title={<MetricDefinitionTip definition={props.definition} />}>
      <span style={{ borderBottom: '1px dotted currentColor', cursor: 'help' }}>{props.label}</span>
    </Tooltip>
  ) : (
    props.label
  )
  const targetValue = props.target && toNumber(props.value) !== null ? Math.min(100, Math.round((toNumber(props.value)! / props.target.value) * 100)) : null
  return (
    <Card size="small" data-testid="metric-card" styles={{ body: { padding: '10px 12px' } }} style={{ minWidth: 0 }}>
      <Statistic
        title={title}
        valueRender={() => (
          <span className={NUMERIC_CLASS} style={{ fontSize: 20, fontWeight: 600 }}>
            {formatValue(props)}
          </span>
        )}
        value={missing ? 0 : (toNumber(props.value) ?? 0)}
      />
      {missing && props.unavailableReason ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {props.unavailableReason}
        </Typography.Text>
      ) : null}
      {!missing || props.yoy !== undefined || props.mom !== undefined ? (
        <div style={{ display: 'flex', gap: 10, fontSize: 12, marginTop: 4, flexWrap: 'wrap' }}>
          {props.yoy !== undefined ? <Delta label="同比" ratio={props.yoy} goodWhen={props.goodWhen} /> : null}
          {props.mom !== undefined ? <Delta label="环比" ratio={props.mom} goodWhen={props.goodWhen} /> : null}
        </div>
      ) : null}
      {props.target && targetValue !== null ? (
        <div style={{ marginTop: 4 }}>
          <Progress percent={targetValue} size="small" showInfo={false} status={targetValue >= 100 ? 'success' : 'active'} aria-label="目标完成度" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {props.target.label ?? '目标'} {formatValue({ ...props, value: props.target.value })}，完成 {targetValue}%
          </Typography.Text>
        </div>
      ) : null}
      {props.trend && props.trend.length > 1 ? (
        <div style={{ marginTop: 4 }}>
          <MiniTrend points={props.trend} label={`${props.label}趋势`} width={120} height={22} />
        </div>
      ) : null}
      {props.estimate ? <div style={{ marginTop: 4 }}>{props.estimate}</div> : null}
      {props.onTrace && !missing ? (
        <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={props.onTrace} aria-label={`追溯${props.label}`}>
          追溯
        </Button>
      ) : null}
    </Card>
  )
}

/** 指标卡带：一行 5 至 7 个（更多自动换行）。 */
export function MetricStrip({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, marginBottom: 8 }}>{children}</div>
}
