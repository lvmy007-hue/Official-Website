import { context, metrics, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemoryMetricExporter, AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { ALERT_CODES, AlertService, type AlertEvent } from './alerts'
import { createLogger, REDACTED, StructuredNestLogger } from './logger'
import { resetMetricInstruments } from './metrics'
import { currentTraceparent } from './tracing'

function capture() {
  const lines: string[] = []
  const destination = {
    write: (chunk: string) => {
      lines.push(chunk)
    },
  }
  const entries = () => lines.map(line => JSON.parse(line) as Record<string, any>)
  return { destination, lines, entries }
}

describe('结构化日志', () => {
  it('每行是 JSON，敏感字段在前三层都被替换', () => {
    const out = capture()
    const log = createLogger(out.destination, 'info')
    log.info({ email: 'a@b.com', buyer: { buyerName: '张三', address: { shippingAddress: '某街 1 号' } }, nested: { deep: { token: 'tok-123' } }, orderCount: 3 }, 'import finished')
    const [entry] = out.entries()
    expect(entry.email).toBe(REDACTED)
    expect(entry.buyer.buyerName).toBe(REDACTED)
    expect(entry.buyer.address).toBe(REDACTED)
    expect(entry.nested.deep.token).toBe(REDACTED)
    expect(entry.orderCount).toBe(3)
    for (const secret of ['a@b.com', '张三', '某街', 'tok-123']) expect(out.lines.join('')).not.toContain(secret)
  })

  it('框架日志适配器输出同样的 JSON 格式，并带上上下文名称', () => {
    const out = capture()
    new StructuredNestLogger(createLogger(out.destination, 'info')).warn({ event: 'slow_query', durationMs: 1200 }, 'SlowQuery')
    expect(out.entries()[0]).toMatchObject({ level: 40, event: 'slow_query', context: 'SlowQuery', durationMs: 1200, msg: 'slow_query' })
  })
})

describe('请求日志、指标与链路', () => {
  const spans = new InMemorySpanExporter()
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 })] })
  const out = capture()
  let harness: Awaited<ReturnType<typeof createTestApp>>

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }))
    metrics.setGlobalMeterProvider(meterProvider)
    resetMetricInstruments()
    harness = await createTestApp({ ...sessionStub([]) }, createLogger(out.destination, 'debug'))
  })
  afterAll(async () => {
    await harness.close()
    await meterProvider.shutdown()
    trace.disable()
    metrics.disable()
    propagation.disable()
    context.disable()
  })

  const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

  it('日志带请求编号与租户编号，只记录路由模板，不含查询参数、请求头与账号信息', async () => {
    const res = await harness.call('GET', '/orders?email=buyer@example.com&token=secret-value', { headers: { 'x-request-id': 'req-observe-0001' } })
    expect(res.status).toBe(403)
    const entry = out.entries().find(item => item.event === 'http_request' && item.requestId === 'req-observe-0001')
    expect(entry).toMatchObject({ method: 'GET', route: '/api/v1/orders', status: 403, tenantId: 'tenant-1', userId: 'user-1', service: 'nova-api', level: 40 })
    expect(typeof entry!.durationMs).toBe('number')
    const text = out.lines.join('')
    for (const secret of ['buyer@example.com', 'secret-value', 'Bearer', 'authorization']) expect(text).not.toContain(secret)
  })

  it('未匹配的路径不记录真实路径', async () => {
    await harness.call('GET', '/definitely/not/here/jane.doe@example.com', { headers: { 'x-request-id': 'req-observe-0002' } })
    const entry = out.entries().find(item => item.requestId === 'req-observe-0002')
    expect(entry).toMatchObject({ route: '(unmatched)' })
    expect(out.lines.join('')).not.toContain('jane.doe')
  })

  it('接上游传来的链路，生成接口请求的链路片段，并能把链路带给后台任务', async () => {
    await harness.call('GET', '/orders', { headers: { traceparent, 'x-request-id': 'req-observe-0003' } })
    const span = spans.getFinishedSpans().find(item => item.attributes['nova.request_id'] === 'req-observe-0003')
    expect(span).toBeDefined()
    expect(span!.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(span!.parentSpanContext?.spanId).toBe('b7ad6b7169203331')
    expect(span!.name).toBe('GET /api/v1/orders')
    expect(span!.attributes).toMatchObject({ 'http.route': '/api/v1/orders', 'http.response.status_code': 403, 'nova.tenant_id': 'tenant-1' })

    expect(currentTraceparent()).toBeUndefined()
    const inside = tracerRun(() => currentTraceparent())
    expect(inside).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
  })

  it('输出请求数量与耗时指标，标签只有方法、路由模板与状态类别', async () => {
    await meterProvider.forceFlush()
    const all = metricExporter.getMetrics().flatMap(item => item.scopeMetrics.flatMap(scope => scope.metrics))
    const names = all.map(metric => metric.descriptor.name)
    expect(names).toContain('nova_http_requests_total')
    expect(names).toContain('nova_http_request_duration_ms')
    const counter = all.filter(metric => metric.descriptor.name === 'nova_http_requests_total').at(-1)!
    const labelKeys = new Set(counter.dataPoints.flatMap(point => Object.keys(point.attributes)))
    expect([...labelKeys].sort()).toEqual(['method', 'route', 'status_class'])
  })
})

