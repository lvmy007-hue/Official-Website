import { normalizeRouteTemplate, type WebVitalName } from '@nova/api-contracts'
import { apiFetch, hasAccessToken, setApiTimingListener } from '../../api'

// 前端性能埋点（P1-09，12 章 12.4）：首次内容绘制（FCP）、最大内容渲染（LCP）、首次可交互（TTI，外壳可操作）、接口耗时。
// 只上报“指标名、耗时、路由模板”；路径里形似编号的段一律换成 :id，不带查询参数，不含用户、租户、店铺或订单信息。
// 上报失败直接丢弃，不重试、不提示：埋点不能影响业务操作。

export interface VitalItem {
  name: WebVitalName
  valueMs: number
  route: string
}

const REPORT_PATH = '/telemetry/web-vitals'
const BATCH_SIZE = 30

export interface VitalsReporter {
  add(item: VitalItem): void
  flush(): Promise<void>
  size(): number
}

/** 缓冲与批量上报：未登录时先攒着（上限内丢最旧的），登录后再发；每批最多 30 条。 */
export function createVitalsReporter(options: { send: (items: VitalItem[]) => Promise<void>; canSend: () => boolean; maxBuffer?: number }): VitalsReporter {
  const max = options.maxBuffer ?? 100
  const buffer: VitalItem[] = []
  return {
    add(item) {
      if (!Number.isFinite(item.valueMs) || item.valueMs < 0) return
      buffer.push({ name: item.name, valueMs: Math.round(item.valueMs), route: normalizeRouteTemplate(item.route).slice(0, 120) })
      if (buffer.length > max) buffer.shift()
    },
    async flush() {
      while (buffer.length > 0 && options.canSend()) {
        const batch = buffer.splice(0, BATCH_SIZE)
        try {
          await options.send(batch)
        } catch {
          /* 丢弃这一批 */
        }
      }
    },
    size: () => buffer.length,
  }
}

let active: VitalsReporter | null = null
let interactiveReported = false

/** 外壳首次渲染完成后调用一次：从页面开始加载到此刻的耗时记为首次可交互。 */
export function markShellInteractive(route: string) {
  if (!active || interactiveReported) return
  interactiveReported = true
  const report = active
  // 等下一帧：确保外壳已经绘制出来、用户真的能操作
  requestAnimationFrame(() => report.add({ name: 'TTI', valueMs: performance.now(), route }))
}

/**
 * 启动采集：返回停止函数。浏览器不支持的指标自动跳过。
 * getRoute 返回当前路径（不含查询参数）；用于给 FCP、LCP 打上所在页面。
 */
export function startWebVitals(getRoute: () => string): () => void {
  if (active || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return () => undefined
  const reporter = createVitalsReporter({
    canSend: hasAccessToken,
    send: async items => {
      await apiFetch(REPORT_PATH, { method: 'POST', body: JSON.stringify({ items }), keepalive: true })
    },
  })
  active = reporter
  interactiveReported = false
  const observers: PerformanceObserver[] = []
  let lcp = 0
  let lcpReported = false
  const finalizeLcp = () => {
    if (lcpReported || lcp <= 0) return
    lcpReported = true
    reporter.add({ name: 'LCP', valueMs: lcp, route: getRoute() })
  }
  const observe = (type: string, handle: (entries: PerformanceEntryList) => void) => {
    try {
      const observer = new PerformanceObserver(list => handle(list.getEntries()))
      observer.observe({ type, buffered: true })
      observers.push(observer)
    } catch {
      /* 该指标在当前浏览器不可用 */
    }
  }
  observe('paint', entries => {
    const fcp = entries.find(entry => entry.name === 'first-contentful-paint')
    if (fcp) reporter.add({ name: 'FCP', valueMs: fcp.startTime, route: getRoute() })
  })
  observe('largest-contentful-paint', entries => {
    const last = entries[entries.length - 1]
    if (last) lcp = last.startTime
  })

  setApiTimingListener((path, durationMs) => {
    if (path.startsWith(REPORT_PATH)) return
    reporter.add({ name: 'API', valueMs: durationMs, route: path })
  })

  const onHidden = () => {
    if (document.visibilityState === 'hidden') {
      finalizeLcp()
      void reporter.flush()
    }
  }
  // 用户第一次操作后 LCP 不再变化
  const onFirstInput = () => finalizeLcp()
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onHidden)
  window.addEventListener('pointerdown', onFirstInput, { once: true })
  window.addEventListener('keydown', onFirstInput, { once: true })
  const timer = window.setInterval(() => {
    void reporter.flush()
  }, 30_000)

  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('pagehide', onHidden)
    window.removeEventListener('pointerdown', onFirstInput)
    window.removeEventListener('keydown', onFirstInput)
    observers.forEach(observer => observer.disconnect())
    setApiTimingListener(null)
    active = null
  }
}
