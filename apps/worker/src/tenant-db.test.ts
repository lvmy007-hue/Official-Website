import { describe, expect, it } from 'vitest'
import { resolveJobOwnership } from './tenant-db'

describe('后台任务的租户归属校验', () => {
  it('载荷里的租户与任务记录一致：放行', () => {
    expect(resolveJobOwnership('tenant-a', 'tenant-a')).toEqual({ ok: true, tenantId: 'tenant-a', legacy: false })
  })

  it('载荷声称的租户与任务记录不一致：拒绝，且不会改用载荷里的租户', () => {
    expect(resolveJobOwnership('tenant-b', 'tenant-a')).toEqual({ ok: false, reason: 'JOB_TENANT_MISMATCH' })
  })

  it('旧消息没有租户编号：按任务记录归属处理并标记为旧消息', () => {
    expect(resolveJobOwnership(undefined, 'tenant-a')).toEqual({ ok: true, tenantId: 'tenant-a', legacy: true })
  })

  it('任务记录不存在：返回找不到，由调用方安静跳过', () => {
    expect(resolveJobOwnership('tenant-a', undefined)).toEqual({ ok: false, reason: 'JOB_NOT_FOUND' })
    expect(resolveJobOwnership(undefined, null)).toEqual({ ok: false, reason: 'JOB_NOT_FOUND' })
  })

  it('空字符串的租户编号也算与记录不一致，不能蒙混过关', () => {
    expect(resolveJobOwnership('', 'tenant-a')).toEqual({ ok: false, reason: 'JOB_TENANT_MISMATCH' })
  })
})
