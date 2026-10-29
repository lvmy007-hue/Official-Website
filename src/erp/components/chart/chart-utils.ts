import type { EChartsOption } from 'echarts'
import { erpTokens } from '../../theme/tokens'

// 图表辅助：事件标注叠加、降采样。均为纯函数，便于测试。

/**
 * 图表提示框（tooltip）的自定义格式化函数返回的字符串会被 ECharts 当成 HTML 渲染。
 * 搜索词、活动名称、商品标题这类来自亚马逊或用户输入的文本放进去之前必须转义，否则就是存储型跨站脚本（P5-13）。
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, char => `&#${char.charCodeAt(0)};`)
}

export type ChartEvent = { date: string; label: string; kind: string }

/** 把事件作为竖线叠加到第一条序列上（横轴为日期类目）。不在横轴范围内的事件忽略并计数。 */
export function withEventMarks(option: EChartsOption, events: readonly ChartEvent[]): { option: EChartsOption; shown: number } {
  const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis
  const categories = ((xAxis as { data?: unknown[] } | undefined)?.data ?? []).map(String)
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
  if (!series.length || !categories.length) return { option, shown: 0 }
  const inRange = events.filter(event => categories.includes(event.date))
  if (!inRange.length) return { option, shown: 0 }
  const [first, ...rest] = series
  const marked = {
    ...(first as object),
    markLine: {
      symbol: 'none',
      silent: false,
      lineStyle: { type: 'dashed', width: 1, color: erpTokens.inkMute },
      label: { show: true, formatter: (item: { name?: string }) => item.name ?? '', position: 'end', fontSize: 11 },
      data: inRange.map(event => ({ xAxis: event.date, name: event.label })),
    },
  }
  return { option: { ...option, series: [marked as never, ...(rest as never[])] }, shown: inRange.length }
}

/** 降采样：每个桶保留最小值与最大值，趋势形状和极值不丢。点数不超过上限时原样返回。 */
export function downsample<T extends { value: number }>(points: readonly T[], maxPoints: number): { points: T[]; sampled: boolean } {
  if (points.length <= maxPoints || maxPoints < 4) return { points: [...points], sampled: false }
  const bucketCount = Math.floor((maxPoints - 2) / 2)
  const size = (points.length - 2) / bucketCount
  const out: T[] = [points[0]!]
  for (let b = 0; b < bucketCount; b++) {
    const start = 1 + Math.floor(b * size)
    const end = Math.min(points.length - 1, 1 + Math.floor((b + 1) * size))
    let minIndex = start
    let maxIndex = start
    for (let i = start; i < end; i++) {
      if (points[i]!.value < points[minIndex]!.value) minIndex = i
      if (points[i]!.value > points[maxIndex]!.value) maxIndex = i
    }
    const ordered = minIndex <= maxIndex ? [minIndex, maxIndex] : [maxIndex, minIndex]
    for (const index of ordered) {
      const p = points[index]!
      if (out[out.length - 1] !== p) out.push(p)
    }
  }
  out.push(points[points.length - 1]!)
  return { points: out, sampled: true }
}
