import { metrics, type Counter, type Histogram } from '@opentelemetry/api'

// 指标输出接入点（P1-29）：业务代码只依赖与厂商无关的 OpenTelemetry 指标接口。
// 没有注册导出器时这些调用不产生任何开销；部署时在进程启动最开始注册导出器（见 13 章部署专项），业务代码无需改动。
// 指标的标签只用有限取值（方法、路由模板、状态类别、告警代码），不放租户编号、用户编号、查询参数，避免标签数量失控与信息泄露。
//
// 注意：OpenTelemetry 的指标接口不会在注册导出器之前创建的指标上补发数据，所以这里在第一次使用时才创建指标，
// 而不是在模块加载时创建。

interface Instruments {
  httpRequestDuration: Histogram
  httpRequestTotal: Counter
  slowQueryTotal: Counter
  alertTotal: Counter
  webVitalDuration: Histogram
}

let cached: Instruments | undefined

function instruments(): Instruments {
  if (cached) return cached
  const meter = metrics.getMeter('nova-api')
  // 内存泄漏监控（12.5）：常驻内存、堆、外部内存与活动资源（定时器、连接、监听）数量随时间只升不降就是泄漏的信号。
  // 观察型指标：只在导出器采集时读取，自身不持有定时器。
  const memory = meter.createObservableGauge('nova_process_memory_bytes', { description: '进程内存占用（字节）：rss 常驻、heap_used 已用堆、heap_total 堆总量、external 外部内存', unit: 'By' })
  memory.addCallback(result => {
    const usage = process.memoryUsage()
    result.observe(usage.rss, { kind: 'rss' })
    result.observe(usage.heapUsed, { kind: 'heap_used' })
    result.observe(usage.heapTotal, { kind: 'heap_total' })
    result.observe(usage.external, { kind: 'external' })
  })
  const resources = meter.createObservableGauge('nova_process_active_resources', { description: '进程中尚未释放的活动资源数量（定时器、连接、监听）' })
  resources.addCallback(result => result.observe(process.getActiveResourcesInfo().length))
  cached = {
    httpRequestDuration: meter.createHistogram('nova_http_request_duration_ms', { description: '接口请求耗时（毫秒）', unit: 'ms' }),
    httpRequestTotal: meter.createCounter('nova_http_requests_total', { description: '接口请求总数' }),
    slowQueryTotal: meter.createCounter('nova_slow_queries_total', { description: '超过慢查询阈值的数据库查询次数' }),
    webVitalDuration: meter.createHistogram('nova_web_vital_ms', { description: '前端性能指标（毫秒）：FCP、LCP、TTI、接口耗时，按路由模板区分', unit: 'ms' }),
    alertTotal: meter.createCounter('nova_alerts_total', { description: '触发的站内告警次数（按告警代码与级别）' }),
  }
  return cached
}

export const recordHttpRequest = (durationMs: number, attributes: { method: string; route: string; status_class: string }) => {
  const { httpRequestDuration, httpRequestTotal } = instruments()
  httpRequestDuration.record(durationMs, attributes)
  httpRequestTotal.add(1, attributes)
}
/** 前端上报的性能指标（P1-09）：标签只有指标名与路由模板，不含任何个人信息。 */
export const recordWebVital = (name: string, valueMs: number, route: string) => instruments().webVitalDuration.record(valueMs, { name, route })
export const recordSlowQuery = () => instruments().slowQueryTotal.add(1)
export const recordAlert = (code: string, severity: string) => instruments().alertTotal.add(1, { code, severity })

/** 仅供测试：重新创建指标（测试里会反复注册新的导出器）。 */
export function resetMetricInstruments() {
  cached = undefined
}

/** 状态码归类为 2xx、3xx、4xx、5xx，避免标签值过多。 */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`
}
