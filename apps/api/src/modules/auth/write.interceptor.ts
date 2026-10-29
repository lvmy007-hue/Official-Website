import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { IDEMPOTENCY_HEADER, IdempotencyKeySchema } from '@nova/api-contracts'
import type { Response } from 'express'
import { Observable, catchError, from, mergeMap, switchMap, throwError } from 'rxjs'
import { ContextService } from './context.service'
import { ApiContext, AppError, IdempotentReplay, RequestWithContext, appError, errorStatus } from '../../platform/http'
import { logger } from '../../platform/observability'
import { AuditWriter } from '../../platform/write/audit-writer.service'
import { IdempotencyService, requestFingerprint } from '../../platform/write/idempotency.service'
import { StepUpService } from '../../platform/write/step-up.service'
import { WRITE_META, type WriteMeta, type WriteOptions } from '../../platform/write/write.decorator'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

interface WriteState {
  context?: ApiContext
  recordId?: string
  // 业务处理与审计全部结束后才放行响应（用 @Res 直接发送的接口也一样），保证客户端收到响应时审计已落库
  settled: Promise<void>
  markSettled: () => void
}

export function routeTemplate(req: RequestWithContext): string {
  const path = req.route && typeof req.route.path === 'string' ? req.route.path : req.path
  return `${req.baseUrl ?? ''}${path}`
}

const resourceTypeOf = (execution: ExecutionContext) => execution.getClass().name.replace(/Controller$/, '') || 'Unknown'

// 写接口拦截器：所有 POST/PUT/PATCH/DELETE 都经过这里（全局注册）。
//   权限预检 → 再次验证身份 → 幂等键去重 → 业务处理 → 审计（成功补写通用审计；被拒绝与服务端失败也记录）。
// 声明方式见 write.decorator.ts；静态检查测试保证每个写接口都做了声明，不会有漏网的写接口。
@Injectable()
export class WriteInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: ContextService,
    private readonly idempotency: IdempotencyService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditWriter,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execution.getType() !== 'http') return next.handle()
    const http = execution.switchToHttp()
    const req = http.getRequest<RequestWithContext>()
    if (SAFE_METHODS.has(req.method)) return next.handle()
    const declared = this.reflector.getAllAndOverride<WriteMeta | undefined>(WRITE_META, [execution.getHandler(), execution.getClass()])
    if (declared?.kind === 'exempt') return next.handle()
    // 没有声明的写接口：按最严格的默认处理（要求幂等键、补写通用审计）；静态检查测试会把它当作缺陷报出来
    const options: WriteOptions = declared?.kind === 'write' ? declared : { action: `${req.method}_${routeTemplate(req)}`, resourceType: resourceTypeOf(execution) }
    const res = http.getResponse<Response>()
    let markSettled: () => void = () => undefined
    const settled = new Promise<void>(resolve => {
      markSettled = resolve
    })
    const state: WriteState = { settled, markSettled }

    return from(this.prepare(req, res, options, state)).pipe(
      switchMap(() =>
        next.handle().pipe(
          mergeMap(async value => {
            try {
              await this.succeeded(req, options, state)
            } finally {
              state.markSettled()
            }
            return value
          }),
        ),
      ),
      catchError(error => from(this.failed(req, options, state, error).finally(() => state.markSettled())).pipe(mergeMap(() => throwError(() => error)))),
    )
  }

  private async prepare(req: RequestWithContext, res: Response, options: WriteOptions, state: WriteState) {
    // 公开接口（没有登录态）不参与幂等与审计，必须用 WriteExempt 显式声明
    if (!req.user) return
    state.context = await this.contexts.resolve(req)
    if (options.permission) this.contexts.require(state.context, options.permission)
    if (options.stepUp) req.stepUpId = await this.stepUp.require(state.context, options.stepUp)

    const rawKey = req.header(IDEMPOTENCY_HEADER)
    if (!rawKey) throw appError('IDEMPOTENCY_KEY_REQUIRED', '写操作必须携带 Idempotency-Key 请求头（建议每次操作生成一个随机 UUID）')
    const parsedKey = IdempotencyKeySchema.safeParse(rawKey)
    if (!parsedKey.success) throw appError('IDEMPOTENCY_KEY_INVALID', parsedKey.error.issues[0]?.message ?? '幂等键格式不合法')

    this.idempotency.purgeOpportunistically()
    const route = `${req.method} ${routeTemplate(req)}`
    const hash = requestFingerprint({ method: req.method, route, params: req.params, query: req.query, body: req.body })
    const begun = await this.idempotency.begin(state.context.tenantId, parsedKey.data, route, hash)
    if (begun.state === 'replay') throw new IdempotentReplay(begun.status, begun.body)
    state.recordId = begun.recordId
    this.captureResponse(res, state.recordId, state.settled, options.sensitiveResponse === true)
  }

  // 在响应发出之前保存首次结果（成功保存，失败释放，使客户端修正后可用同一个键重试）。
  // 同时适用于“返回值”与“直接用 @Res 发送”两种写法。
  // sensitive：响应里含一次性机密（绑定密钥、恢复码），数据库里只保存占位说明，重复提交拿到的是占位而不是机密。
  private captureResponse(res: Response, recordId: string, settled: Promise<void>, sensitive = false) {
    const original = res.json.bind(res) as (body?: unknown) => Response
    res.json = ((body?: unknown) => {
      const status = res.statusCode
      const stored = sensitive ? { success: true, data: { redacted: true, message: '该操作的结果含一次性机密信息，只在首次响应中返回，重复提交不再返回' } } : body
      const settle = status < 300 ? this.idempotency.complete(recordId, status, stored) : this.idempotency.release(recordId)
      void settle
        .catch(error => logger.warn({ event: 'idempotency_store_failed', recordId, err: error instanceof Error ? error.message : String(error) }, '幂等结果保存失败'))
        .then(() => settled)
        .finally(() => original(body))
      return res
    }) as Response['json']
  }

  private async succeeded(req: RequestWithContext, options: WriteOptions, state: WriteState) {
    if (!state.context || req.auditRecorded || options.audit === false) return
    const body = req.body as { reason?: unknown } | undefined
    await this.audit.recordQuietly(
      req,
      {
        action: options.action,
        resourceType: options.resourceType,
        resourceId: typeof req.params?.id === 'string' ? req.params.id : undefined,
        reason: typeof body?.reason === 'string' ? body.reason : undefined,
        detail: { route: `${req.method} ${routeTemplate(req)}` },
      },
      state.context,
    )
  }

  private async failed(req: RequestWithContext, options: WriteOptions, state: WriteState, error: unknown) {
    if (error instanceof IdempotentReplay) return
    if (state.recordId) await this.idempotency.release(state.recordId).catch(() => undefined)
    if (!state.context || options.audit === false) return
    const status = errorStatus(error)
    const code = error instanceof AppError ? error.code : undefined
    // 请求格式类错误（缺幂等键、校验失败等）没有改变任何数据，不进审计；被拒绝的和服务端失败的要留痕
    const result = status === 403 ? 'DENIED' : status >= 500 ? 'FAILED' : undefined
    if (!result || (code && code.startsWith('IDEMPOTENCY_'))) return
    await this.audit.recordQuietly(
      req,
      {
        action: options.action,
        resourceType: options.resourceType,
        resourceId: typeof req.params?.id === 'string' ? req.params.id : undefined,
        result,
        detail: { route: `${req.method} ${routeTemplate(req)}`, status, ...(code ? { errorCode: code } : {}) },
      },
      state.context,
    )
  }
}
