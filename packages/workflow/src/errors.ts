// 错误分类：可重试（网络抖动、限流、5xx、数据库瞬时故障）与不可重试（参数错误、权限、数据缺失、程序缺陷）。
// 12.3：不可重试的错误立刻进入失败/死信，重试只对可重试错误做指数退避。

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** 明确可重试：下次执行有机会成功。 */
export class RetryableError extends WorkflowError {
  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message, code, true, retryAfterMs)
  }
}

/** 明确不可重试：重试只会重复失败。 */
export class NonRetryableError extends WorkflowError {
  constructor(code: string, message: string) {
    super(message, code, false)
  }
}

/** 租约丢失：别的进程可能已接管，当前进程必须立刻停止写入；任务稍后重试即可。 */
export class LockLostError extends WorkflowError {
  constructor(lockKey: string) {
    super(`分布式锁 ${lockKey} 的租约已丢失，当前进程停止处理`, 'LOCK_LOST', true)
  }
}

export interface ErrorClassification {
  retryable: boolean
  code: string
  retryAfterMs?: number
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])
// Prisma 的瞬时错误：连接不上、连接超时、连接池耗尽、死锁/序列化冲突。
const TRANSIENT_DB_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'])

function readStatus(error: any): number | undefined {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.response?.statusCode]
  for (const value of candidates) if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function readRetryAfterMs(error: any): number | undefined {
  if (typeof error?.retryAfterMs === 'number') return error.retryAfterMs
  const headers = error?.headers ?? error?.response?.headers
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : (headers?.['retry-after'] ?? headers?.['Retry-After'])
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined
}

export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof WorkflowError) return { retryable: error.retryable, code: error.code, retryAfterMs: error.retryAfterMs }
  const anyError = error as any
  const status = readStatus(anyError)
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429) return { retryable: true, code: `HTTP_${status}`, retryAfterMs: readRetryAfterMs(anyError) }
    if (status >= 500 && status <= 599) return { retryable: true, code: `HTTP_${status}`, retryAfterMs: readRetryAfterMs(anyError) }
    if (status >= 400 && status <= 499) return { retryable: false, code: `HTTP_${status}` }
  }
  const code = typeof anyError?.code === 'string' ? anyError.code : undefined
  if (code && NETWORK_CODES.has(code)) return { retryable: true, code: `NETWORK_${code}` }
  if (code && TRANSIENT_DB_CODES.has(code)) return { retryable: true, code: `DB_${code}` }
  if (anyError?.name === 'AbortError' || anyError?.name === 'TimeoutError') return { retryable: true, code: 'TIMEOUT' }
  // 未识别的错误多半是程序缺陷或数据问题，重试没有意义；进入失败并保留现场供排查。
  return { retryable: false, code: 'UNEXPECTED_ERROR' }
}
