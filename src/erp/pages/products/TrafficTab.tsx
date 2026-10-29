import { useMemo, useState } from 'react'
import { Alert, Card, Descriptions, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  BA_BREAKPOINT_LABEL,
  BA_BREAKPOINTS,
  BA_PERIOD_LABEL,
  type Asin360CatalogFunnel,
  type Asin360CatalogMetrics,
  type Asin360CoreTerm,
  type Asin360SearchFunnel,
  type Asin360TrafficDaily,
  type Asin360TrafficResponse,
} from '@nova/api-contracts'
import { ChartPanel, SimpleGrid } from '../../components'
import { formatMoney, formatNumber } from '../../format'
import { countText, percentText } from '../analytics/brand-options'
import { FunnelPanel } from '../analytics/brand-sqp-panels'
import { Muted, StateBlock } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { PendingSections, PeriodPicker, type PeriodChoice } from './asin360-panels'
import { buildTrafficOption } from './asin360-traffic-options'

// 流量转化页签（05 章 5.2）：逐日会话与转化 → 搜索漏斗（品牌分析，含断点）→ 核心搜索词 → 目录表现（亚马逊商品目录的展示到购买）→ 没有来源的区块。
// 没有数据的指标写“尚无记录”，没有品牌权限或品牌角色缺失的区块写清原因，不显示 0。

const num = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)

function DailyBlock({ daily }: { daily: Asin360TrafficDaily }) {
  const option = useMemo(() => buildTrafficOption(daily.points), [daily.points])
  const summary = daily.summary
  const empty = daily.state !== 'OK'
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }} data-testid="asin360-traffic-daily">
      {empty ? (
        <Alert
          type={daily.state === 'RESTRICTED' ? 'warning' : 'info'}
          showIcon
          message={daily.state === 'NOT_CONNECTED' ? '尚未接入' : daily.state === 'NO_DATA' ? '尚无记录' : '无权查看'}
          description={daily.note ?? undefined}
        />
      ) : null}
      {summary ? (
        <Descriptions size="small" bordered column={{ xs: 1, md: 4 }} data-testid="asin360-traffic-summary">
          <Descriptions.Item label="会话">{num(summary.sessions)}</Descriptions.Item>
          <Descriptions.Item label="页面浏览">{num(summary.pageViews)}</Descriptions.Item>
          <Descriptions.Item label="订购件数">{num(summary.units)}</Descriptions.Item>
          <Descriptions.Item label="销售额">{summary.sales === null ? <Muted>尚无记录</Muted> : formatMoney(summary.sales, 'USD', { digits: 2 })}</Descriptions.Item>
          <Descriptions.Item label="转化率（件数 ÷ 会话）">{percentText(summary.unitSessionPct)}</Descriptions.Item>
          <Descriptions.Item label="购物车获得率">{percentText(summary.buyBoxPct)}</Descriptions.Item>
          <Descriptions.Item label="每会话页面浏览">{summary.pageViewsPerSession === null ? <Muted>尚无记录</Muted> : formatNumber(summary.pageViewsPerSession, { digits: 2 })}</Descriptions.Item>
          <Descriptions.Item label="有记录的天数">{summary.days}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {daily.truncated ? <Alert type="warning" showIcon message="逐日数据可能不完整" description="读取行数超过上限，只用了其中一部分；请缩小日期范围。" /> : null}
      <ChartPanel
        title="会话、转化率与购物车获得率"
        ariaLabel="商品流量转化趋势图"
        option={option}
        emptyState={empty ? { kind: 'empty', domain: '逐日流量', prerequisite: daily.note ?? '所选日期范围内没有这个 ASIN 的流量记录。' } : undefined}
      />
    </Space>
  )
}

const breakpointTag = (term: Asin360CoreTerm) =>
  term.breakpoint ? (
    <Tag color="orange" bordered={false}>
      {BA_BREAKPOINT_LABEL[term.breakpoint]}
    </Tag>
  ) : (
    <Muted>无</Muted>
  )

const termColumns: ColumnsType<Asin360CoreTerm> = [
  { title: '搜索词', dataIndex: 'searchQuery', key: 'query' },
  { title: '搜索量', key: 'volume', width: 90, align: 'right', render: (_value, row) => countText(row.searchVolume) },
  { title: '展示份额', key: 'impression', width: 90, align: 'right', render: (_value, row) => percentText(row.shares.impression) },
  { title: '点击份额', key: 'click', width: 90, align: 'right', render: (_value, row) => percentText(row.shares.click) },
  { title: '加购份额', key: 'cartAdd', width: 90, align: 'right', render: (_value, row) => percentText(row.shares.cartAdd) },
  { title: '购买份额', key: 'purchase', width: 90, align: 'right', render: (_value, row) => percentText(row.shares.purchase) },
  { title: '我方购买', key: 'own', width: 90, align: 'right', render: (_value, row) => countText(row.ownPurchases) },
  { title: '断点', key: 'breakpoint', width: 160, render: (_value, row) => breakpointTag(row) },
]