function tracerRun<T>(fn: () => T): T {
  const span = trace.getTracer('test').startSpan('probe')
  try {
    return context.with(trace.setSpan(context.active(), span), fn)
  } finally {
    span.end()
  }
}

describe('站内告警', () => {
  const makeService = (now: { value: number }) => {
    const out = capture()
    const service = new AlertService({ log: createLogger(out.destination, 'info'), now: () => now.value, windowMs: 1000 })
    const delivered: AlertEvent[] = []
    service.registerSink({
      deliver: async event => {
        delivered.push(event)
      },
    })
    return { service, delivered, out }
  }
  const base = { code: 'SYNC_FAILED' as const, severity: 'warning' as const, message: '订单同步失败，将自动重试', tenantId: 't1', dedupeKey: 'job-1' }

  it('登记了 11.4 要求的全部告警类型', () => {
    for (const code of ['SYNC_FAILED', 'AUTH_EXPIRING', 'WRITE_SWITCH_AUTO_CLOSED', 'FX_FETCH_FAILED', 'PUSH_INTERRUPTED', 'QUEUE_BACKLOG']) expect(ALERT_CODES).toContain(code)
  })

  it('发出告警：写日志并交给接收端', async () => {
    const now = { value: 1000 }
    const { service, delivered, out } = makeService(now)
    expect(await service.raise(base)).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ code: 'SYNC_FAILED', tenantId: 't1' })
    expect(out.entries()[0]).toMatchObject({ event: 'alert', code: 'SYNC_FAILED', level: 40 })
  })

  it('去重窗口内同一条告警只发一次，窗口过后再发；不同租户互不影响', async () => {
    const now = { value: 1000 }
    const { service, delivered } = makeService(now)
    await service.raise(base)
    expect(await service.raise(base)).toBe(false)
    expect(await service.raise({ ...base, tenantId: 't2' })).toBe(true)
    now.value += 1001
    expect(await service.raise(base)).toBe(true)
    expect(delivered).toHaveLength(3)
  })

  it('某个接收端失败不影响其他接收端，也不抛出', async () => {
    const now = { value: 1000 }
    const { service, delivered, out } = makeService(now)
    service.registerSink({ deliver: vi.fn().mockRejectedValue(new Error('down')) })
    service.registerSink({
      deliver: async event => {
        delivered.push(event)
      },
    })
    await expect(service.raise(base)).resolves.toBe(true)
    expect(delivered).toHaveLength(2)
    expect(out.entries().some(entry => entry.event === 'alert_sink_failed')).toBe(true)
  })

  it('拒绝未登记的告警代码', async () => {
    const { service } = makeService({ value: 0 })
    await expect(service.raise({ ...base, code: 'MADE_UP' as never })).rejects.toThrow(/unregistered/)
  })
})
