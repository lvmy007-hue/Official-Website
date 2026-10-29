import type { EChartsOption } from 'echarts'
import { ADS_QUADRANT_LABEL, type AdsQuadrant, type AdsTrendPointDay, type AdTermQuadrantResponse } from '@nova/api-contracts'
import { escapeHtml } from '../../components/chart/chart-utils'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// 词级中心的图表配置（纯函数，P3-10）。没有数据的点保持为空（图上断开或没有柱子），不补成 0。

const money = (value: unknown) => formatMoney(Number(value), 'USD', { digits: 2 })
const axisMoney = (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true })

const QUADRANT_COLOR: Record<AdsQuadrant, string> = { STAR: '#2f9e44', WASTE: '#e03131', POTENTIAL: '#1c7ed6', LOW: '#868e96' }

/** 四象限：横轴花费、纵轴广告成本销售比；分界线是各点的平均花费与整体广告成本销售比。 */
export function buildTermQuadrantOption(data: Pick<AdTermQuadrantResponse, 'points' | 'spendLine' | 'acosLine'>): EChartsOption {
  const lines = [...(data.spendLine !== null ? [{ xAxis: data.spendLine }] : []), ...(data.acosLine !== null ? [{ yAxis: data.acosLine }] : [])]
  return {
    tooltip: {
      trigger: 'item',
      formatter: params => {
        const point = (params as { data?: { name?: string; value?: number[]; quadrant?: AdsQuadrant } }).data
        if (!point?.value || !point.quadrant) return ''
        return `${escapeHtml(point.name)}<br/>花费 ${money(point.value[0])}<br/>广告成本销售比 ${formatPercent(point.value[1] ?? 0, { digits: 1 })}<br/>${ADS_QUADRANT_LABEL[point.quadrant]}`
      },
    },
    grid: { left: 64, right: 24, top: 24, bottom: 36 },
    xAxis: { type: 'value', name: '花费', axisLabel: { formatter: axisMoney } },
    yAxis: { type: 'value', name: '广告成本销售比', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) } },
    series: [
      {
        type: 'scatter',
        symbolSize: 10,
        data: data.points.map(point => ({ name: point.name, value: [point.spend, point.acos], quadrant: point.quadrant, itemStyle: { color: QUADRANT_COLOR[point.quadrant] } })),
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed' }, label: { show: false }, data: lines },
      },
    ],
  }
}

/** 一个词的逐日趋势：花费（柱）、广告销售额与点击（线，点击在右轴）。 */
export function buildTermTrendOption(points: readonly AdsTrendPointDay[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 48, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: [
      { type: 'value', name: '金额', axisLabel: { formatter: axisMoney } },
      { type: 'value', name: '点击', splitLine: { show: false }, axisLabel: { formatter: (value: number) => formatNumber(value, { digits: 0 }) } },
    ],
    series: [
      { name: '花费', type: 'bar', data: points.map(point => point.spend), tooltip: { valueFormatter: money } },
      { name: '广告销售额', type: 'line', data: points.map(point => point.sales), connectNulls: false, showSymbol: false, tooltip: { valueFormatter: money } },
      { name: '点击', type: 'line', yAxisIndex: 1, data: points.map(point => point.clicks), connectNulls: false, showSymbol: false },
    ],
  }
}
