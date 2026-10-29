import { useMemo, useState } from 'react'
import { Alert, Button, Card, Descriptions, Select, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_METRICS_DIMENSION_LABEL, ADS_METRICS_INFO, ADS_METRICS_LIMITS, metricsCsv, type AdsMetricsKey, type AdsMetricsResponse, type AdsMetricsRow } from '@nova/api-contracts'
import { ChartPanel, PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { MetricsControls } from './ads-metrics-controls'
import { chartOption, metricText, planChart } from './ads-metrics-format'
import { initialState, LIMIT_TEXT, paramsOf, sortStillValid, type MetricsState } from './ads-metrics-state'

// 广告指标（P3-15，08 章 8.13）：在已经入库的数据集里自由组合维度与指标，看合计、表格、趋势与多对象对比，可导出当前页。
// 数据集里没有记录写“尚无记录”（要先到“广告报表”创建任务），空值写“—”不当 0，不同币种不相加（只看美元，非美元行数单独告知）。图表与导出只含当前页的行。

function columnsOf(data: AdsMetricsResponse): ColumnsType<AdsMetricsRow> {
  const dimensions: ColumnsType<AdsMetricsRow> = data.dimensions.map(key => ({
    title: ADS_METRICS_DIMENSION_LABEL[key],
    key,
    width: 180,
    render: (_value, row) => (key === 'campaign' && row.link ? <AppLink to={row.link}>{row.dims[key]}</AppLink> : (row.dims[key] ?? <Muted>—</Muted>)),
  }))
  const metrics: ColumnsType<AdsMetricsRow> = data.metrics.map(key => ({
    title: ADS_METRICS_INFO[key].label,
    key,
    width: 130,
    align: 'right',
    render: (_value, row) => <span className="erp-num">{metricText(key, row.values[key])}</span>,
  }))
  return [...dimensions, ...metrics]
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function Totals({ data }: { data: AdsMetricsResponse }) {
  return (
    <Descriptions size="small" bordered column={{ xs: 2, md: 3, xl: 6 }} style={{ marginBottom: 8 }} data-testid="ads-metrics-totals" title="合计（全部分组，不受翻页影响）">
      {data.metrics.map(key => (
        <Descriptions.Item key={key} label={ADS_METRICS_INFO[key].label}>
          <span className="erp-num">{data.state === 'NO_DATA' ? '尚无记录' : metricText(key, data.totals[key])}</span>
        </Descriptions.Item>
      ))}
    </Descriptions>
  )
}

export default function AdsMetricsPage() {
  const [state, setState] = useState<MetricsState>(() => initialState())
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [selected, setSelected] = useState<string[]>([])
  const [chartMetric, setChartMetric] = useState<AdsMetricsKey>()
  const change = (next: MetricsState) => {
    setState(sortStillValid(next) ? next : { ...next, sortField: undefined })
    setStack([undefined])
    setSelected([])
  }
  const query = useApiQuery<AdsMetricsResponse>({
    domain: 'analytics',
    path: '/ads/metrics',
    params: { ...paramsOf(state), cursor: stack[stack.length - 1] },
    enabled: state.metrics.length > 0,
  })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const shownMetric = chartMetric && data?.metrics.includes(chartMetric) ? chartMetric : data?.metrics[0]
  const plan = useMemo(() => (data && shownMetric ? planChart(data.items, data.dimensions, shownMetric, selected) : null), [data, shownMetric, selected])
  const hasTime = data?.dimensions.some(key => key === 'date' || key === 'hour') ?? false

  return (
    <div data-testid="ads-metrics-page">
      <PageHeader title="广告指标" description="在已导入的广告数据里自由组合维度与指标：看合计、明细、趋势与对象对比。数据来自“广告报表”里的报告任务。" />
      <Card size="small">
        <MetricsControls state={state} profiles={data?.profiles ?? []} onChange={change} />
        <Muted>{LIMIT_TEXT}。日期维度可切换日、周、月；金额只看美元。</Muted>
        {state.metrics.length === 0 ? <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="至少选一个指标" data-testid="ads-metrics-need-metric" /> : null}
        {data?.defaulted ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择日期范围，当前显示 ${data.period.from} 至 ${data.period.to}`} /> : null}
        {data?.note ? (
          <Alert
            type={data.state === 'OK' ? 'warning' : 'info'}
            showIcon
            style={{ margin: '8px 0' }}
            message={data.state === 'OK' ? '提示' : '尚无记录'}
            description={data.note}
            data-testid="ads-metrics-note"
          />
        ) : null}
        {data && data.otherCurrencyRows > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ margin: '8px 0' }}
            data-testid="ads-metrics-currency"
            message={`有 ${data.otherCurrencyRows} 行是非美元数据，没有计入下面的合计与明细（不同币种不相加）`}
          />
        ) : null}
        {data?.truncated ? (
          <Alert type="warning" showIcon style={{ margin: '8px 0' }} data-testid="ads-metrics-truncated" message="分组太多，只读取了一部分：合计与排序只覆盖已读到的分组，请缩小日期范围或增加筛选" />
        ) : null}
        {data ? <Totals data={data} /> : null}
        {data && data.state === 'OK' ? (
          <ChartPanel
            title={hasTime ? '趋势' : '对象对比'}
            ariaLabel={hasTime ? '广告指标趋势' : '广告指标对象对比'}
            option={plan && shownMetric ? chartOption(plan, shownMetric) : {}}
            emptyState={plan ? undefined : { kind: 'empty', domain: '图表', prerequisite: '当前结果没有可画的数据' }}
            extra={
              <Select
                size="small"
                style={{ width: 150 }}
                aria-label="图表指标"
                value={shownMetric}
                options={data.metrics.map(key => ({ value: key, label: ADS_METRICS_INFO[key].label }))}
                onChange={setChartMetric}
              />
            }
          />
        ) : null}
        <div style={{ margin: '8px 0' }}>
          <Space>
            <Button disabled={!data || data.items.length === 0} onClick={() => data && download('广告指标.csv', metricsCsv(data.items, data.dimensions, data.metrics))}>
              导出当前页
            </Button>
            <Muted>{hasTime ? '图表按当前页的行绘制' : `勾选最多 ${ADS_METRICS_LIMITS.compareMax} 行可在图表里对比（不勾选显示前 10 行）；图表按当前页的行绘制`}</Muted>
          </Space>
        </div>
        <SimpleGrid<AdsMetricsRow>
          columns={data ? columnsOf(data) : []}
          rows={data?.items}
          rowKey={row => row.key}
          loading={query.isFetching}
          error={query.error}
          onRetry={() => void query.refetch()}
          gridId="ads-metrics"
          resetKey={`${stack.length}|${JSON.stringify(paramsOf(state))}`}
          onSelectionChange={hasTime ? undefined : rows => setSelected(rows.map(row => row.key).slice(0, ADS_METRICS_LIMITS.compareMax))}
          emptyState={{ kind: 'empty', domain: '广告指标', prerequisite: data?.note ?? '所选范围内尚无记录。' }}
        />
        <Space style={{ marginTop: 8 }}>
          <Button disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
            上一页
          </Button>
          <Button disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
            下一页
          </Button>
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>
            第 {stack.length} 页{data ? `，共 ${data.groupCount} 组` : ''}
          </span>
        </Space>
      </Card>
    </div>
  )
}
