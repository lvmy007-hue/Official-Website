import { useMemo, useState } from 'react'
import { Alert, Button, Card, Descriptions, Select, Space, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ADS_CAMPAIGN_WRITE,
  ADS_WEEKDAY_LABEL,
  hourlyMetricValue,
  type AdsAttributionTree,
  type AdsCampaignChangeRow,
  type AdsCampaignChangesResponse,
  type AdsCampaignForecastResponse,
  type AdsCampaignHistoryResponse,
  type AdsCampaignHourlyResponse,
  type AdsCampaignRecommendationsResponse,
  type AdsCampaignTrendResponse,
  type AdsHourlyCell,
  type AdsRecommendationRow,
} from '@nova/api-contracts'
import { ChartPanel, DataState, FormAction, MetricTreeAttribution, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '../../format'
import { describeError } from '../../query/errors'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { buildTrendOption } from './ads-campaign-options'
import { moneyCell, TabNote } from './ads-campaigns-ui'
import { StateNote } from './ads-ui'

// 活动详情的其余页签：表现趋势、分时表现、预算与竞价历史、预测与推荐、操作记录。

const base = (id: string, tab: string) => `/ads/campaigns/${encodeURIComponent(id)}/${tab}`

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <DataState {...stateFromError(describeError(error), { onRetry })} />
}

function Tree({ tree }: { tree: AdsAttributionTree }) {
  return <MetricTreeAttribution title={tree.title} kind="product" factors={tree.factors} formatTotal={value => formatNumber(value, { digits: 2 })} />
}

export function TrendTab({ id, path }: { id: string; path?: string }) {
  const query = useApiQuery<AdsCampaignTrendResponse>({ domain: 'analytics', path: path ?? base(id, 'trend') })
  const data = query.data
  const option = useMemo(() => (data ? buildTrendOption(data) : {}), [data])
  if (query.error) return <Failed error={query.error} onRetry={() => void query.refetch()} />
  if (!data) return <DataState kind="skeleton" rows={4} />
  if (data.state !== 'OK') return <TabNote state={data.state} note={data.note} />
  return (
    <div data-testid="campaign-trend">
      <ChartPanel title="花费、广告销售额与点击" ariaLabel="活动趋势" option={option} height={300} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        没有汇总行的日期断开显示，不当 0；虚线是对比期花费（按天数位置对齐）。竖线是本系统内的改动（标签、负责人）。{data.amazonEvents.note}
      </Typography.Paragraph>
      <Card size="small" title="指标树归因" data-testid="campaign-attribution">
        {data.attribution.state !== 'OK' ? (
          <StateNote state={data.attribution.state} note={data.attribution.note} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {data.attribution.note ? <Alert type="info" showIcon message={data.attribution.note} /> : null}
            {data.attribution.spend ? <Tree tree={data.attribution.spend} /> : null}
            {data.attribution.sales ? <Tree tree={data.attribution.sales} /> : null}
          </Space>
        )}
      </Card>
    </div>
  )
}

// ---- 分时表现：星期 × 小时的格子（用普通表格，不依赖热力图组件）----

const HOURLY_METRICS = [
  { value: 'spend', label: '花费' },
  { value: 'orders', label: '转化（订单）' },
  { value: 'acos', label: '广告成本销售比' },
  { value: 'cpc', label: '单次点击成本' },
] as const
type HourlyMetric = (typeof HOURLY_METRICS)[number]['value']

const hourlyText = (metric: HourlyMetric, value: number): string =>
  metric === 'orders' ? formatNumber(value, { digits: 0 }) : metric === 'acos' ? formatPercent(value, { digits: 0 }) : formatMoney(value, 'USD', { digits: metric === 'cpc' ? 2 : 0 })

