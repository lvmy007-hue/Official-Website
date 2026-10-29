import type { EChartsOption } from 'echarts'
import { erpTokens } from '../../theme/tokens'

// 图表与表格联动、图表转表格的纯函数（P6-06，15 章第 9 节）。
// 联动的约定：图上点某个日期或系列，同页表格接收后筛选；表格点某一行，图上高亮对应日期或系列。
// 本文件不依赖 React；状态在 use-chart-link.ts。

type Loose = Record<string, unknown>
const asRecord = (value: unknown): Loose => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {})

function seriesOf(option: EChartsOption): Loose[] {
  const raw = option.series
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(asRecord)
}

/** 横轴类目（第一条横轴）；不是类目轴的图（饼图、散点图）返回空数组。 */
export function chartCategories(option: EChartsOption): string[] {
  const axis = asRecord(Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis)
  return Array.isArray(axis.data) ? axis.data.map(item => String(asRecord(item).value ?? item)) : []
}

/** 绘图区左右留白（事件带与图对齐用）；写成数字或百分比字符串，没写就用 ECharts 的默认 10%。 */
export function chartGrid(option: EChartsOption): { left: number | string; right: number | string } {
  const grid = asRecord(Array.isArray(option.grid) ? option.grid[0] : option.grid)
  const pick = (value: unknown): number | string => (typeof value === 'number' || typeof value === 'string' ? value : '10%')
  return { left: pick(grid.left), right: pick(grid.right) }
}

/** 类目轴两端是否留白：折线图默认留（点在格子中间），写了 boundaryGap: false 才贴边。 */
export function chartBoundaryGap(option: EChartsOption): boolean {
  const axis = asRecord(Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis)
  return axis.boundaryGap !== false
}

export type HighlightTarget = { series?: string | null; category?: string | null }

const FADED = 0.2

/** 高亮：指定系列时其余系列变淡；指定类目时在该类目画一条实线（和事件标注的虚线并存）。目标不存在时原样返回。 */
export function withHighlight(option: EChartsOption, target: HighlightTarget): EChartsOption {
  const list = seriesOf(option)
  if (list.length === 0) return option
  const categories = chartCategories(option)
  const focusSeries = target.series && list.some(item => item.name === target.series) ? target.series : null
  const focusCategory = target.category && categories.includes(target.category) ? target.category : null
  if (!focusSeries && !focusCategory) return option
  const next = list.map((item, index) => {
    let out: Loose = item
    if (focusSeries && item.name !== focusSeries) {
      out = { ...out, lineStyle: { ...asRecord(out.lineStyle), opacity: FADED }, itemStyle: { ...asRecord(out.itemStyle), opacity: FADED } }
    }
    if (focusCategory && index === 0) {
      const line = asRecord(out.markLine)
      const data = Array.isArray(line.data) ? line.data : []
      out = {
        ...out,
        markLine: {
          symbol: 'none',
          silent: true,
          label: { show: false },
          ...line,
          data: [...data, { xAxis: focusCategory, lineStyle: { type: 'solid', width: 2, color: erpTokens.brand } }],
        },
      }
    }
    return out
  })
  return { ...option, series: next as never }
}

export type ChartTableData = { categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }

const numberOf = (value: unknown): number | null => {
  const raw = asRecord(value).value ?? value
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

const TABLE_SERIES_TYPES = new Set(['line', 'bar'])

/** 把“类目 × 系列”的图转成表格数据；饼图、散点图、没有类目轴或数据长度对不上的图返回 null（页面不显示“切换为表格”）。 */
export function optionToTable(option: EChartsOption): ChartTableData | null {
  const categories = chartCategories(option)
  const list = seriesOf(option)
  if (categories.length === 0 || list.length === 0) return null
  const series: ChartTableData['series'] = []
  for (const [index, item] of list.entries()) {
    if (!TABLE_SERIES_TYPES.has(String(item.type)) || !Array.isArray(item.data) || item.data.length > categories.length) return null
    const values = categories.map((_, i) => numberOf(item.data && (item.data as unknown[])[i]))
    series.push({ name: typeof item.name === 'string' && item.name ? item.name : `系列 ${index + 1}`, values })
  }
  return { categories, series }
}
