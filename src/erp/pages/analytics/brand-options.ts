import type { EChartsOption } from 'echarts'
import { BA_QUADRANT_LABEL, BA_QUADRANTS, type BaQuadrantSummary, type BaQuadrant, type BaShareSet, type BaTrendPoint } from '@nova/api-contracts'
import { escapeHtml } from '../../components/chart/chart-utils'
import { formatNumber, formatPercent } from '../../format'

// 品牌分析各页的纯函数：数值显示（没有值写“尚无记录”，绝不写 0）与图表配置。份额是 0 到 1 的小数，变化是百分点。

export const NO_RECORD = '尚无记录'

export const percentText = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined ? NO_RECORD : formatPercent(value, { digits }))
export const countText = (value: number | null | undefined): string => (value === null || value === undefined ? NO_RECORD : formatNumber(value, { digits: 0 }))
export const moneyText = (value: number | null | undefined): string => (value === null || value === undefined ? NO_RECORD : `$${formatNumber(value, { digits: 2 })}`)

/** 份额变化：0.012 → “+1.2 个百分点”；没有上一周期写“无上一周期”。 */
export function changeText(change: number | null | undefined): string {
  if (change === null || change === undefined) return '无上一周期'
  const points = change * 100
  const text = formatNumber(Math.abs(points), { digits: 1 })
  return points === 0 || text === '0.0' ? '持平' : `${points > 0 ? '+' : '-'}${text} 个百分点`
}

/** 变化的颜色：份额上升为绿、下降为红、其余不着色。 */
export const changeColor = (change: number | null | undefined): string | undefined => (change === null || change === undefined || change === 0 ? undefined : change > 0 ? '#389e0d' : '#cf1322')

/** 排名变化：正数 = 排名数字变小 = 热度上升。 */
export function rankChangeText(change: number | null | undefined): string {
  if (change === null || change === undefined) return '无上一周期'
  if (change === 0) return '持平'
  return `${change > 0 ? '上升' : '下降'} ${formatNumber(Math.abs(change), { digits: 0 })} 位`
}

export const SHARE_KEYS: ReadonlyArray<{ key: keyof BaShareSet; label: string }> = [
  { key: 'impression', label: '展示份额' },
  { key: 'click', label: '点击份额' },
  { key: 'cartAdd', label: '加购份额' },
  { key: 'purchase', label: '购买份额' },
]

const PALETTE = ['#4c6ef5', '#f08c00', '#12b886', '#e64980']
const QUADRANT_COLOR: Record<BaQuadrant, string> = { STAR: '#12b886', OPPORTUNITY: '#4c6ef5', NICHE: '#f08c00', WATCH: '#adb5bd' }
export const quadrantColor = (quadrant: BaQuadrant) => QUADRANT_COLOR[quadrant]

/** 逐期趋势：四条份额线（左轴，某期没有份额线断开，不画成 0）与搜索量柱（右轴）。 */
export function buildTrendOption(points: readonly BaTrendPoint[]): EChartsOption {
  const dates = points.map(point => point.periodStart)
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 64, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: dates },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (value: number) => percentText(value, 0) } },
      { type: 'value', splitLine: { show: false }, axisLabel: { formatter: (value: number) => formatNumber(value, { digits: 0, compact: true }) } },
    ],
    series: [
      ...SHARE_KEYS.map(({ key, label }, index) => ({
        name: label,
        type: 'line' as const,
        connectNulls: false,
        itemStyle: { color: PALETTE[index] },
        data: points.map(point => point.shares[key]),
        tooltip: { valueFormatter: (value: unknown) => percentText(typeof value === 'number' ? value : null) },
      })),
      {
        name: '搜索量',
        type: 'bar' as const,
        yAxisIndex: 1,
        barMaxWidth: 18,
        itemStyle: { color: 'rgba(134,142,150,0.35)' },
        data: points.map(point => point.volume),
        tooltip: { valueFormatter: (value: unknown) => countText(typeof value === 'number' ? value : null) },
      },
    ],
  }
}

/** 机会象限：横轴搜索量（对数轴）、纵轴购买份额，四种颜色对应四个象限，虚线是中位数。 */
export function buildQuadrantOption(summary: BaQuadrantSummary): EChartsOption {
  const medians = summary.medians
  return {
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const item = (params as { data?: { value: [number, number]; name: string } }).data
        return item ? `${escapeHtml(item.name)}<br/>搜索量 ${countText(item.value[0])}，购买份额 ${percentText(item.value[1])}` : ''
      },
    },
    legend: { top: 0 },
    grid: { left: 56, right: 24, top: 32, bottom: 40 },
    xAxis: { type: 'log', name: '搜索量', nameLocation: 'middle', nameGap: 26, min: 1 },
    yAxis: { type: 'value', name: '购买份额', axisLabel: { formatter: (value: number) => percentText(value, 0) } },
    series: BA_QUADRANTS.map(quadrant => ({
      name: BA_QUADRANT_LABEL[quadrant],
      type: 'scatter' as const,
      itemStyle: { color: QUADRANT_COLOR[quadrant] },
      data: summary.points.filter(point => point.quadrant === quadrant).map(point => ({ name: point.searchQuery, value: [Math.max(1, point.volume), point.purchaseShare] })),
      ...(quadrant === 'STAR' && medians
        ? { markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed' as const, color: '#868e96' }, data: [{ xAxis: Math.max(1, medians.volume) }, { yAxis: medians.purchaseShare }] } }
        : {}),
    })),
  }
}

/** 购物篮矩阵格子的底色：同篮率越高越深；没有值为透明。 */
export function heatColor(value: number | null, max: number | null): string {
  if (value === null || max === null || max <= 0) return 'transparent'
  const alpha = Math.max(0.08, Math.min(1, value / max)) * 0.75
  return `rgba(76, 110, 245, ${alpha.toFixed(2)})`
}
