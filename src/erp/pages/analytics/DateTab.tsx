import { useMemo, useState } from 'react'
import { Alert, Segmented, Select, Space } from 'antd'
import { BR_GRANULARITY_LABEL, type BrDateResponse, type BrGranularity, type BrMetricKey, type BrPoint } from '@nova/api-contracts'
import { ChartPanel, LocalGrid, MetricStrip, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { METRIC_CHOICES, buildTrendOption } from './business-reports-options'
import { Figure, Frame, SourceTag, StatCard, metricLabel } from './business-reports-ui'

// 按日期（04 章 4.5 第 2 个页签，日与周）与月度销售与订单（第 6 个页签，月）：逐期指标表、趋势图与范围合计。
// 日粒度逐日补齐，没有记录的日子各项写“尚无记录”并支持对比期并排；周从周日起、月从 1 号起，只列有记录的期间，不支持对比期。

const COLUMN_METRICS: BrMetricKey[] = ['orderedSales', 'unitsOrdered', 'ordersCount', 'sessions', 'pageViews', 'unitSessionPct', 'avgPrice', 'buyBoxPct', 'unitsRefunded', 'refundRate']
const DATE_TITLE: Record<BrGranularity, string> = { DAY: '日期', WEEK: '周（周日起）', MONTH: '月份' }

type Row = BrPoint & { compare: BrPoint | null }

const change = (current: number | null, before: number | null | undefined) => (current === null || before === null || before === undefined || before <= 0 ? null : current / before - 1)

function columnsOf(granularity: BrGranularity, withCompare: boolean): ErpColDef<Row>[] {
  const metrics = COLUMN_METRICS.map(key => renderColumn<Row>(metricLabel(key), key, row => <Figure metric={key} value={row[key]} />, { width: 120, ...RIGHT_ALIGNED }))
  const compare: ErpColDef<Row>[] = withCompare
    ? [
        renderColumn<Row>('对比期日期', 'compareDate', row => (row.compare ? <span className="erp-num">{row.compare.date}</span> : <Muted>尚无记录</Muted>), { width: 120 }),
        renderColumn<Row>('对比期订购商品销售额', 'compareSales', row => <Figure metric="orderedSales" value={row.compare?.orderedSales} />, { width: 160, ...RIGHT_ALIGNED }),
        renderColumn<Row>(
          '销售额变化',
          'compareChange',
          row => {
            const ratio = change(row.orderedSales, row.compare?.orderedSales)
            return ratio === null ? <Muted>无法比较</Muted> : <span className="erp-num">{`${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`}</span>
          },
          { width: 110, ...RIGHT_ALIGNED },
        ),
      ]
    : []
  return [
    renderColumn<Row>(DATE_TITLE[granularity], 'date', row => <span className="erp-num">{row.date}</span>, { width: 130, pin: 'left' }),
    renderColumn<Row>('来源', 'source', row => <SourceTag source={row.source} />, { width: 90 }),
    ...metrics,
    ...compare,
  ]
}
function Body({ data }: { data: BrDateResponse }) {
  const [primary, setPrimary] = useState<BrMetricKey>('orderedSales')
  const [secondary, setSecondary] = useState<BrMetricKey | null>('sessions')
  const option = useMemo(() => buildTrendOption({ primary, secondary, points: data.points, comparePoints: data.comparePoints }), [primary, secondary, data.points, data.comparePoints])
  const rows = useMemo<Row[]>(() => data.points.map((point, index) => ({ ...point, compare: data.comparePoints?.[index] ?? null })), [data.points, data.comparePoints])
  const columns = useMemo(() => columnsOf(data.granularity, data.comparePoints !== null), [data.granularity, data.comparePoints])
  const empty = data.points.every(point => point.source === null)
  return (
    <>
      {data.compareNote ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.compareNote} data-testid="br-compare-note" /> : null}
      <MetricStrip>
        {(['orderedSales', 'unitsOrdered', 'sessions', 'unitSessionPct'] as BrMetricKey[]).map(key => (
          <StatCard key={key} title={`${metricLabel(key)}（范围合计）`} testId="br-total">
            <Figure metric={key} value={data.totals[key]} />
          </StatCard>
        ))}
      </MetricStrip>
      <ChartPanel
        title={`${BR_GRANULARITY_LABEL[data.granularity]}趋势`}
        ariaLabel={`销售与流量${BR_GRANULARITY_LABEL[data.granularity]}趋势图`}
        option={option}
        height={260}
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
      <div style={{ marginTop: 12 }} data-testid="br-date-table">
        <LocalGrid<Row>
          gridId={`analytics.business-reports.date.${data.granularity.toLowerCase()}`}
          columns={columns}
          rows={rows}
          getRowId={row => row.date}
          resetKey={String(data.comparePoints !== null)}
          emptyState={{ kind: 'empty', domain: '销售与流量', prerequisite: data.note ?? '所选范围内尚无销售与流量数据。' }}
          initialPageSize={50}
          height={460}
        />
      </div>
    </>
  )
}

/** 按日期（可在日与周之间切换）；monthly 为月度销售与订单页签（固定月粒度）。 */
export function DateTab({ monthly = false }: { monthly?: boolean }) {
  const [granularity, setGranularity] = useState<BrGranularity>('DAY')
  const effective: BrGranularity = monthly ? 'MONTH' : granularity
  const query = useApiQuery<BrDateResponse>({ domain: 'analytics', path: '/analytics/sales-traffic/by-date', params: { granularity: effective } })
  return (
    <div>
      {monthly ? null : (
        <Segmented
          style={{ margin: '8px 0' }}
          aria-label="时间粒度"
          value={granularity}
          options={(['DAY', 'WEEK'] as const).map(value => ({ value, label: BR_GRANULARITY_LABEL[value] }))}
          onChange={value => setGranularity(value as BrGranularity)}
        />
      )}
      <Frame query={query} testId={monthly ? 'br-monthly' : 'br-date'}>
        {data => <Body data={data} />}
      </Frame>
    </div>
  )
}
