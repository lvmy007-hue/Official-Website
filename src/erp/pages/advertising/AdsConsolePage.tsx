import { useMemo, useState } from 'react'
import { Alert, Button, Card, Segmented, Space, Tag, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { DASH_GRANULARITIES, GRANULARITY_LABEL, type AdsOverviewResponse, type DashGranularity } from '@nova/api-contracts'
import { ChartPanel, DataState, PageHeader, stateFromError } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { AdsCards } from './AdsCards'
import { AnomalySection, AttributionSection, BudgetSection, FunnelSection, ProductSection, QuadrantSection, TargetAcosSection } from './AdsSections'
import { buildMixOption, buildTrendOption } from './ads-options'
import { StateNote } from './ads-ui'

// 广告控制台（P3-05，08 章 8.1）：花费、销售、ACoS 一屏看清，并能追溯到活动。
// 所有数字来自广告日汇总与店铺经营日汇总；没有数据的区域如实写“尚无记录”“尚未接入”，不出现示例数字。
// 时间范围与对比期沿用顶部范围栏；没有选择时默认近 30 天、对比上一期。本页懒加载，图表在进入可视区后才加载。

const COMPARE_TEXT = { previous: '环比', yoy: '同比', custom: '自定义对比' } as const

function Notices({ data }: { data: AdsOverviewResponse }) {
  return (
    <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
      {data.state !== 'OK' ? (
        <Alert type="info" showIcon data-testid="ads-state-banner" message={data.state === 'NOT_CONNECTED' ? '广告数据尚未接入' : '所选范围内没有广告记录'} description={data.note} />
      ) : null}
      {data.otherCurrencies.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          data-testid="ads-other-currencies"
          message="部分广告账户不是美元，没有并入下列数字（不做汇率折算）"
          description={data.otherCurrencies.map(item => `${item.currency}：${item.spend === null ? '—' : `${item.spend.toFixed(2)}`}`).join('；')}
        />
      ) : null}
      {data.unboundSpend !== null && data.unboundSpend > 0 ? (
        <Alert
          type="info"
          showIcon
          data-testid="ads-unbound"
          message={`有 ${formatMoney(data.unboundSpend, 'USD', { digits: 2 })} 花费所在的广告账户还没有绑定店铺`}
          description="这部分花费计入花费、销售额、ACoS 等广告指标，但不计入“广告占总销售比”和自然销售额。"
        />
      ) : null}
      {data.campaignsTruncated ? <Alert type="warning" showIcon data-testid="ads-truncated" message="活动数量很多，活动级图表与异常只统计了花费最高的一部分活动" /> : null}
    </Space>
  )
}

function Trend({
  data,
  granularity,
  onGranularity,
  loading,
}: {
  data: AdsOverviewResponse | undefined
  granularity: DashGranularity
  onGranularity: (value: DashGranularity) => void
  loading: boolean
}) {
  const trend = data?.trend
  const mix = data?.mix
  const trendOption = useMemo(() => (trend && trend.state === 'OK' ? buildTrendOption(trend.points) : {}), [trend])
  const mixOption = useMemo(() => (mix && mix.state === 'OK' ? buildMixOption(mix.points) : {}), [mix])
  const controls = (
    <Segmented
      size="small"
      value={granularity}
      onChange={value => onGranularity(value as DashGranularity)}
      options={DASH_GRANULARITIES.map(value => ({ value, label: GRANULARITY_LABEL[value] }))}
      aria-label="时间粒度"
    />
  )
  return (
    <>
      {trend && trend.state !== 'OK' ? (
        <Card size="small" title="销售与花费趋势" extra={controls} style={{ marginBottom: 12 }} data-testid="ads-trend-empty">
          <StateNote state={trend.state} note={trend.note} />
        </Card>
      ) : (
        <div style={{ marginBottom: 12 }} data-testid="ads-trend">
          <ChartPanel title="销售与花费趋势" ariaLabel="广告销售与花费趋势图" option={trendOption} loading={loading} events={trend?.events} extra={controls} />
        </div>
      )}
      {mix && mix.state !== 'OK' ? (
        <Card size="small" title="总销售、广告销售与自然销售" style={{ marginBottom: 12 }} data-testid="ads-mix-empty">
          <StateNote state={mix.state} note={mix.note} />
        </Card>
      ) : (
        <div style={{ marginBottom: 12 }} data-testid="ads-mix">
          <ChartPanel title="总销售、广告销售与自然销售" ariaLabel="总销售广告销售自然销售与广告占总销售比" option={mixOption} loading={loading} />
          {mix?.note ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {mix.note}
            </Typography.Text>
          ) : null}
        </div>
      )}
    </>
  )
}

export default function AdsConsolePage() {
  const queryClient = useQueryClient()
  const [granularity, setGranularity] = useState<DashGranularity>('day')
  const query = useApiQuery<AdsOverviewResponse>({ domain: 'analytics', path: '/ads/overview', params: { granularity } })
  const data = query.data
  const refresh = () => void queryClient.invalidateQueries({ predicate: item => String(item.queryKey[1]) === 'analytics' })
  return (
    <div data-testid="ads-console-page">
      <PageHeader title="广告控制台" description="花费、销售、广告成本销售比（ACoS）一屏看清；每个数字都能追溯，没有数据的地方如实标注。" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', margin: '4px 0 12px' }} data-testid="ads-topbar">
        <Space size={12} wrap>
          {data ? (
            <Typography.Text type="secondary">
              {data.period.from} 至 {data.period.to}（{data.period.days} 天）
              {data.compare ? `，${COMPARE_TEXT[data.compare.mode]}对比 ${data.compare.from} 至 ${data.compare.to}` : '，未选择对比期'}
            </Typography.Text>
          ) : null}
          {data?.defaulted ? <Tag bordered={false}>默认近 30 天，对比上一期；可在范围栏调整</Tag> : null}
          {data ? <Typography.Text type="secondary">{data.refreshedAt ? `汇总刷新于 ${formatDateTime(data.refreshedAt)}` : '尚无汇总记录'}</Typography.Text> : null}
        </Space>
        <Button size="small" onClick={refresh}>
          刷新
        </Button>
      </div>
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {query.isPending && !data ? <DataState kind="skeleton" rows={6} /> : null}
      {data ? (
        <>
          <Notices data={data} />
          <AdsCards data={data} />
        </>
      ) : null}
      {data ? <Trend data={data} granularity={granularity} onGranularity={setGranularity} loading={query.isFetching && !data} /> : null}
      {data ? (
        <>
          <ProductSection data={data} />
          <FunnelSection data={data} />
          <BudgetSection data={data} />
          <TargetAcosSection data={data} />
          <QuadrantSection data={data} />
          <AnomalySection data={data} />
          <AttributionSection data={data} />
        </>
      ) : null}
    </div>
  )
}
