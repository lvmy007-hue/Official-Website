import { useEffect, useRef, type CSSProperties } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { EChartsOption } from 'echarts'
import type { EChartsType } from 'echarts/core'

type EChartsCore = typeof import('echarts/core')
let libPromise: Promise<EChartsCore> | null = null

// 按需加载 ECharts（仅客户端），保证 SSR/预渲染阶段不触碰 DOM，首屏不打进主包。
async function loadECharts(): Promise<EChartsCore> {
  if (!libPromise) {
    libPromise = (async () => {
      const core = await import('echarts/core')
      const { LineChart, BarChart, PieChart } = await import('echarts/charts')
      const {
        GridComponent, TooltipComponent, LegendComponent,
        GraphicComponent, MarkPointComponent, MarkLineComponent,
      } = await import('echarts/components')
      const { CanvasRenderer } = await import('echarts/renderers')
      core.use([
        LineChart, BarChart, PieChart,
        GridComponent, TooltipComponent, LegendComponent,
        GraphicComponent, MarkPointComponent, MarkLineComponent,
        CanvasRenderer,
      ])
      return core
    })()
  }
  return libPromise
}

export function EChart({
  option, className, style, ariaLabel, height = 220,
}: { option: EChartsOption; className?: string; style?: CSSProperties; ariaLabel: string; height?: number }) {
  const el = useRef<HTMLDivElement>(null)
  const inst = useRef<EChartsType | null>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    let killed = false
    let ro: ResizeObserver | null = null
    loadECharts().then(ec => {
      if (killed || !el.current) return
      const chart = ec.init(el.current, undefined, { renderer: 'canvas' })
      inst.current = chart
      chart.setOption({ ...option, animation: !reduce })
      ro = new ResizeObserver(() => chart.resize())
      ro.observe(el.current)
    })
    return () => {
      killed = true
      if (ro) ro.disconnect()
      if (inst.current) { inst.current.dispose(); inst.current = null }
    }
    // 初始化一次；option 更新交由下方 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (inst.current) inst.current.setOption({ ...option, animation: !reduce }, true)
  }, [option, reduce])

  return (
    <div
      ref={el}
      className={className}
      style={{ width: '100%', height, ...style }}
      role="img"
      aria-label={ariaLabel}
    />
  )
}
