import type { EChartsOption } from 'echarts'
import type { WaterfallResponse } from '@nova/api-contracts'
import { formatMoney } from '../../format'

// 增长归因瀑布图配置（纯函数）：对比期销售额 → 各驱动因素的贡献 → 本期销售额。
// 尚未接入的项（金额为空，例如断货损失）不画，只在图下方的清单里写“尚未接入”。

const UP = '#2f9e44'
const DOWN = '#e03131'
const TOTAL = '#4c6ef5'

export type WaterfallStep = { label: string; base: number; value: number; kind: 'total' | 'up' | 'down'; amount: number }

export function waterfallSteps(data: WaterfallResponse): WaterfallStep[] {
  const steps: WaterfallStep[] = [{ label: '对比期', base: 0, value: data.base, kind: 'total', amount: data.base }]
  let running = data.base
  for (const item of data.byDriver) {
    if (item.amount === null) continue
    const next = running + item.amount
    steps.push({ label: item.label, base: Math.min(running, next), value: Math.abs(item.amount), kind: item.amount >= 0 ? 'up' : 'down', amount: item.amount })
    running = next
  }
  steps.push({ label: '本期', base: 0, value: data.current, kind: 'total', amount: data.current })
  return steps
}

export function buildWaterfallOption(data: WaterfallResponse): EChartsOption {
  const steps = waterfallSteps(data)
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
    grid: { left: 56, right: 16, top: 16, bottom: 48 },
    xAxis: { type: 'category', data: steps.map(step => step.label), axisLabel: { interval: 0, rotate: steps.length > 6 ? 20 : 0 } },
    yAxis: { type: 'value', axisLabel: { formatter: money } },
    series: [
      { name: '基线', type: 'bar', stack: 'wf', silent: true, itemStyle: { color: 'transparent' }, data: steps.map(step => step.base) },
      {
        name: '金额',
        type: 'bar',
        stack: 'wf',
        data: steps.map(step => ({ value: step.value, itemStyle: { color: step.kind === 'total' ? TOTAL : step.kind === 'up' ? UP : DOWN } })),
        label: { show: true, position: 'top', formatter: params => money(steps[params.dataIndex]?.amount ?? 0) },
      },
    ],
  }
}
