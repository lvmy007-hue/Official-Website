import { context, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkerLogger, REDACTED } from './logger'
import { runInJobTrace } from './tracing'

describe('后台任务结构化日志', () => {
  it('敏感字段被替换，买家信息与令牌不出现在日志里', () => {
    const lines: string[] = []
    const log = createWorkerLogger(
      {
        write: chunk => {
          lines.push(chunk)
        },
      },
      'info',
    )
    log.info({ jobId: 'j1', requestId: 'req-1', tenantId: 't1', order: { buyerEmail: 'a@b.com', shippingAddress: '某街 1 号' }, connection: { encryptedRefreshToken: 'enc-xyz' } }, 'import')
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({ service: 'nova-worker', jobId: 'j1', requestId: 'req-1', tenantId: 't1' })
    expect(entry.order.buyerEmail).toBe(REDACTED)
    expect(entry.order.shippingAddress).toBe(REDACTED)
    expect(entry.connection.encryptedRefreshToken).toBe(REDACTED)
    for (const secret of ['a@b.com', '某街', 'enc-xyz']) expect(lines.join('')).not.toContain(secret)
  })
})

describe('后台任务链路', () => {
  const spans = new InMemorySpanExporter()
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }))
  })
  afterAll(() => {
    trace.disable()
    propagation.disable()
    context.disable()
  })

  it('接上入队时带来的链路', async () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    await runInJobTrace('sync', traceparent, { 'nova.request_id': 'req-1' }, async () => 'done')
    const span = spans.getFinishedSpans().find(item => item.name === 'sync')!
    expect(span.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(span.parentSpanContext?.spanId).toBe('b7ad6b7169203331')
    expect(span.attributes['nova.request_id']).toBe('req-1')
  })

  it('任务失败时记录异常并继续抛出', async () => {
    await expect(
      runInJobTrace('derive', undefined, {}, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const span = spans.getFinishedSpans().find(item => item.name === 'derive')!
    expect(span.status.code).toBe(2)
    expect(span.events.some(event => event.name === 'exception')).toBe(true)
  })
})
