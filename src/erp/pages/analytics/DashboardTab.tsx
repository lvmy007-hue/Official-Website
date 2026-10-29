import { useMemo, useState } from 'react'
import { Alert, Card, Select, Space } from 'antd'
import type { BrAdsSplit, BrCard, BrFunnelStep, BrMetricKey, BrSummaryResponse, DashCompare } from '@nova/api-contracts'
import { ChartPanel, Delta, MetricStrip, MetricTreeAttribution, LocalGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatMoney, formatNumber, formatPercent, toneClassName, toneOf } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { METRIC_CHOICES, buildTrendOption, formatMetric } from './business-reports-options'
import { Figure, Frame, StatCard } from './business-reports-ui'

// 销售仪表盘（04 章 4.5 第 1 个页签）：十个指标卡（带对比期变化）、逐日趋势（主次两个指标，可叠加对比期）、转化漏斗、指标树归因、自然销售与广告销售拆分。
// 官方没给的值写“尚无记录”，不当 0；没有对比期就没有变化与归因，并写明原因；浏览器与移动应用的拆分尚未接入，页面写明。

const COMPARE_LABEL: Record<DashCompare['mode'], string> = { previous: '环比', yoy: '同比', custom: '对比期' }

function CardView({ card, compare }: { card: BrCard; compare: DashCompare | null }) {
  const label = compare ? COMPARE_LABEL[compare.mode] : '对比期'
  const points = card.changeKind === 'points' && card.change !== null
  return (
    <StatCard
      title={card.label}
      footer={
        compare ? (
          <>
            {card.changeKind === 'ratio' || card.change === null ? <Delta label={label} ratio={card.change} goodWhen={card.goodWhen} /> : null}
            {points ? (
              <span className={`erp-num ${toneClassName(toneOf(card.change, card.goodWhen))}`} data-testid={`br-points-${card.key}`}>
                {label} {card.change! > 0 ? '▲' : card.change! < 0 ? '▼' : ''}
                {formatNumber(Math.abs(card.change!) * 100, { digits: 2 })} 个百分点
              </span>
            ) : null}
            <span className="erp-num" data-testid={`br-compare-${card.key}`}>
              对比期 {formatMetric(card.key, card.compareValue)}
            </span>
          </>
        ) : null
      }
    >
      <Figure metric={card.key} value={card.value} />
    </StatCard>
  )
}

const stepRate = (step: BrFunnelStep) => {
  if (step.rate === null) return <Muted>{step.key === 'sessions' ? '—' : '尚无记录'}</Muted>
  const text = step.rateKind === 'percent' ? formatPercent(step.rate, { digits: 2 }) : formatNumber(step.rate, { digits: 2 })
  return (
    <span className="erp-num">
      {text} <Muted>（{step.rateLabel}）</Muted>
    </span>
  )
}

const funnelColumns: ErpColDef<BrFunnelStep>[] = [
  renderColumn<BrFunnelStep>('环节', 'label', row => row.label, { width: 140 }),
  renderColumn<BrFunnelStep>('数值', 'value', row => (row.value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(row.value, { digits: 0 })}</span>), {
    width: 140,
    ...RIGHT_ALIGNED,
  }),
  renderColumn<BrFunnelStep>('相对上一环节', 'rate', row => stepRate(row), { width: 220 }),
]
function SplitCard({ split, total }: { split: BrAdsSplit; total: number | null }) {
  const money = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>)
  return (
    <Card size="small" title="自然销售与广告销售" data-testid="br-split">
      <Space size={24} wrap>
        <StatCard title="订购商品销售额">{money(total)}</StatCard>
        <StatCard title="广告销售额">{money(split.adsSales)}</StatCard>
        <StatCard title="自然销售额">{money(split.organicSales)}</StatCard>
        <StatCard title="广告销售占比">{split.adsShare === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(split.adsShare, { digits: 1 })}</span>}</StatCard>
      </Space>
      {split.note ? <Alert type={split.state === 'MISMATCH' ? 'warning' : 'info'} showIcon style={{ marginTop: 8 }} message={split.note} data-testid="br-split-note" /> : null}
    </Card>
  )
}

