import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

// 后台任务的链路追踪接入点（P1-29）：接上接口入队时带来的链路，使“接口 → 队列 → 后台任务”在同一条链路上。
// 只依赖与厂商无关的 OpenTelemetry 接口；未注册追踪器时全部为空操作。

const tracer = trace.getTracer('nova-worker')

export async function runInJobTrace<T>(name: string, traceparent: string | undefined, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const parent = traceparent ? propagation.extract(context.active(), { traceparent }) : context.active()
  const span = tracer.startSpan(name, { kind: SpanKind.CONSUMER, attributes }, parent)
  try {
    return await context.with(trace.setSpan(parent, span), fn)
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  } finally {
    span.end()
  }
}
