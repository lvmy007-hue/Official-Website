import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { passedChecklist, periodRow, periodsPrisma, snapshotRow, type PeriodsStubOptions } from '../../testing/periods-stub'

// 期间关账的锁定与重新开账（P2b-13）：再次验证身份、权限、审批前不能锁定、锁定前复查、快照与汇率锁定、第二次锁定的差异报告、重新开账与汇率锁回。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], options: PeriodsStubOptions = {}) => {
  await harness?.close()
  const prisma = periodsPrisma(permissions, options)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const CLOSER = ['finance.read', 'finance.period.close', 'field.profit', 'field.cost']
const ADMIN = [...CLOSER, 'finance.period.reopen']
const approved = (over: Record<string, unknown> = {}) =>
  periodRow({ status: 'CLOSING', version: 4, checkedBy: 'user-2', approvalDecision: 'APPROVED', approvedBy: 'user-3', checklistJson: passedChecklist, ...over })
const audit = (prisma: Awaited<ReturnType<typeof open>>['prisma']) => prisma.auditEvent.create.mock.calls.map(([args]) => args.data)

describe('锁定', () => {
  it('必须再次验证身份；没有权限 403；都不写库', async () => {
    const { call, prisma } = await open(CLOSER, { period: approved() })
    prisma.stepUpVerification.findFirst.mockResolvedValue(null)
    const noStepUp = await call('POST', '/finance/periods/p1/close', { body: { version: 4 } })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(prisma.stepUpVerification.findFirst.mock.calls[0]![0].where).toMatchObject({ action: 'finance.period.close' })
    const denied = await open(['finance.read'], { period: approved() })
    expect((await denied.call('POST', '/finance/periods/p1/close', { body: { version: 4 } })).status).toBe(403)
    for (const item of [prisma, denied.prisma]) {
      expect(item.accountingPeriod.updateMany).not.toHaveBeenCalled()
      expect(item.periodSnapshot.create).not.toHaveBeenCalled()
      expect(item.fxRate.updateMany).not.toHaveBeenCalled()
    }
  })

  it('审批之前不能锁定；不是关账中不能锁定；版本号过期 409；缺版本号 422', async () => {
    const unapproved = await open(CLOSER, { period: approved({ approvalDecision: null, approvedBy: null }) })
    const res = await unapproved.call('POST', '/finance/periods/p1/close', { body: { version: 4 } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('审批')
    const opened = await open(CLOSER, { period: periodRow() })
    expect((await opened.call('POST', '/finance/periods/p1/close', { body: { version: 1 } })).status).toBe(409)
    const stale = await open(CLOSER, { period: approved() })
    expect((await stale.call('POST', '/finance/periods/p1/close', { body: { version: 3 } })).status).toBe(409)
    expect((await stale.call('POST', '/finance/periods/p1/close', { body: {} })).status).toBe(422)
    for (const item of [unapproved.prisma, opened.prisma, stale.prisma]) expect(item.periodSnapshot.create).not.toHaveBeenCalled()
  })

  it('第一次锁定：已关账、写入一份修订 1 的快照（利润、汇率、成本版本）、锁定期间内的汇率、写审计，没有差异报告', async () => {
    const { call, prisma } = await open(CLOSER, { period: approved() })
    const res = await call('POST', '/finance/periods/p1/close', { body: { version: 4 } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'p1', status: 'CLOSED', statusLabel: '已关账', revision: 1, fxLocked: 31 })
    const update = prisma.accountingPeriod.updateMany.mock.calls[0]![0]
    expect(update.where).toMatchObject({ id: 'p1', tenantId: 'tenant-1', version: 4 })
    expect(update.data).toMatchObject({ status: 'CLOSED', closedBy: 'user-1', closeCount: { increment: 1 }, version: { increment: 1 } })
    const snapshot = prisma.periodSnapshot.create.mock.calls[0]![0].data
    expect(snapshot).toMatchObject({ tenantId: 'tenant-1', periodId: 'p1', revision: 1, lockedBy: 'user-1' })
    expect(snapshot.diffJson).toBeUndefined()
    expect(snapshot.profitSnapshotJson.bases.ORDERED.totals).toMatchObject({ revenue: 1000, profit: 400, rows: 5, incompleteRows: 0 })
    expect(snapshot.profitSnapshotJson.bases.ORDERED.skus).toMatchObject([{ sku: 'A', asin: 'B0TEST', revenue: 1000 }])
    expect(snapshot.fxSnapshotJson).toMatchObject({ currencies: ['CNY'], from: '2025-03-01', to: '2025-03-31' })
    expect(snapshot.costVersionSnapshotJson).toMatchObject({ versions: [], skuCount: 0 })
    // P6-19：关账快照记录期间内每个月适用的分摊规则版本（没有规则时每月为空列表）
    expect(snapshot.metricVersionSnapshotJson).toMatchObject({
      allocationRules: { months: expect.any(Object) },
      profitFormula: { versionNo: 0, source: 'DEFAULT' },
      businessRules: { versionNo: 0, source: 'DEFAULT' },
      profitDictionary: expect.any(Object),
    })
    const lock = prisma.fxRate.updateMany.mock.calls[0]![0]
    expect(lock.where).toMatchObject({ tenantId: 'tenant-1', lockedByPeriodId: null })
    expect(lock.where.rateDate.gte.toISOString()).toBe('2025-03-01T00:00:00.000Z')
    expect(lock.where.rateDate.lte.toISOString()).toBe('2025-03-31T00:00:00.000Z')
    expect(lock.data).toEqual({ lockedByPeriodId: 'p1' })
    expect(audit(prisma).find(item => item.action === 'PERIOD_CLOSED')).toMatchObject({ resourceId: 'p1', detail: { revision: 1, fxLocked: 31, hasDiff: null } })
  })

  it('第二次锁定：修订 2，并和上一份快照比较，差异报告随快照一起保存', async () => {
    const { call, prisma } = await open(CLOSER, { period: approved({ closeCount: 1 }) })
    prisma.periodSnapshot.findFirst.mockResolvedValue(snapshotRow(777, 1))
    const res = await call('POST', '/finance/periods/p1/close', { body: { version: 4 } })
    expect(res.json.data).toMatchObject({ status: 'CLOSED', revision: 2 })
    expect(prisma.periodSnapshot.findFirst.mock.calls[0]![0].where).toMatchObject({ periodId: 'p1', revision: 1 })
    const snapshot = prisma.periodSnapshot.create.mock.calls[0]![0].data
    expect(snapshot.revision).toBe(2)
    expect(snapshot.diffJson.hasChanges).toBe(true)
    expect(snapshot.diffJson.bases[0]).toMatchObject({ basis: 'ORDERED', netProfit: { before: 500, after: 400, delta: -100 } })
    expect(snapshot.diffJson.bases[0].items.find((item: { key: string }) => item.key === 'REVENUE')).toMatchObject({ before: 777, after: 1000, delta: 223 })
  })

  it('锁定前复查没通过：不锁定、不写快照、不锁汇率，期间退回开放并留痕，返回 409 说明哪几项没通过', async () => {
    const { call, prisma } = await open(CLOSER, { period: approved(), settlements: [] })
    const res = await call('POST', '/finance/periods/p1/close', { body: { version: 4 } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('DATA_CONDITION_FAILED')
    expect(res.json.error.message).toContain('结算已到')
    expect(prisma.accountingPeriod.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'OPEN', approvalDecision: null, checkedBy: 'user-1' })
    expect(prisma.periodSnapshot.create).not.toHaveBeenCalled()
    expect(prisma.fxRate.updateMany).not.toHaveBeenCalled()
    expect(audit(prisma)[0]).toMatchObject({ action: 'PERIOD_CHECKED', reason: '锁定前复查没有通过' })
  })

  it('审批时已确认放行的检查项，数字没变时锁定前复查沿用确认', async () => {
    const checklist = {
      ...passedChecklist,
      items: passedChecklist.items.map(item =>
        item.key === 'ADS_ALLOCATED'
          ? { ...item, state: 'ACKNOWLEDGED', baseState: 'NOT_CONNECTED', value: null, acknowledgement: { by: 'user-2', at: '2026-10-20T00:00:00.000Z', note: '广告分摊未上线', value: null } }
          : item,
      ),
    }
    const { call } = await open(CLOSER, { period: approved({ checklistJson: checklist }), adsAllocatedRows: 0 })
    expect((await call('POST', '/finance/periods/p1/close', { body: { version: 4 } })).json.data).toMatchObject({ status: 'CLOSED' })
  })
})

describe('重新开账', () => {
  const closed = (over: Record<string, unknown> = {}) => periodRow({ status: 'CLOSED', version: 5, closeCount: 1, closedBy: 'user-1', checklistJson: passedChecklist, ...over })
  const body = { version: 5, reason: '补录一笔漏掉的仓储费' }

  it('需要重新开账权限并再次验证身份；原因必填；只有已关账的期间可以重新开账', async () => {
    const noPermission = await open(CLOSER, { period: closed() })
    expect((await noPermission.call('POST', '/finance/periods/p1/reopen', { body })).status).toBe(403)
    const { call, prisma } = await open(ADMIN, { period: closed() })
    prisma.stepUpVerification.findFirst.mockResolvedValue(null)
    const noStepUp = await call('POST', '/finance/periods/p1/reopen', { body })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(prisma.stepUpVerification.findFirst.mock.calls[0]![0].where).toMatchObject({ action: 'finance.period.reopen' })
    prisma.stepUpVerification.findFirst.mockResolvedValue({ id: 'su-1' })
    expect((await call('POST', '/finance/periods/p1/reopen', { body: { version: 5 } })).status).toBe(422)
    expect((await call('POST', '/finance/periods/p1/reopen', { body: { version: 5, reason: '' } })).status).toBe(422)
    const opened = await open(ADMIN, { period: periodRow() })
    expect((await opened.call('POST', '/finance/periods/p1/reopen', { body })).status).toBe(409)
    for (const item of [noPermission.prisma, prisma, opened.prisma]) {
      expect(item.accountingPeriod.updateMany).not.toHaveBeenCalled()
      expect(item.fxRate.updateMany).not.toHaveBeenCalled()
    }
  })

  it('所有者的通配权限（*）同样可以锁定与重新开账，详情里的动作可用', async () => {
    const owner = await open(['*'], { period: closed() })
    expect((await owner.call('GET', '/finance/periods/p1')).json.data.actions.reopen.allowed).toBe(true)
    expect((await owner.call('POST', '/finance/periods/p1/reopen', { body })).status).toBe(201)
    const closer = await open(['*'], { period: approved() })
    expect((await closer.call('POST', '/finance/periods/p1/close', { body: { version: 4 } })).status).toBe(201)
  })

  it('重新开账：状态改为重新开账并记下原因，解除本期间的汇率锁定，日期重叠且仍已关账的其他期间锁回，写审计', async () => {
    const other = { id: 'p2', periodStart: new Date('2025-03-01T00:00:00Z'), periodEnd: new Date('2025-03-31T00:00:00Z') }
    const { call, prisma } = await open(ADMIN, { period: closed(), otherClosed: [other] })
    const res = await call('POST', '/finance/periods/p1/reopen', { body })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'p1', status: 'REOPENED', statusLabel: '重新开账' })
    const update = prisma.accountingPeriod.updateMany.mock.calls[0]![0]
    expect(update.where).toMatchObject({ version: 5 })
    expect(update.data).toMatchObject({ status: 'REOPENED', reopenedBy: 'user-1', reopenReason: '补录一笔漏掉的仓储费', checkedBy: null, approvalDecision: null, checklistJson: {} })
    expect(prisma.fxRate.updateMany.mock.calls[0]![0]).toMatchObject({ where: { tenantId: 'tenant-1', lockedByPeriodId: 'p1' }, data: { lockedByPeriodId: null } })
    expect(prisma.fxRate.updateMany.mock.calls[1]![0].data).toEqual({ lockedByPeriodId: 'p2' })
    const others = prisma.accountingPeriod.findMany.mock.calls.find(([args]) => !('sellerAccount' in (args.select ?? {})))![0]
    expect(others.where).toMatchObject({ tenantId: 'tenant-1', status: 'CLOSED', id: { not: 'p1' } })
    expect(audit(prisma).find(item => item.action === 'PERIOD_REOPENED')).toMatchObject({ reason: '补录一笔漏掉的仓储费', detail: { fxUnlocked: 31, fxRelocked: 31 } })
  })

  it('重新开账后详情页实时对比上一份快照：显示变化的利润桥项与 SKU', async () => {
    const { call } = await open(CLOSER, { period: periodRow({ status: 'REOPENED', closeCount: 1, reopenedBy: 'user-1', reopenReason: '补录费用' }), snapshots: [snapshotRow(777, 1)] })
    const res = await call('GET', '/finance/periods/p1')
    const { diff, preview, actions } = res.json.data
    expect(diff).toMatchObject({ against: 'LIVE', baseRevision: 1, compareRevision: null, hasChanges: true })
    expect(diff.bases[0].items.find((item: { key: string }) => item.key === 'REVENUE')).toMatchObject({ before: 777, after: 1000 })
    expect(diff.bases[0].skus[0]).toMatchObject({ sku: 'A', kind: 'CHANGED' })
    expect(preview).toMatchObject({ source: 'LIVE' })
    expect(actions.check.allowed).toBe(true)
  })

  it('再次锁定后详情页显示这次与上一份快照的差异', async () => {
    const latest = snapshotRow(1000, 2, {
      diffJson: { bases: [], fx: { rows: [], changed: 0, added: 0, removed: 0 }, costVersions: { rows: [], changed: 0, added: 0, removed: 0 }, hasChanges: false },
    })
    const { call } = await open(CLOSER, { period: periodRow({ status: 'CLOSED', closeCount: 2 }), snapshots: [latest, snapshotRow(777, 1)] })
    const res = await call('GET', '/finance/periods/p1')
    expect(res.json.data.diff).toMatchObject({ against: 'PREVIOUS_REVISION', baseRevision: 1, compareRevision: 2, hasChanges: false })
    expect(res.json.data.snapshots.map((item: { revision: number; hasDiff: boolean }) => [item.revision, item.hasDiff])).toEqual([
      [2, true],
      [1, false],
    ])
  })
})
