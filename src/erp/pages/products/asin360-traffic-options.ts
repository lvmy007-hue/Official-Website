import type { EChartsOption } from 'echarts'
import type { Asin360PricingDay, Asin360TrafficPoint } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// ASIN 360 流量转化图表配置（纯函数）：会话柱（左轴），转化率与购物车获得率线（右轴，百分比）。没有记录的日子保持为空（图上断开），不补成 0。

export function buildTrafficOption(points: readonly Asin360TrafficPoint[]): EChartsOption {
  const percent = (value: unknown) => formatPercent(Number(value), { digits: 1 })
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) } },
      { type: 'value', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '会话',
        type: 'bar',
        data: points.map(point => point.sessions),
        itemStyle: { opacity: 0.45 },
        tooltip: { valueFormatter: value => formatNumber(Number(value), { digits: 0 }) },
      },
      { name: '转化率', type: 'line', yAxisIndex: 1, data: points.map(point => point.unitSessionPct), connectNulls: false, showSymbol: points.length <= 45, tooltip: { valueFormatter: percent } },
      { name: '购物车获得率', type: 'line', yAxisIndex: 1, data: points.map(point => point.buyBoxPct), connectNulls: false, showSymbol: false, tooltip: { valueFormatter: percent } },
    ],
  }
}

/** 价格页签图：成交均价线（左轴）与购物车获得率线（右轴）；没有件数的日子成交均价为空，不画成 0。 */
export function buildPricingOption(points: readonly Asin360PricingDay[], currency: string): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: [
      { type: 'value', scale: true, axisLabel: { formatter: (value: number) => formatMoney(value, currency, { digits: 0 }) } },
      { type: 'value', min: 0, max: 1, axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '成交均价',
        type: 'line',
        data: points.map(point => point.avgPrice),
        connectNulls: false,
        showSymbol: points.length <= 45,
        tooltip: { valueFormatter: value => formatMoney(Number(value), currency, { digits: 2 }) },
      },
      {
        name: '购物车获得率',
        type: 'line',
        yAxisIndex: 1,
        data: points.map(point => point.buyBoxPct),
        connectNulls: false,
        showSymbol: false,
        tooltip: { valueFormatter: value => formatPercent(Number(value), { digits: 1 }) },
      },
    ],
  }
}
