import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 审批收件箱接口（P6-27）：只需要登录；列表按信箱筛选并只含与本人有关的单据；处理时的状态与身份规则。
// 登记、转给原模块审批、回写、跨企业隔离在真实库测试 apps/api/src/testing/approvals.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ap-1',
  tenantId: 'tenant-1',
  type: 'FINANCE_POLICY',
  objectType: 'FinancePolicyVersion',
  objectId: 'v-1',
  title: '财务口径变更：第 2 版',
  summary: [{ label: '修改原因', value: '改口径' }],
  requesterId: 'user-2',
  approverIds: ['user-1'],
  ccIds: [],
  status: 'PENDING',
  decidedBy: null,
  decidedAt: null,
  comment: null,
  version: 1,
  createdAt: new Date('2026-10-26T00:00:00Z'),
  updatedAt: new Date('2026-10-26T00:00:00Z'),
  ...over,
})

const open = async (found: Record<string, unknown> | null = row()) => {
  await harness?.close()
  const guards = createWriteGuardStubs()
  const prisma = {
    ...sessionStub([]),
    ...guards,
    stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() },
    membership: {
      ...sessionStub([]).membership,
      findMany: vi.fn().mockResolvedValue([
        { userId: 'user-1', user: { displayName: '审批小王', email: 'w@example.com' } },
        { userId: 'user-2', user: { displayName: '发起小李', email: 'l@example.com' } },
      ]),
    },
    approvalRequest: { findMany: vi.fn().mockResolvedValue(found ? [found] : []), findFirst: vi.fn().mockResolvedValue(found), count: vi.fn().mockResolvedValue(1) },
    financePolicyVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  }
  harness = await createTestApp(prisma)
  return { prisma: prisma as Record<string, any>, call: harness.call }
}

describe('列表', () => {
  it('未登录 401；只需要登录，没有任何权限点也能看自己的收件箱', async () => {
    const { call } = await open()
    expect((await call('GET', '/approvals', { auth: false })).status).toBe(401)
    const res = await call('GET', '/approvals')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'OK', box: 'TODO', filter: 'PENDING', counts: { todoPending: 1, sentPending: 1, ccPending: 1 } })
    expect(res.json.data.items[0]).toMatchObject({
      id: 'ap-1',
      type: 'FINANCE_POLICY',
      typeLabel: '财务口径变更',
      statusLabel: '待处理',
      requesterName: '发起小李',
      approverNames: ['审批小王'],
      canDecide: true,
      isRequester: false,
      detailPath: '/app/settings',
      summary: [{ label: '修改原因', value: '改口径' }],
    })
  })

  it('信箱与状态变成数据库条件：我审批的看审批人、我发起的看发起人、已处理排除待处理；条件限定在本企业', async () => {
    const { call, prisma } = await open()
    await call('GET', '/approvals')
    const todo = JSON.stringify(prisma.approvalRequest.findMany.mock.calls[0]![0].where)
    expect(todo).toContain('"tenantId":"tenant-1"')
    expect(todo).toContain('"approverIds":{"has":"user-1"}')
    expect(todo).toContain('"status":"PENDING"')
    await call('GET', '/approvals?box=SENT&state=DONE')
    const sent = JSON.stringify(prisma.approvalRequest.findMany.mock.calls[1]![0].where)
    expect(sent).toContain('"requesterId":"user-1"')
    expect(sent).toContain('"status":{"not":"PENDING"}')
  })

  it('没有数据时说明原因而不是空白；参数不合法 422', async () => {
    const { call } = await open(null)
    const res = await call('GET', '/approvals')
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [], note: '没有需要你审批的单据' })
    expect((await call('GET', '/approvals?box=BAD')).status).toBe(422)
    expect((await call('GET', '/approvals?limit=0')).status).toBe(422)
  })

  it('关账审批里发起检查的人不能处理（没有撤回）；其他类型发起人可以撤回', async () => {
    const closing = await open(row({ type: 'PERIOD_CLOSE', objectType: 'AccountingPeriod', requesterId: 'user-1', approverIds: ['user-3'] }))
    expect((await closing.call('GET', '/approvals?box=SENT')).json.data.items[0]).toMatchObject({ isRequester: true, canDecide: false })
    const policy = await open(row({ requesterId: 'user-1', approverIds: ['user-3'] }))
    expect((await policy.call('GET', '/approvals?box=SENT')).json.data.items[0]).toMatchObject({ isRequester: true, canDecide: true })
  })
})

describe('处理', () => {
  const body = { decision: 'APPROVED', comment: '同意', version: 1 }

  it('与你无关或不存在 404；驳回必须写意见 422；已处理 409；不是审批人 403', async () => {
    const none = await open(null)
    expect((await none.call('POST', '/approvals/ap-1/decision', { body })).status).toBe(404)
    const { call } = await open()
    expect((await call('POST', '/approvals/ap-1/decision', { body: { decision: 'REJECTED', comment: '', version: 1 } })).status).toBe(422)
    expect((await call('POST', '/approvals/ap-1/decision', { body: { decision: 'MAYBE', version: 1 } })).status).toBe(422)
    const done = await open(row({ status: 'APPROVED', decidedBy: 'user-3', decidedAt: new Date() }))
    expect((await done.call('POST', '/approvals/ap-1/decision', { body })).status).toBe(409)
    const cc = await open(row({ approverIds: ['user-3'], ccIds: ['user-1'] }))
    expect((await cc.call('POST', '/approvals/ap-1/decision', { body })).status).toBe(403)
  })

  it('发起人不能审批自己的；版本过期 409；尚未接入的类型 409 并说明原因；这些都不会动原模块', async () => {
    const own = await open(row({ requesterId: 'user-1', approverIds: ['user-3'] }))
    expect((await own.call('POST', '/approvals/ap-1/decision', { body })).status).toBe(409)
    const stale = await open(row({ version: 3 }))
    const conflict = await stale.call('POST', '/approvals/ap-1/decision', { body })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.details).toMatchObject({ currentVersion: 3, expectedVersion: 1 })
    const bulk = await open(row({ type: 'BULK_PRICE', objectType: 'PriceWriteRun' }))
    const res = await bulk.call('POST', '/approvals/ap-1/decision', { body })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('还没有接入')
    expect(stale.prisma.financePolicyVersion.findFirst).not.toHaveBeenCalled()
  })
})
