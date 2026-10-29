import { useMemo } from 'react'
import { Alert, Button, Empty, List, Space, Tag, Typography } from 'antd'
import type { EChartsOption } from 'echarts'
import type { TodayAnomaly, TodayEventsResponse, TodayHourlyResponse, TodaySummaryResponse } from '@nova/api-contracts'
import { DataState, PageHeader, stateFromError, SimpleGrid } from '../../components'
import { ErpChart } from '../../components/chart/ErpChart'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'

// 今日实时（P2a-03，04 章 4.2）：小时推送监控；接收端未配置时正式“未接入”并退化日终。
// 本页路由懒加载；图表进入可视区才加载 ECharts。一键生成待办复用 POST /work-items。

const STATE_TAG: Record<string, { color: string; text: string }> = {
  LIVE: { color: 'success', text: '实时估算' },
  NOT_CONNECTED: { color: 'default', text: '实时数据未接入' },
  NO_DATA: { color: 'warning', text: '今日尚无推送' },
}

function Totals({ data }: { data: TodaySummaryResponse }) {
  const t = data.totals
  const empty = t.units == null && t.salesAmount == null
  return (
    <section data-testid="today-totals" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>今日累计</Typography.Title>
      {empty ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无记录" />
      ) : (
        <Space size={24} wrap>
          <div>
            <Typography.Text type="secondary">件数</Typography.Text>
            <div>{t.units == null ? '—' : formatNumber(t.units)}</div>
          </div>
          <div>
            <Typography.Text type="secondary">销售额</Typography.Text>
            <div>{t.salesAmount == null ? '—' : formatMoney(t.salesAmount, data.currency)}</div>
          </div>
          {data.compare.yesterdaySameHour ? (
            <Typography.Text type="secondary">
              对比{data.compare.yesterdaySameHour.label}：{formatNumber(data.compare.yesterdaySameHour.units)} 件 / {formatMoney(data.compare.yesterdaySameHour.salesAmount, data.currency)}
            </Typography.Text>
          ) : null}
          {data.compare.lastWeekSameHour ? (
            <Typography.Text type="secondary">
              对比{data.compare.lastWeekSameHour.label}：{formatNumber(data.compare.lastWeekSameHour.units)} 件 / {formatMoney(data.compare.lastWeekSameHour.salesAmount, data.currency)}
            </Typography.Text>
          ) : null}
          {data.asOf ? <Typography.Text type="secondary">截至 {formatDateTime(data.asOf)}</Typography.Text> : null}
        </Space>
      )}
      {data.dailyFallback ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          日终退化：{data.dailyFallback.summaryDate}，{formatNumber(data.dailyFallback.units)} 件 / {formatMoney(data.dailyFallback.salesAmount, data.currency)}
          {data.dailyFallback.refreshedAt ? `（汇总刷新于 ${formatDateTime(data.dailyFallback.refreshedAt)}）` : ''}
        </Typography.Paragraph>
      ) : null}
    </section>
  )
}

function buildHourlyOption(data: TodayHourlyResponse): EChartsOption {
  const hours = data.hours.map(h => `${h.hourStart.slice(11, 13)}时`)
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['销售件数', '详情页浏览', '历史区间'] },
    xAxis: { type: 'category', data: hours },
    yAxis: [
      { type: 'value', name: '件数' },
      { type: 'value', name: '浏览' },
    ],
    series: [
      { name: '销售件数', type: 'bar', data: data.hours.map(h => h.units) },
      { name: '详情页浏览', type: 'line', yAxisIndex: 1, data: data.hours.map(h => h.pageViews) },
      {
        name: '历史区间',
        type: 'line',
        data: data.hours.map(h => h.band?.unitsMax ?? null),
        lineStyle: { type: 'dashed', opacity: 0.5 },
        areaStyle: { opacity: 0.08 },
      },
    ],
  }
}

function HourlyChart({ data }: { data: TodayHourlyResponse }) {
  const option = useMemo(() => buildHourlyOption(data), [data])
  if (data.realtimeState !== 'LIVE') {
    return (
      <section data-testid="today-hourly" style={{ marginBottom: 16 }}>
        <Typography.Title level={5}>小时曲线</Typography.Title>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={data.realtimeState === 'NOT_CONNECTED' ? '实时数据未接入' : '尚无记录'} />
      </section>
    )
  }
  return (
    <section data-testid="today-hourly" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>小时曲线</Typography.Title>
      <ErpChart option={option} height={280} ariaLabel="今日小时销售与流量" />
    </section>
  )
}

