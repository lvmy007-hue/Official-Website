import { useMemo } from 'react'
import { Alert, Button, Card, Space, Tag, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { ADS_TODAY_BAND_MIN_SAMPLES, type AdsTodayResponse, type AdsTodayStreamState, type AdsTodayTotals } from '@nova/api-contracts'
import { ChartPanel, DataState, PageHeader, stateFromError } from '../../components'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { buildHourlyOption } from './ads-today-options'
import { AnomaliesSection, BudgetSection, OutOfBudgetSection, StockoutSection } from './ads-today-sections'
import { Section, StateNote } from './ads-ui'

// 今日广告（P3-06，08 章 8.2）：今天的花费、点击、单次点击成本与广告销售额，小时曲线叠加历史同时段区间带，预算进度与预计耗尽时间、异常。
// 数据来自营销数据流的小时指标；接收端没配置时正式显示“未接入”，并退化展示最近一天的日报表汇总。本页懒加载，图表在进入可视区后才加载。
// 转化数据（销售额、订单）滞后，页面固定标注更新节奏；没有数据的地方写“尚无记录”“尚未接入”，不出现示例数字。

const STREAM_TAG: Record<AdsTodayStreamState, { color: string; text: string }> = {
  LIVE: { color: 'success', text: '数据流已接入' },
  NOT_CONNECTED: { color: 'default', text: '数据流未接入' },
  NO_DATA: { color: 'warning', text: '今日尚无小时指标' },
}

const money = (value: number | null) => formatMoney(value, 'USD', { digits: 2 })

function Metric({ label, value, compare }: { label: string; value: string; compare?: string | null }) {
  return (
    <Card size="small" style={{ minWidth: 168 }} data-testid={`ads-today-metric-${label}`}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      {compare ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {compare}
        </Typography.Text>
      ) : null}
    </Card>
  )
}

const compareText = (label: string, value: string | null) => (value === null ? null : `${label} ${value}`)

function Totals({ data }: { data: AdsTodayResponse }) {
  const value = data.totals.value
  const yesterday = data.totals.yesterdaySameHour
  if (!value) {
    return (
      <Section title="今日指标" testId="ads-today-totals">
        <StateNote state={data.totals.state} note={data.totals.note} />
      </Section>
    )
  }
  return (
    <Section title={`今日指标（${data.businessDate}）`} testId="ads-today-totals">
      <Space size={12} wrap>
        <Metric label="花费" value={money(value.spend)} compare={compareText('昨日同时段', yesterday ? money(yesterday.spend) : null)} />
        <Metric label="点击" value={formatNumber(value.clicks, { digits: 0 })} compare={compareText('昨日同时段', yesterday ? formatNumber(yesterday.clicks, { digits: 0 }) : null)} />
        <Metric label="单次点击成本" value={money(value.cpc)} compare={compareText('昨日同时段', yesterday ? money(yesterday.cpc) : null)} />
        <Metric label="广告销售额" value={money(value.sales)} compare="转化数据滞后，今日偏低属正常" />
      </Space>
      <div style={{ marginTop: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          曝光 {formatNumber(value.impressions, { digits: 0 })}，订单 {formatNumber(value.orders, { digits: 0 })}
          {data.asOf ? `；小时指标最近更新于 ${formatDateTime(data.asOf)}` : ''}
        </Typography.Text>
      </div>
    </Section>
  )
}

function Fallback({ fallback }: { fallback: NonNullable<AdsTodayResponse['fallback']> }) {
  const totals: AdsTodayTotals = fallback.totals
  return (
    <Section title={`最近一天的日报表（${fallback.summaryDate}）`} testId="ads-today-fallback">
      <Space size={12} wrap>
        <Metric label="花费" value={money(totals.spend)} />
        <Metric label="点击" value={formatNumber(totals.clicks, { digits: 0 })} />
        <Metric label="单次点击成本" value={money(totals.cpc)} />
        <Metric label="广告销售额" value={money(totals.sales)} />
      </Space>
      <div style={{ marginTop: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          退化展示：这是日报表汇总，不是今天的数据{fallback.refreshedAt ? `（汇总刷新于 ${formatDateTime(fallback.refreshedAt)}）` : ''}。
        </Typography.Text>
      </div>
    </Section>
  )
}

function Hourly({ data }: { data: AdsTodayResponse }) {
  const hours = data.hours
  const option = useMemo(() => buildHourlyOption(hours.items), [hours.items])
  if (hours.state !== 'OK') {
    return (
      <Section title="小时曲线" testId="ads-today-hourly-empty">
        <StateNote state={hours.state} note={hours.note} />
      </Section>
    )
  }
  return (
    <div style={{ marginBottom: 12 }} data-testid="ads-today-hourly">
      <ChartPanel title="小时曲线" ariaLabel="今日小时花费与点击" option={option} height={280} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        虚线是过去 {hours.historyDays} 天同一小时的花费区间（同时段样本不足 {ADS_TODAY_BAND_MIN_SAMPLES} 天的小时不画）；没有小时指标行的小时断开，不当 0；当前小时还没走完。
      </Typography.Text>
    </div>
  )
}

export default function AdsTodayPage() {
  const queryClient = useQueryClient()
  // 营销数据流最快每 15 分钟更新；页面开着时每 5 分钟自动重读一次
  const query = useApiQuery<AdsTodayResponse>({ domain: 'analytics', path: '/ads/today', refetchIntervalMs: 300_000 })
  const data = query.data
  const refresh = () => void queryClient.invalidateQueries({ predicate: item => String(item.queryKey[1]) === 'analytics' })
  const tag = data ? STREAM_TAG[data.streamState] : null
  return (
    <div data-testid="ads-today-page">
      <PageHeader
        title="今日广告"
        description="今天的花费、点击与预算进度，近实时；转化数据滞后，以日报表为准。"
        actions={
          <Space>
            {tag ? <Tag color={tag.color}>{tag.text}</Tag> : null}
            <Button size="small" onClick={refresh}>
              刷新
            </Button>
          </Space>
        }
      />
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {query.isPending && !data ? <DataState kind="skeleton" rows={6} /> : null}
      {data ? (
        <>
          <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
            <Alert type="info" showIcon data-testid="ads-today-update-note" message={data.updateNote} />
            {data.streamState !== 'LIVE' ? (
              <Alert
                type="warning"
                showIcon
                data-testid="ads-today-stream-banner"
                message={data.streamState === 'NOT_CONNECTED' ? '营销数据流未接入' : '今天还没有收到小时指标'}
                description={data.note}
              />
            ) : null}
            {data.otherCurrencies.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                data-testid="ads-today-other-currencies"
                message="部分广告账户的小时指标不是美元，没有并入下列数字（不做汇率折算）"
                description={data.otherCurrencies.map(item => `${item.currency}：${item.spend === null ? '—' : item.spend.toFixed(2)}`).join('；')}
              />
            ) : null}
            {data.truncated ? <Alert type="warning" showIcon data-testid="ads-today-truncated" message="活动数量很多，活动级区块只统计了一部分活动" /> : null}
          </Space>
          <Totals data={data} />
          {data.fallback ? <Fallback fallback={data.fallback} /> : null}
          <Hourly data={data} />
          <BudgetSection budget={data.budget} />
          <OutOfBudgetSection outOfBudget={data.outOfBudget} />
          <AnomaliesSection anomalies={data.anomalies} />
          <StockoutSection stockout={data.stockout} />
        </>
      ) : null}
    </div>
  )
}
