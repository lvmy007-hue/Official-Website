import type { ErrorInfo } from '../../query/errors'
import type { DataStateProps } from './DataState'

/**
 * 把请求错误翻译成对应的数据状态：403 → 无权限；查询超时与服务端错误 → 服务端错误（带请求编号与重试）。
 * 无权限状态需要知道缺哪个权限点：以服务端在 details.permission 里报告的为准，没有时用页面传入的。
 */
export function stateFromError(info: ErrorInfo, options: { permission?: string; onRetry?: () => void } = {}): DataStateProps {
  if (info.kind === 'forbidden') {
    const reported = typeof info.details?.permission === 'string' ? info.details.permission : undefined
    return { kind: 'forbidden', permission: reported ?? options.permission ?? info.code ?? '未知权限' }
  }
  const timeoutHint = info.kind === 'timeout' ? '查询耗时过长，请缩小时间范围或筛选条件后重试。' : undefined
  return { kind: 'server-error', message: timeoutHint ?? info.message, errorCode: info.code, requestId: info.requestId, onRetry: options.onRetry }
}