function HourlyGrid({ cells, metric }: { cells: AdsHourlyCell[]; metric: HourlyMetric }) {
  const byKey = new Map(cells.map(cell => [`${cell.weekday}|${cell.hour}`, cell]))
  const values = cells.map(cell => hourlyMetricValue(cell, metric)).filter((value): value is number => value !== null)
  const max = Math.max(0, ...values)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-testid="hourly-grid" aria-label="分时表现" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, hour) => (
              <th key={hour} style={{ padding: '2px 4px', fontWeight: 400 }}>
                {hour}时
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ADS_WEEKDAY_LABEL.map((label, weekday) => (
            <tr key={label}>
              <th style={{ padding: '2px 6px', fontWeight: 400, textAlign: 'right' }}>{label}</th>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = byKey.get(`${weekday}|${hour}`)
                const value = cell ? hourlyMetricValue(cell, metric) : null
                const alpha = value === null ? 0 : max > 0 ? 0.12 + (0.7 * value) / max : 0.12
                return (
                  <td
                    key={hour}
                    title={cell ? `${label} ${hour} 时：累计 ${cell.samples} 个小时样本` : `${label} ${hour} 时：无数据`}
                    style={{ minWidth: 34, height: 24, textAlign: 'center', border: '1px solid #f0f0f0', background: value === null ? '#fafafa' : `rgba(22,119,255,${alpha.toFixed(2)})` }}
                  >
                    {value === null ? '—' : hourlyText(metric, value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function HourlyTab({ id, path }: { id: string; path?: string }) {
  const [metric, setMetric] = useState<HourlyMetric>('spend')
  const query = useApiQuery<AdsCampaignHourlyResponse>({ domain: 'analytics', path: path ?? base(id, 'hourly'), scoped: false })
  const data = query.data
  if (query.error) return <Failed error={query.error} onRetry={() => void query.refetch()} />
  if (!data) return <DataState kind="skeleton" rows={4} />
  return (
    <div data-testid="campaign-hourly">
      {data.state !== 'OK' ? <TabNote state={data.state} note={data.note} /> : null}
      {data.state === 'OK' ? (
        <>
          <Space style={{ marginBottom: 8 }}>
            <Select value={metric} aria-label="分时指标" style={{ width: 180 }} options={HOURLY_METRICS.map(item => ({ value: item.value, label: item.label }))} onChange={value => setMetric(value)} />
            <Muted>近 {data.historyDays} 天，按企业时区累计；没有数据的格子显示“—”。</Muted>
          </Space>
          <HourlyGrid cells={data.cells} metric={metric} />
        </>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <TabNote state={data.reportHours.state} note={data.reportHours.note} />
      </div>
    </div>
  )
}

// ---- 预算与竞价历史 ----

export function HistoryTab({ id }: { id: string }) {
  const query = useApiQuery<AdsCampaignHistoryResponse>({ domain: 'analytics', path: base(id, 'history'), scoped: false })
  const data = query.data
  if (query.error) return <Failed error={query.error} onRetry={() => void query.refetch()} />
  if (!data) return <DataState kind="skeleton" rows={4} />
  const { current } = data
  return (
    <div data-testid="campaign-history">
      <Descriptions size="small" bordered column={{ xs: 1, md: 2 }} title="当前设置（来自最近一次活动同步）">
        <Descriptions.Item label="预算">
          {current.budget === null ? <Muted>尚无记录</Muted> : `${formatMoney(current.budget, current.currency, { digits: 2 })}${current.budgetType ? `（${current.budgetType}）` : ''}`}
        </Descriptions.Item>
        <Descriptions.Item label="竞价策略">{current.bidStrategy ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="投放状态">{current.servingStatus ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
      </Descriptions>
      {(
        [
          ['预算变更历史', data.budgetChanges],
          ['竞价变更历史', data.bidChanges],
          ['超预算记录', data.overBudget],
        ] as const
      ).map(([title, section]) => (
        <Card key={title} size="small" title={title} style={{ marginTop: 12 }}>
          <TabNote state={section.state} note={section.note} />
        </Card>
      ))}
    </div>
  )
}

// ---- 预测与推荐 ----

export function DismissButton({ recommendationId }: { recommendationId: string }) {
  const mutation = useApiMutation<{ reason: string }, unknown>({ method: 'POST', path: `/ads/recommendations/${encodeURIComponent(recommendationId)}/dismiss`, invalidate: ['analytics'] })
  return (
    <FormAction
      label="忽略"
      title="忽略官方推荐"
      guard={{ permission: ADS_CAMPAIGN_WRITE }}
      description="只在本系统里标记为“已忽略”，不会通知亚马逊；原因会记入操作记录。"
      reason={{ label: '忽略原因', placeholder: '例如：该推荐的预算超出本月计划' }}
      okText="忽略"
      successText="已忽略这条推荐"
      buttonProps={{ size: 'small' }}
      onSubmit={values => mutation.mutateAsync({ reason: String(values.reason ?? '') })}
    />
  )
}

const STATUS_TAG: Record<AdsRecommendationRow['status'], { text: string; color: string }> = {
  NEW: { text: '待处理', color: 'processing' },
  ADOPTED: { text: '已采纳', color: 'success' },
  IGNORED: { text: '已忽略', color: 'default' },
  EXPIRED: { text: '已过期', color: 'default' },
}

export function AdviceTab({ id, currency }: { id: string; currency: string }) {
  const forecast = useApiQuery<AdsCampaignForecastResponse>({ domain: 'analytics', path: base(id, 'forecast'), scoped: false })
  const recommendations = useApiQuery<AdsCampaignRecommendationsResponse>({ domain: 'analytics', path: base(id, 'recommendations'), scoped: false })
  const rec = recommendations.data
  const columns: ColumnsType<AdsRecommendationRow> = [
    { title: '推荐类型', dataIndex: 'type', width: 160 },
    { title: '说明', dataIndex: 'summary', render: (value: string | null) => value ?? <Muted>推荐原文没有说明文字</Muted> },
    { title: '建议预算', dataIndex: 'suggestedBudget', width: 110, align: 'right', render: (value: number | null) => moneyCell(value, currency) },
    { title: '建议竞价', dataIndex: 'suggestedBid', width: 110, align: 'right', render: (value: number | null) => moneyCell(value, currency) },
    { title: '收到时间', dataIndex: 'receivedAt', width: 150, render: (value: string) => formatDateTime(value) },
    {
      title: '状态',
      key: 'status',
      width: 170,
      render: (_value, row) => (
        <div>
          <Tag color={STATUS_TAG[row.status].color} bordered={false}>
            {STATUS_TAG[row.status].text}
          </Tag>
          {row.decidedAt ? (
            <Muted>
              {row.decidedByName ?? ''} {formatDateTime(row.decidedAt)}
            </Muted>
          ) : null}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_value, row) =>
        row.status === 'NEW' ? (
          <Space size={4}>
            <Tooltip title={rec?.write.note}>
              <span>
                <Button size="small" disabled>
                  采纳
                </Button>
              </span>
            </Tooltip>
            {rec?.canDismiss ? <DismissButton recommendationId={row.id} /> : null}
          </Space>
        ) : null,
    },
  ]
  return (
    <div data-testid="campaign-advice">
      <Card size="small" title="官方推荐" style={{ marginBottom: 12 }}>
        <SimpleGrid<AdsRecommendationRow>
          gridId="advertising.ads-campaign-tabs-more"
          columns={columns}
          rows={rec?.items}
          rowKey={row => row.id}
          loading={recommendations.isFetching}
          error={recommendations.error}
          onRetry={() => void recommendations.refetch()}
          emptyState={{ kind: 'empty', domain: '官方推荐', prerequisite: rec?.note ?? '亚马逊没有给这个活动推荐。' }}
        />
      </Card>
      <Card
        size="small"
        title="预算预测"
        extra={
          <Tooltip title={forecast.data?.request.note}>
            <span>
              <Button size="small" disabled>
                请求预测
              </Button>
            </span>
          </Tooltip>
        }
      >
        {forecast.data ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {forecast.data.basis}
          </Typography.Paragraph>
        ) : null}
        {forecast.data && forecast.data.items.length === 0 ? <TabNote state={forecast.data.state} note={forecast.data.note} /> : null}
        {forecast.data?.items.map(item => (
          <Descriptions
            key={item.id}
            size="small"
            bordered
            column={{ xs: 1, md: 3 }}
            style={{ marginBottom: 8 }}
            title={`${formatDateTime(item.requestedAt)} · 假设日预算 ${formatMoney(item.requestedBudget, item.currency, { digits: 2 })}`}
          >
            {item.fields.map(field => (
              <Descriptions.Item key={field.path} label={field.path}>
                {field.value}
              </Descriptions.Item>
            ))}
          </Descriptions>
        ))}
      </Card>
    </div>
  )
}

// ---- 操作记录 ----

const changeColumns: ColumnsType<AdsCampaignChangeRow> = [
  { title: '时间', dataIndex: 'occurredAt', width: 150, render: (value: string) => formatDateTime(value) },
  { title: '类型', dataIndex: 'kindLabel', width: 120 },
  { title: '内容', dataIndex: 'title' },
  { title: '操作人', dataIndex: 'actor', width: 120 },
  { title: '改前', dataIndex: 'before', render: (value: string | null) => value ?? <Muted>—</Muted> },
  { title: '改后', dataIndex: 'after', render: (value: string | null) => value ?? <Muted>—</Muted> },
]

export function ChangesTab({ id, path, subject = '活动' }: { id: string; path?: string; subject?: string }) {
  const query = useApiQuery<AdsCampaignChangesResponse>({ domain: 'analytics', path: path ?? base(id, 'changes'), scoped: false })
  const data = query.data
  return (
    <div data-testid="campaign-changes">
      {data ? <TabNote state={data.amazonSide.state} note={data.amazonSide.note} /> : null}
      <SimpleGrid<AdsCampaignChangeRow>
        gridId="advertising.ads-campaign-tabs-more-2"
        columns={changeColumns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '操作记录', prerequisite: data?.note ?? `本系统内还没有对这个${subject}做过改动。` }}
      />
      {data?.truncated ? <Muted>只显示最近 200 条。</Muted> : null}
    </div>
  )
}