function SearchBlock({ funnel, choice, onChoice }: { funnel: Asin360SearchFunnel; choice: PeriodChoice; onChoice: (next: PeriodChoice) => void }) {
  const period = funnel.period
  const kind = period?.kind ?? choice.period
  return (
    <Card
      size="small"
      title="搜索漏斗与核心搜索词（品牌分析）"
      extra={<PeriodPicker value={{ period: kind, periodStart: choice.periodStart }} available={period?.available ?? []} onChange={onChoice} />}
      data-testid="asin360-traffic-search"
    >
      <StateBlock state={funnel.state} note={funnel.note}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {period ? (
            <Muted>
              {BA_PERIOD_LABEL[period.kind]}周期：{period.start}
              {period.end ? ` 至 ${period.end}` : ''}
              {period.previousStart ? `（对比 ${period.previousStart}）` : '（没有上一周期）'}
            </Muted>
          ) : null}
          {funnel.note ? <Alert type="info" showIcon message={funnel.note} /> : null}
          <FunnelPanel stages={funnel.stages} />
          <Alert
            type="info"
            showIcon
            message={
              funnel.breakpoints.state === 'INSUFFICIENT'
                ? funnel.breakpoints.note
                : `断点诊断：${BA_BREAKPOINTS.map(key => `${BA_BREAKPOINT_LABEL[key]} ${funnel.breakpoints.counts[key]} 个词`).join('，')}`
            }
            data-testid="asin360-traffic-breakpoints"
          />
          {funnel.truncated ? <Alert type="warning" showIcon message="搜索词过多，只用了读取上限内的部分词" /> : null}
          <SimpleGrid<Asin360CoreTerm>
            gridId="products.traffic-tab"
            columns={termColumns}
            rows={funnel.terms}
            rowKey={row => row.searchQuery}
            emptyState={{ kind: 'empty', domain: '核心搜索词', prerequisite: '这个周期没有这个 ASIN 的搜索词记录。' }}
          />
          <Muted>
            共 {funnel.termCount} 个搜索词，按搜索量从高到低列出前 {funnel.terms.length} 个。
          </Muted>
        </Space>
      </StateBlock>
    </Card>
  )
}

interface CatalogRow {
  key: string
  label: string
  current: string
  previous: string
}

const FUNNEL_ROWS: ReadonlyArray<{ key: keyof Asin360CatalogMetrics; label: string; kind: 'count' | 'percent' | 'money' }> = [
  { key: 'impressions', label: '展示', kind: 'count' },
  { key: 'clicks', label: '点击', kind: 'count' },
  { key: 'cartAdds', label: '加购', kind: 'count' },
  { key: 'purchases', label: '购买', kind: 'count' },
  { key: 'clickRate', label: '点击率', kind: 'percent' },
  { key: 'conversionRate', label: '转化率', kind: 'percent' },
  { key: 'searchTrafficSales', label: '搜索流量销售额', kind: 'money' },
]

function catalogRows(funnel: Asin360CatalogFunnel): CatalogRow[] {
  const show = (metrics: Asin360CatalogMetrics | null, row: (typeof FUNNEL_ROWS)[number]): string => {
    const value = metrics?.[row.key] as number | null | undefined
    if (value === null || value === undefined) return '尚无记录'
    if (row.kind === 'percent') return percentText(value)
    if (row.kind === 'money') return formatMoney(value, metrics?.currency ?? 'USD', { digits: 2 })
    return countText(value)
  }
  return FUNNEL_ROWS.map(row => ({ key: row.key, label: row.label, current: show(funnel.current, row), previous: funnel.previous ? show(funnel.previous, row) : '无上一周期' }))
}

const catalogColumns: ColumnsType<CatalogRow> = [
  { title: '指标', dataIndex: 'label', key: 'label' },
  { title: '本周期', dataIndex: 'current', key: 'current', align: 'right' },
  { title: '上一周期', dataIndex: 'previous', key: 'previous', align: 'right' },
]

function CatalogBlock({ funnel }: { funnel: Asin360CatalogFunnel }) {
  const rows = useMemo(() => catalogRows(funnel), [funnel])
  return (
    <Card size="small" title="目录表现（品牌分析“搜索目录表现”）" data-testid="asin360-traffic-catalog">
      <StateBlock state={funnel.state} note={funnel.note}>
        {funnel.period ? (
          <Muted>
            {BA_PERIOD_LABEL[funnel.period.kind]}周期：{funnel.period.start}
          </Muted>
        ) : null}
        <SimpleGrid<CatalogRow>
          gridId="products.traffic-catalog"
          columns={catalogColumns}
          rows={rows}
          rowKey={row => row.key}
          emptyState={{ kind: 'empty', domain: '目录表现', prerequisite: funnel.note ?? '没有记录。' }}
        />
      </StateBlock>
    </Card>
  )
}

function Body({ data, choice, onChoice }: { data: Asin360TrafficResponse; choice: PeriodChoice; onChoice: (next: PeriodChoice) => void }) {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Muted>
        统计范围：{data.range.from} 至 {data.range.to}
        {data.range.defaulted ? '（默认最近 30 天）' : ''}
      </Muted>
      <DailyBlock daily={data.daily} />
      <SearchBlock funnel={data.searchFunnel} choice={choice} onChoice={onChoice} />
      <CatalogBlock funnel={data.catalogFunnel} />
      <PendingSections sections={data.pending} />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function TrafficTab({ id }: { id: string }) {
  const [choice, setChoice] = useState<PeriodChoice>({ period: 'WEEK', periodStart: undefined })
  const query = useProductQuery<Asin360TrafficResponse>(id, 'traffic', { scoped: true, params: { period: choice.period, periodStart: choice.periodStart } })
  return <QueryBody query={query}>{data => <Body data={data} choice={choice} onChoice={setChoice} />}</QueryBody>
}
