import { WorkflowError, classifyError, type ErrorClassification } from '@nova/workflow'
import { UpstreamHttpError } from '../connectors/http-error'

// 失败码（freeze/importers.md 0.3）：把底层错误翻译成页面可按码显示中文原因的失败码。
// 能识别的映射成通用失败码；其余保留错误自带的码或信息（截断），由各来源在连接器升级（P1-26）时逐步收敛为专属失败码。

export interface FailureInfo extends ErrorClassification {
  /** 写入 SyncJob.failureCode 的失败码。 */
  failureCode: string
}

/** 错误分类码 → 通用失败码；不认识返回 null。 */
function commonFailureCode(code: string, exhausted: boolean): string | null {
  if (code === 'HTTP_429' || code === 'RATE_LIMIT_WAIT_EXCEEDED') return exhausted ? 'THROTTLE_EXHAUSTED' : 'THROTTLED'
  if (code === 'HTTP_401') return 'AUTH_EXPIRED'
  if (code === 'HTTP_403') return 'ROLE_MISSING'
  if (code === 'HTTP_408' || code === 'HTTP_425' || /^HTTP_5\d\d$/.test(code) || code.startsWith('NETWORK_') || code.startsWith('DB_') || code === 'TIMEOUT') return 'UPSTREAM_ERROR'
  if (code === 'LOCK_LOST') return 'LOCK_LOST'
  return null
}

export function describeFailure(error: unknown, exhausted: boolean): FailureInfo {
  const info = classifyError(error)
  // 授权服务拒绝刷新令牌（400/401）：授权已失效，重试没有意义。
  if (error instanceof UpstreamHttpError && error.source === 'lwa' && (error.status === 400 || error.status === 401)) return { ...info, retryable: false, failureCode: 'AUTH_EXPIRED' }
  const common = commonFailureCode(info.code, exhausted)
  if (common) return { ...info, failureCode: common }
  if (error instanceof WorkflowError) return { ...info, failureCode: info.code }
  return { ...info, failureCode: error instanceof Error ? error.message.slice(0, 120) : 'CONNECTOR_FAILED' }
}
