import type { EChartsOption } from 'echarts'
import type { AdsTodayHour } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// 今日广告小时曲线的图表配置（纯函数）。没有小时指标的小时、还没到的小时保持为空（图上断开），不补成 0。

const money = (value: unknown) => formatMoney(Number(value), 'USD', { digits: 2 })

/** 横轴是企业时区的第几个小时（0 时至 23 时）。 */
export const hourLabels = (items: readonly AdsTodayHour[]) => items.map((_, index) => `${index}时`)

/** 花费（柱）、点击（线，右轴）、历史同时段花费的下限与上限（虚线；同时段样本不够的小时没有）。 */
export function buildHourlyOption(items: readonly AdsTodayHour[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 48, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: hourLabels(items) },
    yAxis: [
      { type: 'value', name: '花费', axisLabel: { formatter: (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true }) } },
      { type: 'value', name: '点击', splitLine: { show: false }, axisLabel: { formatter: (value: number) => formatNumber(value, { digits: 0 }) } },
    ],
    series: [
      { name: '花费', type: 'bar', data: items.map(item => item.spend), tooltip: { valueFormatter: money } },
      { name: '点击', type: 'line', yAxisIndex: 1, data: items.map(item => item.clicks), connectNulls: false, showSymbol: false },
      {
        name: '历史同时段花费下限',
        type: 'line',
        data: items.map(item => item.band?.spendMin ?? null),
        connectNulls: false,
        showSymbol: false,
        lineStyle: { type: 'dashed', opacity: 0.5 },
        tooltip: { valueFormatter: money },
      },
      {
        name: '历史同时段花费上限',
        type: 'line',
        data: items.map(item => item.band?.spendMax ?? null),
        connectNulls: false,
        showSymbol: false,
        lineStyle: { type: 'dashed', opacity: 0.5 },
        tooltip: { valueFormatter: money },
      },
    ],
  }
}
