import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { NextFunction, Request, Response } from 'express'
import type { Logger } from 'pino'
import type { RequestWithContext } from '../http'
import { logger as defaultLogger, requestLogStore, type RequestLogContext } from './logger'
import { recordHttpRequest, statusClass } from './metrics'
import { extractContext, tracer } from './tracing'

// 请求观测中间件：一处同时完成结构化日志、指标、链路追踪，三者共用同一个请求编号。
// 只记录路由模板（如 /api/v1/orders/:id），不记录真实路径、查询参数、请求头与请求体，避免把个人信息写进日志。

const QUIET_ROUTES = new Set(['/api/v1/health'])

function routeTemplate(req: Request): string {
  const path = req.route && typeof req.route.path === 'string' ? req.route.path : undefined
  return path ? `${req.baseUrl ?? ''}${path}` : '(unmatched)'
}

export function requestObserver(log: Logger = defaultLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const withContext = req as RequestWithContext
    const startedAt = process.hrtime.bigint()
    const store: RequestLogContext = { requestId: withContext.requestId }

    const parent = extractContext(req.headers)
    const span = tracer.startSpan(req.method, { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method, 'nova.request_id': store.requestId } }, parent)

    res.once('close', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      const completed = res.writableFinished
      const status = res.statusCode
      const route = routeTemplate(req)
      const tenantId = store.tenantId ?? withContext.tenantId
      const attributes = { method: req.method, route, status_class: statusClass(status) }

      recordHttpRequest(durationMs, attributes)

      span.updateName(`${req.method} ${route}`)
      span.setAttributes({ 'http.route': route, 'http.response.status_code': status, ...(tenantId ? { 'nova.tenant_id': tenantId } : {}) })
      if (status >= 500 || !completed) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()

      const level = status >= 500 || !completed ? 'error' : QUIET_ROUTES.has(route) ? 'debug' : status >= 400 ? 'warn' : 'info'
      log[level]({ event: 'http_request', method: req.method, route, status, durationMs: Math.round(durationMs * 10) / 10, ...(completed ? {} : { aborted: true }) }, 'http request')
    })

    requestLogStore.run(store, () => context.with(trace.setSpan(parent, span), next))
  }
}
