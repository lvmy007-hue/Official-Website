import type { EChartsOption } from 'echarts'
import type { Asin360AdsDailyPoint } from '@nova/api-contracts'
import { formatMoney, formatPercent } from '../../format'

// ASIN 360 广告页签的趋势图配置（纯函数）：广告花费柱（左轴，美元）加广告成本销售比与广告占总销售比两条线（右轴）。
// 没有记录的日子是 null，柱不画、线断开，不补 0；提示里写“尚无记录”。

const NONE = '尚无记录'
const money = (value: unknown) => (value === null || value === undefined ? NONE : formatMoney(Number(value), 'USD', { digits: 2 }))
const percent = (value: unknown) => (value === null || value === undefined ? NONE : formatPercent(Number(value), { digits: 1 }))

export function hasTrendData(points: readonly Asin360AdsDailyPoint[]): boolean {
  return points.some(point => point.spend !== null || point.adsShare !== null || point.acos !== null)
}

export function buildAdsTrendOption(points: readonly Asin360AdsDailyPoint[]): EChartsOption {
  const show = points.length <= 45
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: [
      { type: 'value', name: '花费（美元）', axisLabel: { formatter: (value: number) => formatMoney(value, 'USD', { digits: 0 }) } },
      { type: 'value', name: '占比', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) }, splitLine: { show: false } },
    ],
    series: [
      { name: '广告花费', type: 'bar', data: points.map(point => point.spend), itemStyle: { opacity: 0.55 }, tooltip: { valueFormatter: money } },
      { name: '广告成本销售比', type: 'line', yAxisIndex: 1, data: points.map(point => point.acos), connectNulls: false, showSymbol: show, tooltip: { valueFormatter: percent } },
      { name: '广告占总销售比', type: 'line', yAxisIndex: 1, data: points.map(point => point.adsShare), connectNulls: false, showSymbol: show, tooltip: { valueFormatter: percent } },
    ],
  }
}
