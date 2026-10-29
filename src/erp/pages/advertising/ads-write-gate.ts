import type { AdsWriteKind, AdsWriteStatusResponse } from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'

// 批量写入的开关闸门（P6-23）：批量操作栏里的写入按钮要和服务端开关一致——开关关着就置灰并写明原因，而不是点开表单再被拒绝。
// 数据来自 GET /ads/writes 的 kinds（每类写入的权限与开关）；还没读到、读取失败时也不放行，原因写在提示里。提交时服务端仍会再判断一次。
// 只在勾选后出现的批量栏里使用（栏没出现就不请求）。

export type WriteGate = { ok: boolean; reason: string }

export function useWriteGate(): (kind: AdsWriteKind, base?: WriteGate) => WriteGate {
  const query = useApiQuery<AdsWriteStatusResponse>({ domain: 'analytics', path: '/ads/writes' })
  return (kind, base = { ok: true, reason: '' }) => {
    if (!base.ok) return base
    if (query.error) return { ok: false, reason: '写入开关读取失败，暂时不能提交；请刷新页面重试' }
    if (!query.data) return { ok: false, reason: '正在读取写入开关' }
    const entry = query.data.kinds.find(item => item.kind === kind)
    if (!entry) return { ok: false, reason: '这类写入暂未开放' }
    if (!entry.switchEnabled) return { ok: false, reason: entry.reason ?? `${entry.label}的写入开关未开启（默认只读，需管理员在广告写入设置里开启）` }
    return { ok: true, reason: '' }
  }
}
