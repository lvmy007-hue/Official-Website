import { describe, expect, it, vi } from 'vitest'
import type { NotifyService } from '../notifications'
import { ApprovalsRegistryService, type ApprovalDb } from './approval-registry.service'

// 审批登记与回写（P6-27）：审批人 = 有该权限的在职成员去掉发起人；同一对象已有待处理的只更新；回写只动待处理的。
// 真实数据库下的完整流程在 testing/approvals.db.test.ts。

const notify = (holders: string[]) => ({ holdersOf: vi.fn().mockResolvedValue(holders) }) as unknown as NotifyService
const dbOf = (pending: { id: string } | null = null) => {
  const approvalRequest = {
    findFirst: vi.fn().mockResolvedValue(pending),
    create: vi.fn().mockResolvedValue({ id: 'new-1' }),
    update: vi.fn().mockResolvedValue({ id: 'old-1' }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  }
  return { approvalRequest, db: { approvalRequest } as unknown as ApprovalDb }
}
const INPUT = {
  tenantId: 't1',
  type: 'FINANCE_POLICY',
  objectType: 'FinancePolicyVersion',
  objectId: 'v1',
  title: '财务口径变更：第 2 版',
  summary: [{ label: '原因', value: '改口径' }],
  requesterId: 'u-maker',
  approverPermission: 'finance.policy.write',
} as const

describe('登记', () => {
  it('审批人排除发起人；抄送不与审批人、发起人重复；标题截断到 200 字', async () => {
    const { approvalRequest, db } = dbOf()
    const service = new ApprovalsRegistryService(notify(['u-maker', 'u-a', 'u-b']))
    expect(await service.register(db, { ...INPUT, title: 'x'.repeat(300), ccIds: ['u-a', 'u-c', 'u-maker', 'u-c'] })).toEqual({ id: 'new-1' })
    const data = approvalRequest.create.mock.calls[0]![0].data
    expect(data).toMatchObject({ tenantId: 't1', type: 'FINANCE_POLICY', objectId: 'v1', requesterId: 'u-maker', approverIds: ['u-a', 'u-b'], ccIds: ['u-c'] })
    expect(data.title).toHaveLength(200)
    expect(approvalRequest.findFirst.mock.calls[0]![0].where).toMatchObject({ status: 'PENDING', objectId: 'v1' })
  })

  it('没有其他审批人时审批人为空（页面据此提示联系管理员），不报错', async () => {
    const { approvalRequest, db } = dbOf()
    await new ApprovalsRegistryService(notify(['u-maker'])).register(db, INPUT)
    expect(approvalRequest.create.mock.calls[0]![0].data.approverIds).toEqual([])
  })

  it('同一对象已有待处理的审批：更新内容与审批人并推进版本，不新建', async () => {
    const { approvalRequest, db } = dbOf({ id: 'old-1' })
    expect(await new ApprovalsRegistryService(notify(['u-a'])).register(db, INPUT)).toEqual({ id: 'old-1' })
    expect(approvalRequest.create).not.toHaveBeenCalled()
    expect(approvalRequest.update.mock.calls[0]![0]).toMatchObject({ where: { id: 'old-1' }, data: { approverIds: ['u-a'], version: { increment: 1 } } })
  })

  it('审批人最多登记 50 人', async () => {
    const { approvalRequest, db } = dbOf()
    await new ApprovalsRegistryService(notify(Array.from({ length: 80 }, (_, index) => `u-${index}`))).register(db, INPUT)
    expect(approvalRequest.create.mock.calls[0]![0].data.approverIds).toHaveLength(50)
  })
})

describe('回写', () => {
  it('只改待处理的那条：写处理人、时间、意见并推进版本；返回改了几条（旧单据没登记时为 0）', async () => {
    const { approvalRequest, db } = dbOf()
    const now = new Date('2026-10-28T00:00:00Z')
    const service = new ApprovalsRegistryService(notify([]))
    expect(await service.resolve(db, { tenantId: 't1', type: 'FINANCE_POLICY', objectType: 'FinancePolicyVersion', objectId: 'v1', outcome: 'APPROVED', userId: 'u-a', comment: '同意', now })).toBe(1)
    expect(approvalRequest.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { tenantId: 't1', type: 'FINANCE_POLICY', objectId: 'v1', status: 'PENDING' },
      data: { status: 'APPROVED', decidedBy: 'u-a', decidedAt: now, comment: '同意', version: { increment: 1 } },
    })
    approvalRequest.updateMany.mockResolvedValue({ count: 0 })
    expect(await service.resolve(db, { tenantId: 't1', type: 'PERIOD_CLOSE', objectType: 'AccountingPeriod', objectId: 'p1', outcome: 'CANCELLED', userId: 'u-a' })).toBe(0)
    expect(approvalRequest.updateMany.mock.calls[1]![0].data.comment).toBeNull()
  })
})
