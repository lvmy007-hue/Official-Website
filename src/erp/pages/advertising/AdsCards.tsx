import { useState } from 'react'
import { Card, Space, Typography } from 'antd'
import { ADS_CARD_DEFINITION, ADS_CARD_GOOD_WHEN, type AdsCard, type AdsOverviewResponse } from '@nova/api-contracts'
import { Delta, MiniTrend, TraceDialog, type TraceInfo } from '../../components'
import { formatMoney, formatNumber, formatPercent, NUMERIC_CLASS, toneClassName, toneOf } from '../../format'
import { StateNote } from './ads-ui'

// 广告控制台的 12 张指标卡（08 章 8.1）：每张带变化、迷你趋势与追溯入口；没有数据的卡写“尚未接入”“尚无记录”，不显示成 0。

const COMPARE_LABEL = { previous: '环比', yoy: '同比', custom: '较对比期' } as const

const formatValue = (card: AdsCard) => {
  if (card.value === null) return '—'
  if (card.format === 'money') return formatMoney(card.value, 'USD', { digits: 2 })
  if (card.format === 'percent') return formatPercent(card.value, { digits: 1 })
  if (card.key === 'roas') return formatNumber(card.value, { digits: 2 })
  return formatNumber(card.value, { digits: 0 })
}

function Change({ card, data }: { card: AdsCard; data: AdsOverviewResponse }) {
  if (!data.compare || card.state !== 'OK' || card.compareValue === null) return null
  const label = COMPARE_LABEL[data.compare.mode]
  if (card.changeKind === 'ratio') return <Delta label={label} ratio={card.change} goodWhen={ADS_CARD_GOOD_WHEN[card.key]} />
  if (card.change === null) return <Delta label={label} ratio={null} />
  const points = card.change * 100
  return (
    <span className={`${NUMERIC_CLASS} ${toneClassName(toneOf(points, ADS_CARD_GOOD_WHEN[card.key]))}`} aria-label={`${label}：${formatNumber(points, { digits: 1, sign: true })} 个百分点`}>
      {label} {points > 0 ? '▲' : points < 0 ? '▼' : ''}
      {formatNumber(Math.abs(points), { digits: 1 })} 个百分点
    </span>
  )
}

function Tile({ card, data, onTrace }: { card: AdsCard; data: AdsOverviewResponse; onTrace: () => void }) {
  const trend = card.trend ? card.trend.filter((value): value is number => value !== null) : []
  return (
    <Card size="small" data-testid={`ads-card-${card.key}`} styles={{ body: { padding: '10px 12px' } }} style={{ minWidth: 0 }}>
      <Typography.Text type="secondary">{card.label}</Typography.Text>
      {card.state === 'OK' ? (
        <>
          <div className={NUMERIC_CLASS} style={{ fontSize: 22, fontWeight: 600 }}>
            {formatValue(card)}
          </div>
          <div style={{ fontSize: 12, marginTop: 2 }}>
            <Change card={card} data={data} />
          </div>
          {trend.length > 1 ? <MiniTrend points={trend} label={`${card.label}趋势`} width={120} height={22} /> : null}
          {card.note ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{card.note}</div> : null}
        </>
      ) : (
        <div style={{ marginTop: 4, minHeight: 54 }}>
          <StateNote state={card.state} note={card.note} />
        </div>
      )}
      {card.state === 'OK' ? (
        <Space size={12} style={{ marginTop: 4, fontSize: 12 }}>
          <Typography.Link onClick={onTrace} aria-label={`追溯${card.label}`}>
            追溯
          </Typography.Link>
        </Space>
      ) : null}
    </Card>
  )
}

export function AdsCards({ data }: { data: AdsOverviewResponse }) {
  const [traceKey, setTraceKey] = useState<AdsCard['key'] | null>(null)
  const traced = data.cards.find(card => card.key === traceKey) ?? null
  const info: TraceInfo | null = traced
    ? {
        metric: traced.label,
        ...ADS_CARD_DEFINITION[traced.key],
        records: [],
        syncedAt: data.refreshedAt,
        quality: { level: traced.note ? 'warning' : 'ok', notes: traced.note ? [traced.note] : [] },
        definitionVersion: data.metricVersion ?? '尚无汇总记录',
      }
    : null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }} data-testid="ads-cards">
        {data.cards.map(card => (
          <Tile key={card.key} card={card} data={data} onTrace={() => setTraceKey(card.key)} />
        ))}
      </div>
      <TraceDialog open={traced !== null} onClose={() => setTraceKey(null)} info={info} />
    </div>
  )
}
