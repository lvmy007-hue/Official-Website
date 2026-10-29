import type { EChartsOption } from 'echarts'
import type { AdsPortfolioCurvePoint } from '@nova/api-contracts'

// 预算节奏图的 ECharts 配置（P3-11）：横轴是预算周期内每一天，两条累计线——理想累计（虚线）与实际累计（实线，只画到昨天）。
// 空值是 null：没有预算上限就没有理想线，没有逐日汇总就没有实际线，不画成 0。

const money = (value: number | null | undefined) => (value === null || value === undefined ? '尚无记录' : `$${value.toFixed(2)}`)

export function paceChartOption(curve: readonly AdsPortfolioCurvePoint[], cap: number | null, today: string): EChartsOption {
  const todayIndex = curve.findIndex(point => point.date === today)
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: value => (typeof value === 'number' ? money(value) : '尚无记录'),
    },
    legend: { data: ['理想累计', '实际累计'] },
    grid: { left: 56, right: 24, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: curve.map(point => point.date.slice(5)), boundaryGap: false },
    yAxis: { type: 'value', name: '美元' },
    series: [
      {
        name: '理想累计',
        type: 'line',
        data: curve.map(point => point.ideal),
        showSymbol: false,
        lineStyle: { type: 'dashed' },
        markLine: cap === null ? undefined : { silent: true, symbol: 'none', data: [{ yAxis: cap, label: { formatter: `预算上限 ${money(cap)}` } }] },
      },
      {
        name: '实际累计',
        type: 'line',
        data: curve.map(point => point.actual),
        showSymbol: false,
        connectNulls: false,
        markLine: todayIndex < 0 ? undefined : { silent: true, symbol: 'none', data: [{ xAxis: todayIndex, label: { formatter: '今天' } }] },
      },
    ],
  }
}
