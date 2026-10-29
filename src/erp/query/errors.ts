import { ApiError } from '../../api'

// 统一错误处理（P1-06）：把各种失败归成页面能直接用的几类，页面据此选择“服务端错误 / 无权限 / 延迟”等状态。

export type ErrorKind =
  /** 登录失效（刷新也失败）。 */
  | 'unauthorized'
  /** 没有权限。 */
  | 'forbidden'
  /** 对象不存在。 */
  | 'not-found'
  /** 版本冲突（别人刚改过）。 */
  | 'conflict'
  /** 参数不合法（带字段级错误）。 */
  | 'validation'
  /** 查询耗时过长被终止。 */
  | 'timeout'
  /** 触发限流。 */
  | 'rate-limited'
  /** 服务端错误。 */
  | 'server'
  /** 网络不通。 */
  | 'network'
  | 'unknown'

export type ErrorInfo = {
  kind: ErrorKind
  message: string
  /** 服务端统一错误码，例如 FORBIDDEN、QUERY_TIMEOUT。 */
  code?: string
  /** 请求编号：用户报障时提供，便于定位日志。 */
  requestId?: string
  retryable: boolean
  fieldErrors?: Record<string, string[]>
  /** 服务端附带的补充信息；403 无权限时含 permission（缺的权限点）。 */
  details?: Record<string, string | number | boolean | null>
}

function kindOf(status: number, code?: string): ErrorKind {
  if (code === 'QUERY_TIMEOUT') return 'timeout'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 422 || status === 400) return 'validation'
  if (status === 429) return 'rate-limited'
  if (status === 504) return 'timeout'
  if (status >= 500) return 'server'
  return 'unknown'
}

/** 把任意异常整理成统一的错误信息。 */
export function describeError(error: unknown): ErrorInfo {
  if (error instanceof ApiError) {
    const kind = kindOf(error.status, error.code)
    const retryable = error.extra.retryable ?? (kind === 'server' || kind === 'timeout' || kind === 'rate-limited')
    return { kind, message: error.message, code: error.code, requestId: error.extra.requestId, retryable, fieldErrors: error.extra.fieldErrors, ...(error.details ? { details: error.details } : {}) }
  }
  // 浏览器的 fetch 在断网、跨域、被拦截时抛 TypeError
  if (error instanceof TypeError) return { kind: 'network', message: '网络连接失败，请检查网络后重试', retryable: true }
  if (error instanceof Error) return { kind: 'unknown', message: error.message, retryable: false }
  return { kind: 'unknown', message: '发生未知错误', retryable: false }
}

/** 是否值得自动重试：只重试网络抖动、限流与服务端临时故障，4xx 一律不重试。 */
export function shouldRetry(error: unknown, attempt: number, max = 2): boolean {
  if (attempt >= max) return false
  const info = describeError(error)
  // 查询超时要先缩小范围，自动重试只会再次拖垮数据库
  if (info.kind === 'timeout') return false
  return info.kind === 'network' || info.kind === 'server' || info.kind === 'rate-limited'
}
