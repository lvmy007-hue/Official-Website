import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { EChartsOption } from 'echarts'
import type { EChartsType } from 'echarts/core'
import { ERP_ECHARTS_THEME, erpEchartsTheme } from '../../theme/echarts-theme'

// ERP 图表：按需加载 ECharts（进入可视区才加载，不进首屏包），注册 ERP 主题。
// 不改官网共用的 src/ui/chart.tsx；这里是 ERP 自己的封装。

type EChartsCore = typeof import('echarts/core')
let libPromise: Promise<EChartsCore> | null = null

export function loadErpECharts(): Promise<EChartsCore> {
  if (!libPromise) {
    libPromise = (async () => {
      const core = await import('echarts/core')
      const { LineChart, BarChart, PieChart } = await import('echarts/charts')
      const { GridComponent, TooltipComponent, LegendComponent, MarkPointComponent, MarkLineComponent, MarkAreaComponent, DataZoomComponent, TitleComponent } = await import('echarts/components')
      const { CanvasRenderer } = await import('echarts/renderers')
      core.use([
        LineChart,
        BarChart,
        PieChart,
        GridComponent,
        TooltipComponent,
        LegendComponent,
        MarkPointComponent,
        MarkLineComponent,
        MarkAreaComponent,
        DataZoomComponent,
        TitleComponent,
        CanvasRenderer,
      ])
      core.registerTheme(ERP_ECHARTS_THEME, erpEchartsTheme)
      return core
    })().catch(error => {
      libPromise = null
      throw error
    })
  }
  return libPromise
}

export type ErpChartProps = {
  option: EChartsOption
  ariaLabel: string
  height?: number | string
  style?: CSSProperties
  onReady?: (chart: EChartsType | null) => void
  onError?: (error: unknown) => void
}

export function ErpChart({ option, ariaLabel, height = 240, style, onReady, onError }: ErpChartProps) {
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const optionRef = useRef(option)
  optionRef.current = option
  const [visible, setVisible] = useState(false)

  // 可视区懒加载：没有 IntersectionObserver 的环境直接加载。
  useEffect(() => {
    const el = host.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let killed = false
    let resizer: ResizeObserver | null = null
    loadErpECharts()
      .then(core => {
        if (killed || !host.current) return
        const chart = core.init(host.current, ERP_ECHARTS_THEME, { renderer: 'canvas' })
        chartRef.current = chart
        chart.setOption(optionRef.current)
        if (typeof ResizeObserver !== 'undefined') {
          resizer = new ResizeObserver(() => chart.resize())
          resizer.observe(host.current)
        }
        onReady?.(chart)
      })
      .catch(error => onError?.(error))
    return () => {
      killed = true
      resizer?.disconnect()
      chartRef.current?.dispose()
      chartRef.current = null
      onReady?.(null)
    }
    // 初始化只做一次；后续 option 变化由下面的副作用更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return <div ref={host} role="img" aria-label={ariaLabel} style={{ width: '100%', height, ...style }} />
}