function Body({ data }: { data: BrSummaryResponse }) {
  const [primary, setPrimary] = useState<BrMetricKey>('orderedSales')
  const [secondary, setSecondary] = useState<BrMetricKey | null>('sessions')
  const option = useMemo(() => buildTrendOption({ primary, secondary, points: data.trend, comparePoints: data.compareTrend }), [primary, secondary, data.trend, data.compareTrend])
  const sales = data.cards.find(card => card.key === 'orderedSales')?.value ?? null
  const empty = data.trend.every(point => point.source === null)
  return (
    <>
      <p style={{ margin: '4px 0 8px', color: 'rgba(0,0,0,0.65)' }} data-testid="br-coverage">
        统计范围 <span className="erp-num">{data.range.from}</span> ~ <span className="erp-num">{data.range.to}</span>，共 {data.coverage.days} 天，有数据 {data.coverage.withData} 天
        {data.coverage.reportOnly > 0 ? `（其中 ${data.coverage.reportOnly} 天只有报告补充）` : ''}
        {data.latestDate ? `，最近一天有数据的是 ${data.latestDate}` : ''}。
        {data.compare ? ` 对比期 ${data.compare.from} ~ ${data.compare.to}。` : ' 没有选对比期（在顶部范围栏选择环比、同比或自定义）。'} 金额单位 {data.currency}。
      </p>
      <MetricStrip>
        {data.cards.map(card => (
          <CardView key={card.key} card={card} compare={data.compare} />
        ))}
      </MetricStrip>
      <ChartPanel
        title="趋势"
        ariaLabel="销售与流量逐日趋势图"
        option={option}
        height={280}
        extra={
          <Space size={4}>
            <Select size="small" style={{ width: 150 }} aria-label="主指标" value={primary} options={METRIC_CHOICES} onChange={setPrimary} />
            <Select
              size="small"
              style={{ width: 150 }}
              aria-label="次指标"
              allowClear
              placeholder="次指标（可选）"
              value={secondary ?? undefined}
              options={METRIC_CHOICES}
              onChange={value => setSecondary(value ?? null)}
            />
          </Space>
        }
        emptyState={empty ? { kind: 'empty', domain: '销售与流量趋势', prerequisite: data.note ?? '所选范围内尚无销售与流量数据。' } : undefined}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12, margin: '12px 0' }}>
        <Card size="small" title="转化漏斗" data-testid="br-funnel">
          <LocalGrid<BrFunnelStep>
            gridId="analytics.business-reports.funnel"
            columns={funnelColumns}
            rows={data.funnel}
            getRowId={row => row.key}
            initialPageSize={20}
            height={260}
            emptyState={{ kind: 'empty', domain: '转化漏斗', prerequisite: '所选范围内尚无数据。' }}
          />
        </Card>
        {data.attribution ? (
          <MetricTreeAttribution title="订购商品销售额" kind="product" factors={data.attribution.factors} formatTotal={value => formatMoney(value, 'USD', { digits: 2 })} />
        ) : (
          <Card size="small" title="订购商品销售额：变化归因" data-testid="br-attribution-empty">
            <Alert type="info" showIcon message={data.attributionNote ?? '无法归因'} />
          </Card>
        )}
      </div>
      <SplitCard split={data.split} total={sales} />
      <Alert type="info" showIcon style={{ marginTop: 12 }} message="浏览器与移动应用拆分" description={data.deviceSplit.note} data-testid="br-device-split" />
    </>
  )
}

export function DashboardTab() {
  const query = useApiQuery<BrSummaryResponse>({ domain: 'analytics', path: '/analytics/sales-traffic/summary' })
  return (
    <Frame query={query} testId="br-dashboard">
      {data => <Body data={data} />}
    </Frame>
  )
}