function Anomalies({ items }: { items: TodayAnomaly[] }) {
  const { canPermission } = useSession()
  const create = useApiMutation<Record<string, unknown>, unknown>({ method: 'POST', path: '/work-items', invalidate: ['realtime'], silent: true })
  if (!items.length) return null
  return (
    <section data-testid="today-anomalies" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>小时级异常</Typography.Title>
      <SimpleGrid
        gridId="today.today-page"
        columns={[
          { title: 'ASIN', dataIndex: 'asin', width: 120 },
          { title: '指标', dataIndex: 'metric', width: 80, render: (v: string) => (v === 'sales' ? '销售' : '流量') },
          { title: '说明', dataIndex: 'title' },
          {
            title: '操作',
            key: 'act',
            width: 140,
            render: (_, row) => (
              <Button
                size="small"
                disabled={!canPermission('workitem.assign') || create.isPending}
                onClick={() =>
                  void create.mutateAsync({
                    title: row.title,
                    detail: `小时 ${row.hourStart}，值 ${row.value}，历史下限 ${row.bandMin}`,
                    severity: 'WARNING',
                    entityType: 'ASIN',
                    entityId: row.asin,
                    entityLabel: row.asin,
                    suggestedAction: row.suggestedAction,
                  })
                }
              >
                生成待办
              </Button>
            ),
          },
        ]}
        rows={items}
        rowKey={row => `${row.asin}-${row.hourStart}-${row.metric}`}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </section>
  )
}

export default function TodayPage() {
  const summary = useApiQuery<TodaySummaryResponse>({ domain: 'realtime', path: '/today/summary' })
  const hourly = useApiQuery<TodayHourlyResponse>({ domain: 'realtime', path: '/today/hourly' })
  const events = useApiQuery<TodayEventsResponse>({ domain: 'realtime', path: '/today/events', scoped: false })
  const tag = summary.data ? (STATE_TAG[summary.data.realtimeState] ?? STATE_TAG.NOT_CONNECTED) : null
  const refreshAll = () => void Promise.all([summary.refetch(), hourly.refetch(), events.refetch()])
  // 汇总请求失败或还在加载时，不能显示“未接入”“尚无记录”：那会把请求失败伪装成业务状态（11.6 第 4 条）
  const blocked = summary.error ? <DataState {...stateFromError(describeError(summary.error), { onRetry: () => void summary.refetch() })} /> : summary.isPending ? <DataState kind="skeleton" /> : null
  // 小时曲线与事件流是独立请求，单独失败时给局部失败提示，汇总部分照常显示
  const failed = [...(hourly.error ? [{ domain: '小时曲线与小时级异常', impact: '这两块暂时无法显示' }] : []), ...(events.error ? [{ domain: '事件流', impact: '事件流暂时无法显示' }] : [])]

  return (
    <div data-testid="today-page">
      <PageHeader
        title="今日实时"
        actions={
          <Space>
            {tag ? <Tag color={tag.color}>{tag.text}</Tag> : null}
            <Button size="small" onClick={refreshAll}>
              刷新
            </Button>
          </Space>
        }
      />
      {blocked ?? (summary.data ? <TodayBody summary={summary.data} hourly={hourly} events={events} failed={failed} onRetry={refreshAll} /> : null)}
    </div>
  )
}

type QueryLike<T> = { data?: T; error: unknown }
type TodayBodyProps = {
  summary: TodaySummaryResponse
  hourly: QueryLike<TodayHourlyResponse>
  events: QueryLike<TodayEventsResponse>
  failed: Array<{ domain: string; impact: string }>
  onRetry: () => void
}

function TodayBody({ summary, hourly, events, failed, onRetry }: TodayBodyProps) {
  return (
    <>
      {failed.length > 0 ? <DataState kind="partial-failure" failed={failed} onRetry={onRetry} /> : null}
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={summary.estimateNote ?? '实时估算，以日终数据为准'} />
      {summary.realtimeState === 'NOT_CONNECTED' ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="实时数据未接入" description={summary.note} data-testid="today-not-connected" />
      ) : null}
      <Totals data={summary} />
      {hourly.data ? <HourlyChart data={hourly.data} /> : null}
      {hourly.data ? <Anomalies items={hourly.data.anomalies} /> : null}
      <section data-testid="today-inventory" style={{ marginBottom: 16 }}>
        <Typography.Title level={5}>库存实时</Typography.Title>
        {summary.inventory.state === 'NOT_CONNECTED' || summary.inventory.state === 'NO_DATA' ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={summary.inventory.note ?? '尚无记录'} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>断货中：{summary.inventory.outOfStock.map(r => r.asin).join('、') || '无'}</Typography.Text>
            <Typography.Text>
              预计今日断货：
              {summary.inventory.predictedStockout.map(r => `${r.asin}（约 ${formatDateTime(r.predictedAtHour)}）`).join('、') || '无'}
            </Typography.Text>
          </Space>
        )}
      </section>
      <section data-testid="today-ads" style={{ marginBottom: 16 }}>
        <Typography.Title level={5}>今日广告</Typography.Title>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={summary.ads.note ?? '尚未接入'} />
      </section>
      <section data-testid="today-events">
        <Typography.Title level={5}>事件流</Typography.Title>
        {events.error ? (
          <Typography.Text type="secondary">事件流暂时无法显示，请稍后重试</Typography.Text>
        ) : events.data?.items.length ? (
          <List
            size="small"
            dataSource={events.data.items}
            renderItem={item => (
              <List.Item>
                <List.Item.Meta title={item.title} description={`${formatDateTime(item.occurredAt)} · ${item.kind}`} />
              </List.Item>
            )}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无记录" />
        )}
      </section>
    </>
  )
}
