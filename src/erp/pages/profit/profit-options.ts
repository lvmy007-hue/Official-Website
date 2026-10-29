import type { EChartsOption } from 'echarts'
import type { ProfitBridgeView, ProfitTrendPoint } from '@nova/api-contracts'
import { formatMoney } from '../../format'

// 利润分析页的图表配置（纯函数）。
// 利润桥瀑布：销售额起步，逐项加减；净利润算不出时不画终点柱；没有数据、没有权限、尚未接入的项目不画，在图下方的表里写明原因。
// 如果画出来的项目加总与净利润不一致（有项目没画），补一根“未列入图中的项目”柱，保证图自洽，而不是悄悄不平。

const UP = '#2f9e44'
const DOWN = '#e03131'
const TOTAL = '#4c6ef5'
const REST = '#adb5bd'

/** lo、hi 是柱子的下沿与上沿（可以跨过 0，亏损时常见）；amount 是带符号的金额。 */
export type BridgeStep = { label: string; lo: number; hi: number; kind: 'total' | 'up' | 'down' | 'rest'; amount: number }

export function bridgeSteps(view: ProfitBridgeView): BridgeStep[] {
  const steps: BridgeStep[] = []
  let running = 0
  for (const item of view.items) {
    if (item.key === 'NET_PROFIT' || item.contribution === null || item.contribution === 0) continue
    const next = running + item.contribution
    steps.push({ label: item.label, lo: Math.min(running, next), hi: Math.max(running, next), kind: item.contribution >= 0 ? 'up' : 'down', amount: item.contribution })
    running = next
  }
  if (view.netProfit === null) return steps
  const rest = Math.round((view.netProfit - running) * 100) / 100
  if (Math.abs(rest) >= 0.01) {
    const next = running + rest
    steps.push({ label: '未列入图中的项目', lo: Math.min(running, next), hi: Math.max(running, next), kind: 'rest', amount: rest })
  }
  steps.push({ label: '净利润', lo: Math.min(0, view.netProfit), hi: Math.max(0, view.netProfit), kind: 'total', amount: view.netProfit })
  return steps
}

const COLOR = { total: TOTAL, up: UP, down: DOWN, rest: REST } as const

export function buildBridgeOption(view: ProfitBridgeView): EChartsOption {
  const steps = bridgeSteps(view)
  const money = (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true })
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: params => {
        const index = Array.isArray(params) ? Number((params[0] as { dataIndex?: number }).dataIndex ?? 0) : 0
        const step = steps[index]
        return step ? `${step.label}：${formatMoney(step.amount, 'USD', { digits: 2, sign: step.kind !== 'total' })}` : ''
      },
    },
    grid: { left: 56, right: 16, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: steps.map(step => step.label), axisLabel: { interval: 0, rotate: steps.length > 6 ? 25 : 0 } },
    yAxis: { type: 'value', axisLabel: { formatter: money } },
    series: [
      // 柱子可能跨过 0：正半轴与负半轴各自堆叠，透明的“基线”托住真正的彩色段
      { name: '基线（正）', type: 'bar', stack: 'bridge', silent: true, itemStyle: { color: 'transparent' }, data: steps.map(step => (step.hi > 0 ? Math.max(0, step.lo) : 0)) },
      { name: '基线（负）', type: 'bar', stack: 'bridge', silent: true, itemStyle: { color: 'transparent' }, data: steps.map(step => Math.min(0, step.hi)) },
      {
        name: '金额（正）',
        type: 'bar',
        stack: 'bridge',
        data: steps.map(step => ({ value: Math.max(0, step.hi) - Math.max(0, step.lo), itemStyle: { color: COLOR[step.kind] } })),
        label: { show: true, position: 'top', formatter: params => ((steps[params.dataIndex]?.hi ?? 0) > 0 ? money(steps[params.dataIndex]?.amount ?? 0) : '') },
      },
      {
        name: '金额（负）',
        type: 'bar',
        stack: 'bridge',
        data: steps.map(step => ({ value: Math.min(0, step.lo) - Math.min(0, step.hi), itemStyle: { color: COLOR[step.kind] } })),
        label: { show: true, position: 'bottom', formatter: params => ((steps[params.dataIndex]?.hi ?? 0) > 0 ? '' : money(steps[params.dataIndex]?.amount ?? 0)) },
      },
    ],
  }
}
/** 趋势：销售额柱、净利润线；某天有一行缺成本算不出净利润时，净利润线断开，只用虚线画“已能算出的部分”。 */
export function buildTrendOption(points: ProfitTrendPoint[]): EChartsOption {
  const money = (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true })
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatMoney(value, 'USD', { digits: 2 }) : '算不出') },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: { type: 'value', axisLabel: { formatter: money } },
    series: [
      { name: '销售额', type: 'bar', data: points.map(point => point.revenue), itemStyle: { color: '#91a7ff' } },
      { name: '净利润', type: 'line', data: points.map(point => point.profit), connectNulls: false, itemStyle: { color: UP } },
      {
        name: '部分利润（当天有商品缺成本）',
        type: 'line',
        lineStyle: { type: 'dashed' },
        data: points.map(point => (point.profit === null ? point.coveredProfit : null)),
        itemStyle: { color: '#f08c00' },
      },
    ],
  }
}
