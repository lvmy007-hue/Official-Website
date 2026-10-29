import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common'
import { ERROR_CODES, installLegacyZodMessages, type ApiErrorBody, type ErrorCode, type TenantLifecycleStatus } from '@nova/api-contracts'
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { ZodError } from 'zod'

// zod 4 的默认校验文案与 zod 3 不同；422 的 fieldErrors 文案对调用方保持不变（X-01）。必须由契约包自己的 zod 实例注册。
installLegacyZodMessages()

/** 访问模式：正常登录、内部直连（P1-18）、平台支持访问。写入审计时标注。 */
export type AccessMode = 'NORMAL' | 'INTERNAL_DIRECT' | 'SUPPORT'

export type RequestWithContext = Request & {
  requestId: string
  user?: { userId: string; sessionId: string }
  tenantId?: string
  /** 同一请求内缓存的上下文，避免拦截器与领域服务重复解析 */
  apiContext?: ApiContext
  accessMode?: AccessMode
  /** 支持访问（accessMode 为 SUPPORT）时的授权信息：哪位平台人员、哪条授权、哪个企业（P1-19） */
  support?: { adminId: string; accessId: string; tenantId: string }
  /** 领域服务已写入业务审计时置位，拦截器据此不再补写通用审计 */
  auditRecorded?: boolean
  /** 本次请求使用的再次验证记录（写入审计） */
  stepUpId?: string
  /** 异步写入流程编号（P1-20 起填充，写入审计） */
  writeRunId?: string
}

export type ApiContext = {
  userId: string
  sessionId: string
  tenantId: string
  membershipId: string
  permissions: string[]
  accessMode?: AccessMode
  /** 企业生命周期状态（P1-19）；暂停时只读，内部访问等没有成员关系的路径不带 */
  lifecycleStatus?: TenantLifecycleStatus
}

export type ResponseSource = 'database' | 'cache' | 'external' | 'fixture'

export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly details?: ApiErrorBody['details'],
  ) {
    super({ code, message, retryable, fieldErrors, details }, status)
  }
}

/** 按统一错误码目录创建错误：状态码与是否可重试取目录默认值，可覆盖。 */
export function appError(code: ErrorCode, message: string, options: { status?: number; retryable?: boolean; fieldErrors?: Record<string, string[]>; details?: ApiErrorBody['details'] } = {}) {
  const spec = ERROR_CODES[code]
  return new AppError(options.status ?? spec.status, code, message, options.retryable ?? spec.retryable, options.fieldErrors, options.details)
}

/** 幂等重放：拦截器抛出，由异常过滤器原样返回首次结果（状态码与响应体）。 */
export class IdempotentReplay {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {}
}

export function ensureRequestId(req: RequestWithContext): string {
  const incoming = req.header('x-request-id')
  req.requestId = incoming && /^[a-zA-Z0-9._-]{8,100}$/.test(incoming) ? incoming : `req_${randomUUID()}`
  return req.requestId
}

export function requestIdMiddleware(req: Request, _res: Response, next: () => void) {
  ensureRequestId(req as RequestWithContext)
  next()
}

export function ok<T>(data: T, req: RequestWithContext, source: ResponseSource = 'database') {
  return { success: true as const, data, meta: { requestId: req.requestId, serverTime: new Date().toISOString(), source } }
}

// 共享契约包与接口服务可能各带一份 zod，实例判断会漏判，所以同时按名称与结构识别。
function isZodError(value: unknown): value is ZodError {
  if (value instanceof ZodError) return true
  const candidate = value as { name?: unknown; issues?: unknown; flatten?: unknown } | null
  return Boolean(candidate && candidate.name === 'ZodError' && Array.isArray(candidate.issues) && typeof candidate.flatten === 'function')
}

/** 与异常过滤器一致的状态码判定：拦截器用它判断“被拒绝”还是“服务端失败”。 */
export function errorStatus(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus()
  if (isZodError(exception)) return 422
  return 500
}

// 框架自身的“路径不存在、请求体过大”等异常，对外只给固定的中文说明，不回显框架原文。
const FRAMEWORK_MESSAGES: Record<number, string> = {
  404: '请求的接口不存在',
  405: '该接口不支持此请求方法',
  413: '请求体超过上限',
  415: '请求内容类型不受支持',
}

// 框架自身抛出的 HTTP 异常（路径不存在、请求体过大等）也映射到统一错误码。
function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST'
    case 401:
      return 'AUTH_REQUIRED'
    case 403:
      return 'TENANT_ACCESS_DENIED'
    case 404:
      return 'ROUTE_NOT_FOUND'
    case 405:
      return 'METHOD_NOT_ALLOWED'
    case 413:
      return 'REQUEST_BODY_TOO_LARGE'
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE'
    case 429:
      return 'RATE_LIMITED'
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED'
  }
}

/** PostgreSQL 因 statement_timeout 取消语句（SQLSTATE 57014）。 */
export function isStatementTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const meta = (error as { meta?: { code?: string; message?: string } }).meta
  return meta?.code === '57014' || /canceling statement due to statement timeout|\b57014\b/i.test(`${error.message} ${meta?.message ?? ''}`)
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    const request = host.switchToHttp().getRequest<RequestWithContext>()
    const requestId = request.requestId ?? ensureRequestId(request)

    if (exception instanceof IdempotentReplay) {
      response.setHeader('Idempotency-Replayed', 'true')
      response.status(exception.status).json(exception.body)
      return
    }

    let status = 500
    let code: string = 'INTERNAL_ERROR'
    let message = '服务暂时无法完成请求，提供 Request ID 供排查'
    let retryable = false
    let fieldErrors: Record<string, string[]> | undefined
    let details: ApiErrorBody['details'] | undefined

    if (exception instanceof AppError) {
      status = exception.getStatus()
      code = exception.code
      retryable = exception.retryable
      const payload = exception.getResponse() as { message?: string; fieldErrors?: Record<string, string[]> }
      message = payload.message ?? message
      fieldErrors = payload.fieldErrors
      details = exception.details
    } else if (isZodError(exception)) {
      status = 422
      code = 'VALIDATION_FAILED'
      message = '请求参数校验失败，请检查输入'
      fieldErrors = exception.flatten().fieldErrors as Record<string, string[]>
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      const payload = exception.getResponse()
      if (typeof payload === 'object' && payload && 'message' in payload) message = String((payload as { message: unknown }).message)
      code = codeForHttpStatus(status)
      if (FRAMEWORK_MESSAGES[status]) message = FRAMEWORK_MESSAGES[status]
      retryable = ERROR_CODES[code as ErrorCode]?.retryable ?? false
    } else if (isStatementTimeout(exception)) {
      // 数据库按语句超时取消了查询（P1-25）：对调用方是可重试的“查询过慢”，不暴露内部细节
      status = 504
      code = 'QUERY_TIMEOUT'
      message = '查询耗时过长被终止，请缩小筛选范围后重试'
      retryable = true
    } else if (process.env.APP_MODE === 'development' && exception instanceof Error) {
      // 只有明确的开发模式才把原始错误信息返回给调用方；预发布、测试与生产一律不泄露内部细节（P1-17）
      message = exception.message
    }

    response.status(status).json({
      success: false,
      error: { code, message, requestId, retryable, ...(fieldErrors ? { fieldErrors } : {}), ...(details ? { details } : {}) },
    })
  }
}
