import { useMemo, useState } from 'react'
import { Alert, Card, Checkbox, Segmented, Select, Space, Typography } from 'antd'
import { DASH_GRANULARITIES, GRANULARITY_LABEL, TREND_METRICS, TREND_METRIC_LABEL, type AttributionResponse, type DashGranularity, type TrendMetric, type TrendResponse } from '@nova/api-contracts'
import { ChartPanel, DataState, MetricTreeAttribution, stateFromError } from '../../components'
import { formatMoney } from '../../format'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { COMPARE_LABEL, Section, StateNote } from './dash-parts'
import { buildTrendOption } from './trend-option'

// 销售与利润趋势（04 章 4.1 第 3 项）：日、周、月切换，同比与环比线，事件标注，点选某天（周、月）看指标树归因。
// 归因：会话数据未接入时退化为“件数 × 件单价”两因子，并写明原因；利润桥未接入时如实说明。

function Attribution({ date, granularity }: { date: string; granularity: DashGranularity }) {
  const query = useApiQuery<AttributionResponse>({ domain: 'analytics', path: '/overview/attribution', params: { date, granularity } })
  const data = query.data
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || !data) return <DataState kind="skeleton" rows={3} />
  const range = `${data.current.from} 至 ${data.current.to}`
  return (
    <div data-testid="attribution">
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        {range} 对比 {data.previous.from} 至 {data.previous.to}：销售额 {formatMoney(data.sales.before)} → {formatMoney(data.sales.after)}
      </Typography.Paragraph>
      {data.state !== 'OK' ? (
        <StateNote state={data.state} />
      ) : (
        <>
          {data.mode === 'TWO_FACTOR' ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8 }}
              message="按“件数 × 件单价”两因子归因"
              description={data.unavailable.map(item => `${item.label}：${item.reason}`).join('；') || '会话数据尚未接入，暂不拆会话与转化率。'}
            />
          ) : null}
          <MetricTreeAttribution title="销售额" kind="product" factors={data.factors} formatTotal={value => formatMoney(value, 'USD', { digits: 2 })} />
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <Typography.Text type="secondary">利润桥：</Typography.Text> <StateNote state={data.profitBridge.state} note={data.profitBridge.note} />
      </div>
    </div>
  )
}

export function TrendSection() {
  const [granularity, setGranularity] = useState<DashGranularity>('day')
  const [metric, setMetric] = useState<TrendMetric>('sales')
  const [lines, setLines] = useState({ previous: true, yoy: false })
  const [picked, setPicked] = useState<string | null>(null)
  const query = useApiQuery<TrendResponse>({ domain: 'analytics', path: '/overview/trend', params: { granularity, metric } })
  const data = query.data
  const option = useMemo(() => (data && data.state === 'OK' ? buildTrendOption(data, lines) : {}), [data, lines])
  const keys = data?.points.map(point => point.key) ?? []
  const controls = (
    <Space size={8} wrap>
      <Segmented
        size="small"
        value={granularity}
        onChange={value => (setGranularity(value as DashGranularity), setPicked(null))}
        options={DASH_GRANULARITIES.map(value => ({ value, label: GRANULARITY_LABEL[value] }))}
        aria-label="时间粒度"
      />
      <Segmented
        size="small"
        value={metric}
        onChange={value => setMetric(value as TrendMetric)}
        options={TREND_METRICS.map(value => ({ value, label: TREND_METRIC_LABEL[value] }))}
        aria-label="指标切换"
      />
      <Checkbox checked={lines.previous} onChange={event => setLines(value => ({ ...value, previous: event.target.checked }))}>
        {COMPARE_LABEL.previous}
      </Checkbox>
      <Checkbox checked={lines.yoy} onChange={event => setLines(value => ({ ...value, yoy: event.target.checked }))}>
        {COMPARE_LABEL.yoy}
      </Checkbox>
    </Space>
  )
  const note = data && !(lines.previous && data.previous) && lines.previous ? '没有上一期数据，未画环比线' : null
  return (
    <div style={{ marginBottom: 12 }} data-testid="trend-section">
      {data && data.state !== 'OK' ? (
        <Card size="small" title="销售与利润趋势" extra={controls}>
          <StateNote state={data.state} note={data.note} />
        </Card>
      ) : (
        <ChartPanel
          title="销售与利润趋势"
          ariaLabel={`${TREND_METRIC_LABEL[metric]}趋势图`}
          option={option}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          events={data?.events}
          extra={controls}
          onCategoryClick={key => keys.includes(key) && setPicked(key)}
        />
      )}
      {note ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {note}
        </Typography.Text>
      ) : null}
      {data && data.profit.state !== 'OK' && metric === 'sales' ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
          净利润第二轴：{data.profit.state === 'RESTRICTED' ? '无权查看' : '尚未接入'}，{data.profit.note}
        </Typography.Text>
      ) : null}
      {data && data.state === 'OK' ? (
        <Section
          title="变化归因"
          extra={
            <Select
              size="small"
              style={{ width: 140 }}
              placeholder={`选择${GRANULARITY_LABEL[granularity]}`}
              value={picked ?? undefined}
              onChange={setPicked}
              options={keys.map(key => ({ value: key, label: key }))}
              aria-label="归因日期"
            />
          }
        >
          {picked ? (
            <Attribution date={picked} granularity={granularity} />
          ) : (
            <Typography.Text type="secondary">
              点选图上的某个点，或在右上角选择日期，查看该{GRANULARITY_LABEL[granularity]}相对上一{GRANULARITY_LABEL[granularity]}的销售额变化由哪些因子造成。
            </Typography.Text>
          )}
        </Section>
      ) : null}
    </div>
  )
}
