import type { EChartsOption } from 'echarts'
import { ADS_QUADRANT_LABEL, type AdsBudgetSection, type AdsFunnel, type AdsMixPoint, type AdsProductRow, type AdsQuadrant, type AdsQuadrantSection, type AdsTrendPoint } from '@nova/api-contracts'
import { escapeHtml } from '../../components/chart/chart-utils'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// 广告控制台的图表配置（纯函数）。没有数据的点保持为空（图上断开或没有柱子），不补成 0。

const money = (value: unknown) => formatMoney(Number(value), 'USD', { digits: 2 })
const axisMoney = (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true })

export function buildTrendOption(points: readonly AdsTrendPoint[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.key) },
    yAxis: [{ type: 'value', axisLabel: { formatter: axisMoney } }],
    series: [
      { name: '花费', type: 'bar', data: points.map(point => point.spend), tooltip: { valueFormatter: money } },
      { name: '广告销售额', type: 'line', data: points.map(point => point.sales), connectNulls: false, showSymbol: points.length <= 45, tooltip: { valueFormatter: money } },
    ],
  }
}

/** 总销售（线）= 广告销售 + 自然销售（堆叠柱），广告占总销售比在右轴。 */
export function buildMixOption(points: readonly AdsMixPoint[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 56, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.key) },
    yAxis: [
      { type: 'value', axisLabel: { formatter: axisMoney } },
      { type: 'value', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) }, splitLine: { show: false } },
    ],
    series: [
      { name: '广告销售额', type: 'bar', stack: 'sales', data: points.map(point => point.adSales), tooltip: { valueFormatter: money } },
      { name: '自然销售额', type: 'bar', stack: 'sales', data: points.map(point => point.organicSales), tooltip: { valueFormatter: money } },
      { name: '总销售额', type: 'line', data: points.map(point => point.totalSales), connectNulls: false, showSymbol: points.length <= 45, tooltip: { valueFormatter: money } },
      {
        name: '广告占总销售比',
        type: 'line',
        yAxisIndex: 1,
        data: points.map(point => point.adsShare),
        connectNulls: false,
        showSymbol: false,
        tooltip: { valueFormatter: v => formatPercent(Number(v), { digits: 1 }) },
      },
    ],
  }
}

/** 只画有花费的类型；没有的类型在表格里写“未接入”或“尚无记录”。 */
export function buildProductOption(rows: readonly AdsProductRow[]): EChartsOption {
  const data = rows.filter(row => row.state === 'OK' && row.spend !== null && row.spend > 0).map(row => ({ name: row.label, value: row.spend as number }))
  return { tooltip: { trigger: 'item', valueFormatter: money }, legend: { bottom: 0 }, series: [{ name: '花费', type: 'pie', radius: ['40%', '65%'], data }] }
}

export function buildFunnelOption(funnel: AdsFunnel): EChartsOption {
  const stages = [
    { name: '曝光', value: funnel.impressions },
    { name: '点击', value: funnel.clicks },
    { name: '订单', value: funnel.orders },
  ]
  return {
    tooltip: { trigger: 'item', valueFormatter: v => formatNumber(Number(v), { digits: 0 }) },
    series: [{ name: '漏斗', type: 'funnel', sort: 'none', label: { formatter: '{b}：{c}' }, data: stages }],
  }
}

/** 逐日花费柱；有带日预算的活动时画一条“当前日预算合计”参考线（估算）。 */
export function buildBudgetOption(budget: AdsBudgetSection): EChartsOption {
  const line = budget.dailyBudgetTotal
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: budget.days.map(day => day.date) },
    yAxis: { type: 'value', axisLabel: { formatter: axisMoney } },
    series: [
      {
        name: '花费',
        type: 'bar',
        data: budget.days.map(day => day.spend),
        tooltip: { valueFormatter: money },
        ...(line !== null ? { markLine: { silent: true, symbol: 'none', data: [{ yAxis: line, name: '当前日预算合计（估算）' }], label: { formatter: '日预算合计 {c}' } } } : {}),
      },
    ],
  }
}

const QUADRANT_COLOR: Record<AdsQuadrant, string> = { STAR: '#2f9e44', WASTE: '#e03131', POTENTIAL: '#1c7ed6', LOW: '#868e96' }

/** 四象限：横轴花费、纵轴 ACoS；分界线是平均花费与整体 ACoS。 */
export function buildQuadrantOption(quadrant: AdsQuadrantSection): EChartsOption {
  const lines = [...(quadrant.spendLine !== null ? [{ xAxis: quadrant.spendLine }] : []), ...(quadrant.acosLine !== null ? [{ yAxis: quadrant.acosLine }] : [])]
  return {
    tooltip: {
      trigger: 'item',
      formatter: params => {
        const point = (params as { data?: { name?: string; value?: number[]; quadrant?: AdsQuadrant } }).data
        if (!point?.value || !point.quadrant) return ''
        return `${escapeHtml(point.name)}<br/>花费 ${money(point.value[0])}<br/>ACoS ${formatPercent(point.value[1] ?? 0, { digits: 1 })}<br/>${ADS_QUADRANT_LABEL[point.quadrant]}`
      },
    },
    grid: { left: 64, right: 24, top: 24, bottom: 36 },
    xAxis: { type: 'value', name: '花费', axisLabel: { formatter: axisMoney } },
    yAxis: { type: 'value', name: 'ACoS', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) } },
    series: [
      {
        type: 'scatter',
        symbolSize: 10,
        data: quadrant.points.map(point => ({ name: point.name, value: [point.spend, point.acos], quadrant: point.quadrant, itemStyle: { color: QUADRANT_COLOR[point.quadrant] } })),
        markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed' }, label: { show: false }, data: lines },
      },
    ],
  }
}
