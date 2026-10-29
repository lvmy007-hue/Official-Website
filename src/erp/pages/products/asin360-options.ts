import type { EChartsOption, SeriesOption } from 'echarts'
import type { Asin360OverviewResponse, Asin360UnitEconomics, ProfitBridgeView } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// ASIN 360 经营表现图表配置（纯函数）：销售额线、对比期虚线、件数柱（第二轴）、净利润线（有权限且已接入时）。
// 没有记录的对比日保持为空（图上断开），不补成 0。

export function buildSalesOption(data: Asin360OverviewResponse): EChartsOption {
  const currency = data.currency
  const money = (value: unknown) => formatMoney(Number(value), currency, { digits: 2 })
  const series: SeriesOption[] = [
    { name: '销售额', type: 'line', data: data.daily.map(point => point.sales), showSymbol: data.daily.length <= 45, tooltip: { valueFormatter: money } },
    {
      name: '销售件数',
      type: 'bar',
      yAxisIndex: 1,
      data: data.daily.map(point => point.units),
      itemStyle: { opacity: 0.35 },
      tooltip: { valueFormatter: value => formatNumber(Number(value), { digits: 0 }) },
    },
  ]
  if (data.compare && data.compareSales.length) {
    series.push({ name: '对比期销售额', type: 'line', data: data.compareSales, connectNulls: false, showSymbol: false, lineStyle: { type: 'dashed' }, tooltip: { valueFormatter: money } })
  }
  if (data.profit.state === 'OK') {
    series.push({ name: '净利润', type: 'line', data: data.daily.map(point => point.profit), connectNulls: false, showSymbol: false, tooltip: { valueFormatter: money } })
  }
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 48, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: data.daily.map(point => point.date) },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (value: number) => formatMoney(value, currency, { digits: 0, compact: true }) } },
      { type: 'value', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) }, splitLine: { show: false } },
    ],
    series,
  }
}

/** 每件经济折成利润桥的形状，复用利润桥瀑布图与明细表；净利润算不出时不画终点柱（桥里 netProfit 为 null）。 */
export function unitBridgeView(unit: Asin360UnitEconomics): ProfitBridgeView {
  return {
    items: unit.lines.map(line => ({ key: line.key, label: line.label, direction: line.direction, value: line.perUnit, contribution: line.contribution, state: line.state, note: null })),
    netProfit: unit.netPerUnit,
    coveredProfit: null,
    incompleteRows: 0,
    rows: unit.units > 0 ? 1 : 0,
  }
}
