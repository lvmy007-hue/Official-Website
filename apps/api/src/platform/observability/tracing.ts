import { context, propagation, trace, type Context } from '@opentelemetry/api'

// 链路追踪接入点（P1-29）：贯穿“接口 → 队列 → 后台任务”。
// 业务代码只依赖与厂商无关的 OpenTelemetry 接口；未注册追踪器时全部为空操作。
// 链路上下文用 W3C 标准的 traceparent 字符串传递，不携带任何业务数据。

export const TRACER_NAME = 'nova-api'

export const tracer = trace.getTracer(TRACER_NAME)

/** 从进入的请求头里取出上游链路上下文（没有则返回当前上下文）。 */
export function extractContext(headers: Record<string, string | string[] | undefined>): Context {
  return propagation.extract(context.active(), headers)
}

/** 当前链路的 traceparent；没有活动链路时返回 undefined。放进队列任务数据，后台任务据此接上同一条链路。 */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  return carrier.traceparent
}
