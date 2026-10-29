import { useState } from 'react'
import { Card, Space, Tag, Tooltip, Typography } from 'antd'
import type { KpiCard, KpiKey, KpisResponse } from '@nova/api-contracts'
import { DataState, Delta, MiniTrend, stateFromError, TraceDialog, type TraceInfo } from '../../components'
import { formatMoney, formatNumber, formatPercent, NUMERIC_CLASS, toneClassName, toneOf } from '../../format'
import { describeError } from '../../query/errors'
import { COMPARE_LABEL, DrillLink, StateNote, useDrillPath } from './dash-parts'

// 指标卡（04 章 4.1 第 2 项）：7 张卡，每张带变化、迷你趋势、追溯入口、下钻入口。
// 没有数据的卡如实写“尚未接入”“尚无记录”“无权查看”，不显示成 0。

const GOOD_WHEN: Record<KpiKey, 'up' | 'down'> = { sales: 'up', profit: 'up', margin: 'up', adsSpend: 'down', adsShare: 'down', stockRisk: 'down', anomalies: 'down' }

const DEFINITION: Record<KpiKey, { definition: string; formula?: string; source: string }> = {
  sales: { definition: '所选范围内各店铺每日销售额之和（取消订单不计）；按企业时区切日。', formula: '销售额 = Σ 订单商品金额', source: '店铺经营日汇总（订单口径）' },
  profit: { definition: '销售额扣除各项成本与费用后的净利润。', formula: '净利润 = 销售额 − 成本 − 费用 − 广告 − 退款', source: '利润日表（尚未接入）' },
  margin: { definition: '净利润占销售额的比例。', formula: '利润率 = 净利润 ÷ 销售额', source: '利润日表（尚未接入）' },
  adsSpend: { definition: '所选范围内的广告花费合计。', source: '广告报表（尚未接入）' },
  adsShare: { definition: '广告花费占总销售额的比例（M-008）。', formula: '广告占总销售比 = 广告花费 ÷ 销售额', source: '广告报表与店铺经营日汇总' },
  stockRisk: { definition: '可售天数低于阈值的商品数量。', source: '库存规则引擎（尚未接入）' },
  anomalies: { definition: '预警实例处于“新”或“已确认待处理”的数量（M-010）。', source: '预警实例' },
}

const formatValue = (card: KpiCard) => {
  if (card.value === null) return '—'
  if (card.format === 'money') return formatMoney(card.value, 'USD', { digits: 2 })
  if (card.format === 'percent') return formatPercent(card.value, { digits: 1 })
  return formatNumber(card.value, { digits: 0 })
}

function Change({ card, data }: { card: KpiCard; data: KpisResponse }) {
  if (!data.compare || card.state !== 'OK') return null
  const label = COMPARE_LABEL[data.compare.mode]
  if (card.changeKind === 'ratio') return <Delta label={label} ratio={card.change} goodWhen={GOOD_WHEN[card.key]} />
  if (card.change === null) return <Delta label={label} ratio={null} />
  const points = card.change * 100
  return (
    <span className={`${NUMERIC_CLASS} ${toneClassName(toneOf(points, GOOD_WHEN[card.key]))}`} aria-label={`${label}：${formatNumber(points, { digits: 1, sign: true })} 个百分点`}>
      {label} {points > 0 ? '▲' : points < 0 ? '▼' : ''}
      {formatNumber(Math.abs(points), { digits: 1 })} 个百分点
    </span>
  )
}

function Tile({ card, data, onTrace }: { card: KpiCard; data: KpisResponse; onTrace: () => void }) {
  const trend = card.trend ? card.trend.filter((value): value is number => value !== null) : []
  return (
    <Card size="small" data-testid={`kpi-${card.key}`} styles={{ body: { padding: '10px 12px' } }} style={{ minWidth: 0 }}>
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
      {card.key === 'profit' ? (
        <Tooltip title={data.officialProfit.note}>
          <Tag bordered={false} style={{ marginTop: 4 }}>
            官方净收益对照：尚未接入
          </Tag>
        </Tooltip>
      ) : null}
      <Space size={12} style={{ marginTop: 4, fontSize: 12 }}>
        {card.state === 'OK' ? (
          <Typography.Link onClick={onTrace} aria-label={`追溯${card.label}`}>
            追溯
          </Typography.Link>
        ) : null}
        <DrillLink component={card.drill} />
      </Space>
    </Card>
  )
}

// 目标达成横幅（P2a-04 消费方）：只统计范围内已设置当月整店销售额目标的店铺，统一按天均摊节奏换算。
function TargetBanner({ data }: { data: KpisResponse }) {
  const target = data.target
  if (target.state === 'NOT_CONNECTED') {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="kpi-target">
        目标达成进度：尚未接入（{target.note}）
      </Typography.Text>
    )
  }
  const tone = target.achievementRatio === null ? 'neutral' : toneOf(target.achievementRatio - target.expectedToDateRatio, 'up')
  return (
    <Space direction="vertical" size={2} style={{ fontSize: 12 }} data-testid="kpi-target">
      <Typography.Text>
        目标达成进度：{formatMoney(target.actualValue, 'USD', { digits: 0 })} / {formatMoney(target.targetValue, 'USD', { digits: 0 })}
        {target.achievementRatio === null ? '（目标为 0，无法计算达成率）' : <span className={toneClassName(tone)}> {formatPercent(target.achievementRatio, { digits: 1 })}</span>}
        （预期进度 {formatPercent(target.expectedToDateRatio, { digits: 1 })}，覆盖 {target.storesCovered}/{target.storesTotal} 个店铺）
      </Typography.Text>
      {target.note ? <Typography.Text type="secondary">{target.note}</Typography.Text> : null}
      <DrillLink component="TargetsPage" label="查看目标与预算" />
    </Space>
  )
}

function CardTrace({ card, data, onClose }: { card: KpiCard | null; data: KpisResponse; onClose: () => void }) {
  const path = useDrillPath(card?.drill ?? '')
  const info: TraceInfo | null = card
    ? {
        metric: card.label,
        ...DEFINITION[card.key],
        records: path ? [{ label: '下钻查看明细', href: path }] : [],
        syncedAt: data.refreshedAt,
        quality: { level: card.state === 'OK' ? (card.note ? 'warning' : 'ok') : 'error', notes: card.note ? [card.note] : [] },
        definitionVersion: data.metricVersion ?? '尚无汇总记录',
      }
    : null
  return <TraceDialog open={card !== null} onClose={onClose} info={info} />
}

export function KpiSection(props: { data?: KpisResponse; loading: boolean; error: unknown; onRetry: () => void; cardKeys: readonly KpiKey[] }) {
  const [traceKey, setTraceKey] = useState<KpiKey | null>(null)
  const { data } = props
  if (props.error) return <DataState {...stateFromError(describeError(props.error), { onRetry: props.onRetry })} />
  if (props.loading || !data) return <DataState kind="skeleton" rows={3} />
  const cards = props.cardKeys.map(key => data.cards.find(card => card.key === key)).filter((card): card is KpiCard => card !== undefined)
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
        {cards.map(card => (
          <Tile key={card.key} card={card} data={data} onTrace={() => setTraceKey(card.key)} />
        ))}
      </div>
      <TargetBanner data={data} />
      <CardTrace card={cards.find(card => card.key === traceKey) ?? null} data={data} onClose={() => setTraceKey(null)} />
    </div>
  )
}
