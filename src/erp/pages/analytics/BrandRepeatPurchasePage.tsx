import { useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { Alert, Card, Col, Input, Row, Segmented, Select, Space } from 'antd'
import { BA_REPEAT_SORT_LABEL, BA_REPEAT_SORTS, type BaDimension, type BaRepeatResponse, type BaRepeatRow, type BaRepeatTrendPoint } from '@nova/api-contracts'
import { ChartPanel, LocalGrid, PageHeader, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { changeColor, changeText, countText, moneyText, percentText } from './brand-options'
import { BrandFrame, useBrandPeriod } from './brand-ui'
import { Pager, StatCard } from './business-reports-ui'

// 品牌分析·重复购买（P4-04，04 章 4.7）：按 ASIN 或品牌看订单数、独立买家数、复购买家占比、复购销售额与占比，以及逐期趋势。
// 官方只给“复购买家占比”（不是复购订单占比），页面上照此命名；汇总的占比按独立买家数加权；非美元的复购销售额不相加，写“尚无记录”。

const PAGE_SIZE = 20

function trendOption(points: readonly BaRepeatTrendPoint[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 64, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: points.map(point => point.periodStart) },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (value: number) => percentText(value, 0) } },
      { type: 'value', splitLine: { show: false } },
    ],
    series: [
      {
        name: '复购买家占比',
        type: 'line',
        connectNulls: false,
        itemStyle: { color: '#4c6ef5' },
        data: points.map(point => point.repeatCustomersPct),
        tooltip: { valueFormatter: (value: unknown) => percentText(typeof value === 'number' ? value : null, 2) },
      },
      {
        name: '复购销售额',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 18,
        itemStyle: { color: 'rgba(18,184,134,0.45)' },
        data: points.map(point => point.repeatRevenue),
        tooltip: { valueFormatter: (value: unknown) => moneyText(typeof value === 'number' ? value : null) },
      },
    ],
  }
}

const columns = (dimension: BaDimension): ErpColDef<BaRepeatRow>[] => [
  renderColumn<BaRepeatRow>(
    dimension === 'ASIN' ? '商品' : '品牌',
    'label',
    row => (
      <span>
        <b>{row.label}</b> <Muted>{dimension === 'ASIN' ? (row.title ?? '目录里没有这个 ASIN') : `${row.asins} 个 ASIN`}</Muted>
      </span>
    ),
    { width: 340, pin: 'left' },
  ),
  renderColumn<BaRepeatRow>('订单数', 'orders', row => countText(row.orders), { width: 110, ...RIGHT_ALIGNED }),
  renderColumn<BaRepeatRow>('独立买家', 'uniqueCustomers', row => countText(row.uniqueCustomers), { width: 120, ...RIGHT_ALIGNED }),
  renderColumn<BaRepeatRow>('复购买家占比', 'repeatCustomersPct', row => <span className="erp-num">{percentText(row.repeatCustomersPct, 2)}</span>, { width: 140, ...RIGHT_ALIGNED }),
  renderColumn<BaRepeatRow>('较上一周期', 'change', row => <span style={{ color: changeColor(row.repeatCustomersChange) }}>{changeText(row.repeatCustomersChange)}</span>, {
    width: 150,
    ...RIGHT_ALIGNED,
  }),
  renderColumn<BaRepeatRow>('复购销售额', 'repeatRevenue', row => moneyText(row.repeatRevenue), { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaRepeatRow>('复购销售额占比', 'repeatRevenuePct', row => percentText(row.repeatRevenuePct, 2), { width: 150, ...RIGHT_ALIGNED }),
]
export default function BrandRepeatPurchasePage() {
  const [dimension, setDimension] = useState<BaDimension>('ASIN')
  const [text, setText] = useState('')
  const [keyword, setKeyword] = useState<string | undefined>()
  const [sort, setSort] = useState<(typeof BA_REPEAT_SORTS)[number]>('repeatRevenue')
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const period = useBrandPeriod(reset)
  const query = useApiQuery<BaRepeatResponse>({
    domain: 'analytics',
    path: '/analytics/brand/repeat-purchase',
    params: { ...period.params, dimension, q: keyword, sort: `${sort}:desc`, pageSize: PAGE_SIZE, cursor: stack[stack.length - 1] },
  })
  const gridColumns = useMemo(() => columns(dimension), [dimension])
  const option = useMemo(() => trendOption(query.data?.trend ?? []), [query.data?.trend])
  return (
    <div>
      <PageHeader title="重复购买" description="看买家回头买了多少：独立买家里有多少人复购、复购带来多少销售额。数据来自亚马逊品牌分析。" />
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Segmented
            aria-label="分析维度"
            value={dimension}
            options={[
              { value: 'ASIN', label: '按 ASIN' },
              { value: 'BRAND', label: '按品牌' },
            ]}
            onChange={value => {
              setDimension(value as BaDimension)
              reset()
            }}
          />
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索 ASIN、标题或品牌"
            aria-label="搜索"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setKeyword(value.trim() || undefined)
              reset()
            }}
          />
          <Select
            style={{ width: 190 }}
            aria-label="排序"
            value={sort}
            options={BA_REPEAT_SORTS.map(value => ({ value, label: `按${BA_REPEAT_SORT_LABEL[value]}` }))}
            onChange={value => {
              setSort(value)
              reset()
            }}
          />
        </Space>
      </Card>
      <BrandFrame query={query} period={period} testId="ba-repeat">
        {data => (
          <>
            <Row gutter={8} data-testid="ba-repeat-summary">
              <Col xs={12} md={6}>
                <StatCard title="复购买家占比">{percentText(data.summary.repeatCustomersPct, 2)}</StatCard>
              </Col>
              <Col xs={12} md={6}>
                <StatCard title="复购销售额">{moneyText(data.summary.repeatRevenue)}</StatCard>
              </Col>
              <Col xs={12} md={6}>
                <StatCard title="独立买家">{countText(data.summary.uniqueCustomers)}</StatCard>
              </Col>
              <Col xs={12} md={6}>
                <StatCard title="订单数">{countText(data.summary.orders)}</StatCard>
              </Col>
            </Row>
            <Alert type="info" showIcon style={{ margin: '8px 0' }} message={data.repeatNote} data-testid="ba-repeat-note" />
            <ChartPanel
              title="逐期复购"
              ariaLabel="重复购买逐期趋势图"
              option={option}
              height={240}
              emptyState={data.trend.length === 0 ? { kind: 'empty', domain: '逐期复购', prerequisite: '所选范围内没有可画趋势的数据。' } : undefined}
            />
            <Card size="small" title={dimension === 'ASIN' ? '按 ASIN' : '按品牌'} style={{ marginTop: 8 }} data-testid="ba-repeat-table">
              <LocalGrid<BaRepeatRow>
                gridId={`analytics.brand.repeat-purchase.${dimension.toLowerCase()}`}
                columns={gridColumns}
                rows={data.items}
                getRowId={row => row.key}
                initialPageSize={20}
                height={520}
                emptyState={{ kind: 'empty', domain: '重复购买', prerequisite: data.note ?? '所选周期内没有重复购买数据。' }}
              />
              <Pager stack={stack} setStack={setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
            </Card>
          </>
        )}
      </BrandFrame>
    </div>
  )
}
