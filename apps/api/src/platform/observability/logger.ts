import type { LoggerService } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'
import { PII_REDACT_KEYS } from '@nova/api-contracts'
import pino, { type DestinationStream, type Logger } from 'pino'

// 结构化日志（P1-29，12 章 12.6 第 9 条）：每行一个 JSON，自动带请求编号与租户编号，不含个人信息。
// 做法：请求入口把编号放进 AsyncLocalStorage，日志输出时自动取出；敏感字段名在输出前统一替换。

export interface RequestLogContext {
  requestId: string
  tenantId?: string
  userId?: string
}

export const requestLogStore = new AsyncLocalStorage<RequestLogContext>()

/** 租户确定之后绑定到当前请求，此后该请求内的全部日志都会带上租户编号。 */
export function bindTenant(tenantId: string, userId?: string) {
  const store = requestLogStore.getStore()
  if (!store) return
  store.tenantId = tenantId
  if (userId) store.userId = userId
}

// 这些字段名一旦出现在日志对象的前三层，其值会被替换。买家信息、联系方式、令牌与密钥永远不进日志。
export const SENSITIVE_LOG_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'authorization',
  'cookie',
  'setCookie',
  'secret',
  'clientSecret',
  'apiKey',
  'signature',
  'encryptedRefreshToken',
  'refreshTokenHash',
  'email',
  'phone',
  'contactEmail',
  'contactPhone',
  'buyerName',
  'buyerEmail',
  'buyerPhone',
  'shippingAddress',
  'address',
  'piiCiphertext',
] as const

export const REDACTED = '[已隐藏]'

/** 实际脱敏的字段名：上面的清单加上个人信息守卫（P6-14）约定的全部个人信息字段名，两边不会漂移。 */
export const LOG_REDACT_KEYS: readonly string[] = [...new Set<string>([...SENSITIVE_LOG_KEYS, ...PII_REDACT_KEYS])]

const redactPaths = LOG_REDACT_KEYS.flatMap(key => [key, `*.${key}`, `*.*.${key}`])

export function createLogger(destination?: DestinationStream, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino(
    {
      level,
      base: { service: 'nova-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: redactPaths, censor: REDACTED },
      mixin() {
        const store = requestLogStore.getStore()
        return store ? { requestId: store.requestId, ...(store.tenantId ? { tenantId: store.tenantId } : {}), ...(store.userId ? { userId: store.userId } : {}) } : {}
      },
    },
    destination,
  )
}

export const logger = createLogger()

type NestLevel = 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal'

/** 让框架自带的日志（启动、路由、异常）也走同一个输出，格式一致。 */
export class StructuredNestLogger implements LoggerService {
  constructor(private readonly target: Logger = logger) {}

  private emit(level: NestLevel, message: unknown, params: unknown[]) {
    const last = params.length > 0 ? params[params.length - 1] : undefined
    const context = typeof last === 'string' ? last : undefined
    const stack = level === 'error' && params.length > 1 && typeof params[0] === 'string' ? params[0] : undefined
    const fields = message && typeof message === 'object' ? { ...(message as Record<string, unknown>) } : {}
    const text = message && typeof message === 'object' ? String((message as { event?: unknown }).event ?? 'log') : String(message)
    this.target[level]({ ...fields, ...(context ? { context } : {}), ...(stack ? { stack } : {}) }, text)
  }

  log(message: unknown, ...params: unknown[]) {
    this.emit('info', message, params)
  }
  error(message: unknown, ...params: unknown[]) {
    this.emit('error', message, params)
  }
  warn(message: unknown, ...params: unknown[]) {
    this.emit('warn', message, params)
  }
  debug(message: unknown, ...params: unknown[]) {
    this.emit('debug', message, params)
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.emit('trace', message, params)
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.emit('fatal', message, params)
  }
}
