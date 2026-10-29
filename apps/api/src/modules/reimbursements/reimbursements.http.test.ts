import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 赔付中心接口（P2b-03）：权限先于参数校验、数据范围、机会与案件列表、生成案件、状态流转、忽略与恢复、统计口径、证据包。

const none = () => vi.fn().mockResolvedValue([])
const DEADLINE = new Date('2027-01-10T00:00:00Z')
const oppRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  ruleCode: 'LEDGER_LOST',
  sellerAccountId: 's1',
  sku: 'SKU-1',
  qty: 3,
  status: 'PENDING',
  estimatedAmount: { toString: () => '15' },
  currency: 'USD',
  deadlineAt: DEADLINE,
  detectedAt: new Date('2026-10-20T00:00:00Z'),
  evidenceRefsJson: [{ kind: 'LEDGER', id: 'l1', label: '库存台账 2026-08-01 丢失 3 件' }],
  note: null,
  version: 1,
  sellerAccount: { displayName: '美国主店' },
  cases: [],
  ...over,
})
const caseRecord = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  caseNo: 'PC-20261023-ABCDE',
  ruleCode: 'LEDGER_LOST',
  status: 'OPPORTUNITY',
  sellerAccountId: 's1',
  sku: 'SKU-1',
  qty: 3,
  expectedAmount: { toString: () => '15' },
  approvedAmount: null,
  receivedAmount: { toString: () => '0' },
  currency: 'USD',
  ownerId: 'user-1',
  amazonCaseId: null,
  submittedAt: null,
  decidedAt: null,
  paidAt: null,
  deadlineAt: DEADLINE,
  opportunityId: 'o1',
  note: null,
  version: 3,
  createdAt: new Date('2026-10-21T00:00:00Z'),
  updatedAt: new Date('2026-10-21T00:00:00Z'),
  evidenceRefsJson: [{ kind: 'RETURN', id: 'rt1', label: '退货' }],
  sellerAccount: { displayName: '美国主店' },
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    membership: { ...sessionStub(permissions).membership, findMany: none() },
    reimbursementOpportunity: { findMany: vi.fn().mockResolvedValue([oppRow()]), findFirst: vi.fn().mockResolvedValue(oppRow()), updateMany: vi.fn().mockResolvedValue({ count: 1 }), groupBy: none() },
    reimbursementCase: {
      findMany: vi.fn().mockResolvedValue([caseRecord()]),
      findFirst: vi.fn().mockResolvedValue(caseRecord()),
      create: vi.fn().mockResolvedValue({ id: 'c1', caseNo: 'PC-20261023-ABCDE', version: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    reimbursementRecord: { findMany: none(), groupBy: none() },
    evidencePack: { findMany: none(), create: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    exportJob: {
      findMany: none(),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({
        id: 'job1',
        kind: 'reimbursement-evidence',
        sourcePage: '/app/reimbursements',
        filterSummary: '',
        format: 'CSV',
        status: 'QUEUED',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    },
    fbaReturnCase: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: none() },
    entityEvent: { create: vi.fn().mockResolvedValue({}), findMany: none() },
    attachment: { findMany: none() },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null) },
    inventoryLedgerEntry: { findMany: none() },
    fbaInboundShipment: { findMany: none() },
    removalOrder: { findMany: none() },
    order: { findMany: none() },
    fbaFinancialTransaction: { findMany: none() },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: { findMany: none() },
    ...over,
  }
  const guards = createWriteGuardStubs()
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma as Record<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>> & {
    reimbursementOpportunity: Record<string, ReturnType<typeof vi.fn>>
    reimbursementCase: Record<string, ReturnType<typeof vi.fn>>
  }
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}

describe('权限与范围', () => {
  it('未登录 401；没有 reimbursements.read 时列表、机会、统计、详情 403（先于参数校验）', async () => {
    const { call } = await open(['reimbursements.read'])
    expect((await call('GET', '/reimbursements', { auth: false })).status).toBe(401)
    await harness?.close()
    const denied = await open(['seller.read'])
    for (const path of ['/reimbursements?pageSize=99999', '/reimbursements/opportunities?pageSize=99999', '/reimbursements/stats', '/reimbursements/c1']) {
      const res = await denied.call('GET', path)
      expect(res.status, path).toBe(403)
    }
  })

  it('只读成员不能生成案件、更新、忽略、生成证据包；这些写操作需要 reimbursements.write', async () => {
    const { call, prisma } = await open(['reimbursements.read'])
    for (const [method, path, body] of [
      ['POST', '/reimbursements', { opportunityId: 'o1' }],
      ['PATCH', '/reimbursements/c1', { version: 1, note: 'x' }],
      ['POST', '/reimbursements/opportunities/o1/ignore', { version: 1, reason: '不处理' }],
      ['POST', '/reimbursements/opportunities/o1/restore', { version: 1 }],
      ['POST', '/reimbursements/c1/evidence-pack', {}],
      ['POST', '/reimbursements/c1/attachments', { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
    ] as const) {
      expect((await call(method, path, { body })).status, path).toBe(403)
    }
    expect(prisma.reimbursementCase.create).not.toHaveBeenCalled()
  })

  it('查询一律带企业条件；数据范围收窄到一个店铺时机会与案件都按店铺过滤，范围外的案件详情 404', async () => {
    const scoped = {
      membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) },
      sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
      reimbursementCase: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    }
    const { call, prisma } = await open(['reimbursements.read'], scoped)
    await call('GET', '/reimbursements/opportunities')
    await call('GET', '/reimbursements')
    expect(JSON.stringify(prisma.reimbursementOpportunity.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect(JSON.stringify(prisma.reimbursementCase.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect((await call('GET', '/reimbursements/c-other')).status).toBe(404)
    expect(JSON.stringify(prisma.reimbursementCase.findFirst.mock.calls[0][0].where)).toContain('s1')
  })
})

describe('机会与案件列表', () => {
  it('机会列表：字段、规则中文名、估算金额、截止日、证据；游标多取一行；没有估算金额是空而不是 0', async () => {
    const { call, prisma } = await open(['reimbursements.read'])
    prisma.reimbursementOpportunity.findMany.mockResolvedValueOnce([oppRow(), oppRow({ id: 'o2', estimatedAmount: null, currency: null })])
    const res = await call('GET', '/reimbursements/opportunities?pageSize=20&rule=LEDGER_LOST&status=PENDING')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.state).toBe('OK')
    expect(data.items[0]).toMatchObject({
      id: 'o1',
      ruleLabel: '仓内丢失',
      connected: true,
      storeName: '美国主店',
      estimatedAmount: 15,
      currency: 'USD',
      deadlineAt: '2027-01-10',
      status: 'PENDING',
      caseId: null,
    })
    expect(data.items[0].evidence[0]).toMatchObject({ kind: 'LEDGER' })
    expect(data.items[1].estimatedAmount).toBeNull()
    const call0 = prisma.reimbursementOpportunity.findMany.mock.calls[0][0]
    expect(call0.take).toBe(21)
    expect(JSON.stringify(call0.where)).toContain('LEDGER_LOST')
  })

  it('没有机会时 NO_DATA 并说明原因；费用多收已接入（手动转入）；非法规则 422', async () => {
    const { call, prisma } = await open(['reimbursements.read'])
    prisma.reimbursementOpportunity.findMany.mockResolvedValue([])
    const empty = (await call('GET', '/reimbursements/opportunities')).json.data
    expect(empty.state).toBe('NO_DATA')
    expect(empty.note).toContain('尚无赔付机会')
    prisma.reimbursementOpportunity.findMany.mockResolvedValueOnce([oppRow({ ruleCode: 'FEE_OVERCHARGE' })])
    expect((await call('GET', '/reimbursements/opportunities')).json.data.items[0].connected).toBe(true)
    expect((await call('GET', '/reimbursements/opportunities?rule=NOPE')).status).toBe(422)
  })

  it('案件列表：页签落到状态分组；案件行含负责人、实收为 0 时不冒充已到账', async () => {
    const { call, prisma } = await open(['reimbursements.read'], {
      membership: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '张三', email: 'a@b.c' } }]),
        findFirst: vi.fn().mockResolvedValue({ id: 'm1', tenantId: 'tenant-1', role: { permissions: ['reimbursements.read'] }, tenant: { lifecycleStatus: 'ACTIVE' } }),
      },
    })
    const res = await call('GET', '/reimbursements?tab=processing')
    expect(res.status).toBe(200)
    expect(res.json.data.items[0]).toMatchObject({ caseNo: 'PC-20261023-ABCDE', ownerName: '张三', statusLabel: '待提交', expectedAmount: 15, approvedAmount: null, receivedAmount: 0 })
    expect(JSON.stringify(prisma.reimbursementCase.findMany.mock.calls[0][0].where)).toMatch(/SUBMITTED[\s\S]*IN_PROGRESS[\s\S]*APPROVED[\s\S]*PARTIAL/)
  })
})

describe('生成案件', () => {
  it('从待处理的机会生成案件：机会转已生成案件、证据复制到案件、退货记录关联案件、写时间线与审计', async () => {
    const { call, prisma } = await open(['reimbursements.read', 'reimbursements.write'])
    prisma.reimbursementOpportunity.findFirst.mockResolvedValue(oppRow({ evidenceRefsJson: [{ kind: 'RETURN', id: 'rt1', label: '退货' }] }))
    const res = await call('POST', '/reimbursements', { body: { opportunityId: 'o1', note: '先提交' } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'c1', caseNo: 'PC-20261023-ABCDE' })
    expect(prisma.reimbursementOpportunity.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'o1', tenantId: 'tenant-1', status: 'PENDING' }, data: { status: 'CASE_CREATED' } })
    const created = prisma.reimbursementCase.create.mock.calls[0][0].data
    expect(created).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      opportunityId: 'o1',
      ruleCode: 'LEDGER_LOST',
      sku: 'SKU-1',
      qty: 3,
      expectedAmount: 15,
      currency: 'USD',
      ownerId: 'user-1',
      note: '先提交',
    })
    expect(created.caseNo).toMatch(/^PC-\d{8}-[A-Z0-9]{5}$/)
    expect(created.evidenceRefsJson).toEqual([{ kind: 'RETURN', id: 'rt1', label: '退货' }])
    expect(prisma.fbaReturnCase.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ['rt1'] } }, data: { reimbursementCaseId: 'c1', reimbursementStatus: 'CASE_CREATED' } })
    expect(prisma.entityEvent.create.mock.calls[0][0].data).toMatchObject({ entityType: 'REIMBURSEMENT_CASE', entityId: 'c1', kind: 'reimbursement.status' })
  })

  it('机会已处理过不能再生成；机会不在范围内 404；并发抢先处理 409', async () => {
    const { call, prisma } = await open(['reimbursements.write'])
    prisma.reimbursementOpportunity.findFirst.mockResolvedValueOnce(oppRow({ status: 'CASE_CREATED' }))
    const handled = await call('POST', '/reimbursements', { body: { opportunityId: 'o1' } })
    expect(handled.status).toBe(409)
    expect(handled.json.error.message).toContain('已经生成过案件')
    prisma.reimbursementOpportunity.findFirst.mockResolvedValueOnce(null)
    expect((await call('POST', '/reimbursements', { body: { opportunityId: 'o-x' } })).status).toBe(404)
    prisma.reimbursementOpportunity.updateMany.mockResolvedValueOnce({ count: 0 })
    expect((await call('POST', '/reimbursements', { body: { opportunityId: 'o1' } })).status).toBe(409)
    expect(prisma.reimbursementCase.create).not.toHaveBeenCalled()
  })

  it('机会没有商品成本时应收金额为空；人工填金额必须同时给币种；负金额与未知字段 422', async () => {
    const { call, prisma } = await open(['reimbursements.write'])
    prisma.reimbursementOpportunity.findFirst.mockResolvedValue(oppRow({ estimatedAmount: null, currency: null }))
    await call('POST', '/reimbursements', { body: { opportunityId: 'o1' } })
    expect(prisma.reimbursementCase.create.mock.calls[0][0].data).toMatchObject({ expectedAmount: null, currency: null })
    const noCurrency = await call('POST', '/reimbursements', { body: { opportunityId: 'o1', expectedAmount: 20 } })
    expect(noCurrency.status).toBe(422)
    expect(noCurrency.json.error.fieldErrors?.currency ?? noCurrency.json.error.details?.fieldErrors?.currency).toBeTruthy()
    await call('POST', '/reimbursements', { body: { opportunityId: 'o1', expectedAmount: 20, currency: 'USD' } })
    expect(prisma.reimbursementCase.create.mock.calls[1][0].data).toMatchObject({ expectedAmount: 20, currency: 'USD' })
    expect((await call('POST', '/reimbursements', { body: { opportunityId: 'o1', expectedAmount: -1 } })).status).toBe(422)
  })
})

describe('更新案件', () => {
  const update = (
    call: ReturnType<typeof stub> extends never ? never : (m: string, p: string, i?: { body?: unknown }) => Promise<{ status: number; json: { error: { message: string } } & Record<string, unknown> }>,
    body: unknown,
  ) => call('PATCH', '/reimbursements/c1', { body })

  it('待提交 → 已提交：写提交时间、回填亚马逊案件编号、带版本号更新、写时间线', async () => {
    const { call, prisma } = await open(['reimbursements.write'])
    prisma.reimbursementCase.findFirst.mockResolvedValueOnce(caseRecord()).mockResolvedValue(caseRecord({ status: 'SUBMITTED', amazonCaseId: '1234567890', version: 4 }))
    const res = await update(call as never, { version: 3, status: 'SUBMITTED', amazonCaseId: '1234567890' })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ id: 'c1', version: 4, status: 'SUBMITTED' })
    const args = prisma.reimbursementCase.updateMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ id: 'c1', tenantId: 'tenant-1', version: 3 })
    expect(args.data).toMatchObject({ status: 'SUBMITTED', amazonCaseId: '1234567890', version: { increment: 1 } })
    expect(args.data.submittedAt).toBeInstanceOf(Date)
    expect(prisma.entityEvent.create.mock.calls[0][0].data.title).toContain('待提交 → 已提交')
  })

  it('不能手工标已到账；批准必须填批准金额；部分批准金额须小于应收；不能跳步', async () => {
    const { call, prisma } = await open(['reimbursements.write'])
    prisma.reimbursementCase.findFirst.mockResolvedValue(caseRecord({ status: 'SUBMITTED' }))
    const paid = await update(call as never, { version: 3, status: 'PAID' })
    expect(paid.status).toBe(409)
    expect(paid.json.error.message).toContain('不能手工标记')
    expect((await update(call as never, { version: 3, status: 'APPROVED' })).json.error.message).toContain('批准的金额')
    expect((await update(call as never, { version: 3, status: 'PARTIAL', approvedAmount: 15 })).json.error.message).toContain('小于应收')
    prisma.reimbursementCase.findFirst.mockResolvedValue(caseRecord({ status: 'OPPORTUNITY' }))
    expect((await update(call as never, { version: 3, status: 'APPROVED', approvedAmount: 10 })).json.error.message).toContain('不能直接改成')
    expect(prisma.reimbursementCase.updateMany).not.toHaveBeenCalled()
  })

  it('版本号缺失 422、编号格式不对 422、版本冲突 409、案件不存在 404；已到账的案件金额不能再改', async () => {
    const { call, prisma } = await open(['reimbursements.write'])
    expect((await update(call as never, { note: 'x' })).status).toBe(422)
    expect((await update(call as never, { version: 3, amazonCaseId: '含 空格' })).status).toBe(422)
    prisma.reimbursementCase.updateMany.mockResolvedValueOnce({ count: 0 })
    prisma.reimbursementCase.findFirst.mockResolvedValueOnce(caseRecord()).mockResolvedValueOnce({ version: 9 })
    const conflict = await update(call as never, { version: 3, note: '改备注' })
    expect(conflict.status).toBe(409)
    prisma.reimbursementCase.findFirst.mockResolvedValueOnce(null)
    expect((await update(call as never, { version: 3, note: 'x' })).status).toBe(404)
    prisma.reimbursementCase.findFirst.mockResolvedValueOnce(caseRecord({ status: 'PAID' }))
    expect((await update(call as never, { version: 3, expectedAmount: 99 })).json.error.message).toContain('已到账')
  })
})

describe('忽略与恢复机会', () => {
  it('忽略必须写原因并带版本号；只有待处理的可以忽略；恢复只对已忽略的', async () => {
    const { call, prisma } = await open(['reimbursements.write'])
    expect((await call('POST', '/reimbursements/opportunities/o1/ignore', { body: { version: 1 } })).status).toBe(422)
    prisma.reimbursementOpportunity.findFirst.mockResolvedValue(oppRow()).mockResolvedValue(oppRow({ version: 2, status: 'IGNORED', note: '已和亚马逊确认' }))
    prisma.reimbursementOpportunity.findFirst.mockResolvedValueOnce(oppRow())
    const ok = await call('POST', '/reimbursements/opportunities/o1/ignore', { body: { version: 1, reason: '已和亚马逊确认' } })
    expect(ok.status).toBe(201)
    expect(prisma.reimbursementOpportunity.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'o1', version: 1 }, data: { status: 'IGNORED', note: '已和亚马逊确认' } })
    prisma.reimbursementOpportunity.findFirst.mockResolvedValueOnce(oppRow({ status: 'CASE_CREATED' }))
    expect((await call('POST', '/reimbursements/opportunities/o1/ignore', { body: { version: 1, reason: '不处理了' } })).status).toBe(409)
    prisma.reimbursementOpportunity.findFirst.mockResolvedValueOnce(oppRow())
    expect((await call('POST', '/reimbursements/opportunities/o1/restore', { body: { version: 1 } })).status).toBe(409)
  })
})

describe('统计', () => {
  it('回收率按币种分别算、只算已提交且填了应收的案件；平均到账时长取第一笔赔付；各类成功率；未归属赔付；时限默认值', async () => {
    const d = (value: number) => ({ toString: () => String(value) })
    const row = (id: string, status: string, expected: number | null, received: number, submittedAt: Date | null, currency: string | null = 'USD', ruleCode = 'LEDGER_LOST') => ({
      id,
      status,
      ruleCode,
      currency,
      expectedAmount: expected === null ? null : d(expected),
      receivedAmount: d(received),
      submittedAt,
    })
    const { call } = await open(['reimbursements.read'], {
      reimbursementCase: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            row('a', 'PAID', 100, 100, new Date('2026-09-01T00:00:00Z')),
            row('b', 'REJECTED', 50, 0, new Date('2026-09-02T00:00:00Z')),
            row('c', 'OPPORTUNITY', 80, 0, null),
            row('d', 'SUBMITTED', null, 0, new Date('2026-09-03T00:00:00Z')),
            row('e', 'PAID', 40, 20, new Date('2026-09-01T00:00:00Z'), 'EUR', 'REFUND_NO_RETURN'),
          ]),
      },
      reimbursementOpportunity: { groupBy: vi.fn().mockResolvedValue([{ ruleCode: 'LEDGER_LOST', _count: { _all: 4 } }]) },
      reimbursementRecord: {
        groupBy: vi
          .fn()
          .mockImplementation(async (args: { by: string[] }) =>
            args.by[0] === 'currency' ? [{ currency: 'USD', _count: { _all: 2 }, _sum: { amount: d(35) } }] : [{ matchedCaseId: 'a', _min: { approvedAt: new Date('2026-09-11T00:00:00Z') } }],
          ),
        findMany: none(),
      },
    })
    const res = await call('GET', '/reimbursements/stats')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.state).toBe('OK')
    expect(data.caseCounts).toMatchObject({ PAID: 2, REJECTED: 1, OPPORTUNITY: 1, SUBMITTED: 1 })
    expect(data.pendingOpportunities).toBe(4)
    expect(data.recovery).toEqual([
      { currency: 'EUR', expected: 40, received: 20, recoveryRate: 0.5, caseCount: 1 },
      { currency: 'USD', expected: 150, received: 100, recoveryRate: 0.6667, caseCount: 2 },
    ])
    expect(data.avgPayDays).toBe(10)
    expect(data.paidSample).toBe(1)
    const lost = data.rules.find((item: { ruleCode: string }) => item.ruleCode === 'LEDGER_LOST')
    expect(lost).toMatchObject({ pendingOpportunities: 4, submitted: 3, won: 1, rejected: 1, successRate: 0.5, connected: true })
    expect(data.rules.find((item: { ruleCode: string }) => item.ruleCode === 'FEE_OVERCHARGE')).toMatchObject({ connected: true, successRate: null })
    expect(data.unmatched).toEqual({ count: 2, byCurrency: [{ currency: 'USD', amount: 35 }] })
    expect(data.windowsDefault).toBe(true)
    expect(data.windows.LEDGER_LOST).toMatchObject({ waitDays: 45, windowDays: 540 })
  })

  it('什么都没有时 NO_DATA 并说明；平均到账时长没有样本是空不是 0', async () => {
    const { call } = await open(['reimbursements.read'], { reimbursementCase: { findMany: none() } })
    const { data } = (await call('GET', '/reimbursements/stats')).json
    expect(data.state).toBe('NO_DATA')
    expect(data.avgPayDays).toBeNull()
    expect(data.recovery).toEqual([])
    expect(data.note).toContain('尚无')
  })
})

describe('案件详情与证据包', () => {
  it('详情含识别依据、可改成的状态、证据、附件、已匹配赔付与证据包；评论与时间线不在这里', async () => {
    const { call } = await open(['reimbursements.read', 'reimbursements.write'], {
      reimbursementRecord: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'r1',
            reimbursementId: 'R100',
            sku: 'SKU-1',
            reason: 'Lost_Warehouse',
            quantity: 3,
            amount: { toString: () => '15' },
            currency: 'USD',
            approvedAt: new Date('2026-10-22T00:00:00Z'),
            matchBasis: 'CASE_ID',
          },
        ]),
        groupBy: none(),
      },
      evidencePack: { findMany: vi.fn().mockResolvedValue([{ id: 'p1', generatedAt: new Date('2026-10-22T01:00:00Z'), generatedBy: 'user-1', lineCount: 12, exportJobId: 'job1' }]) },
      exportJob: { findMany: vi.fn().mockResolvedValue([{ id: 'job1', status: 'DONE', expiresAt: new Date(Date.now() + 86_400_000), fileKey: 'k', requestedBy: 'user-1' }]) },
    })
    const res = await call('GET', '/reimbursements/c1')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.case).toMatchObject({ caseNo: 'PC-20261023-ABCDE', status: 'OPPORTUNITY' })
    expect(data.nextStatuses).toEqual(['SUBMITTED'])
    expect(data.canWrite).toBe(true)
    expect(data.basis).toContain('库存台账')
    expect(data.records[0]).toMatchObject({ reimbursementId: 'R100', amount: 15, matchBasisLabel: '案件编号一致' })
    expect(data.packs[0]).toMatchObject({ id: 'p1', lineCount: 12, exportStatusLabel: '已完成', downloadable: true })
    expect(data.supportCases.state).toBe('RESTRICTED') // 没有 support.read：不给支持案件内容
  })

  it('关联的支持案件：没回填案件编号 NO_ID；回填了就读同步下来的案件与最近沟通；没同步到分情况说明', async () => {
    const supportRow = {
      id: 'sc1',
      caseId: '123456789',
      sellerAccountId: 's1',
      subject: '货件 FBA15ABCDE 少收',
      status: 'PENDING_AMAZON_ACTION',
      amazonCreatedAt: new Date('2026-10-20T00:00:00Z'),
      amazonUpdatedAt: new Date('2026-10-22T00:00:00Z'),
      amazonResolvedAt: null,
      lastOutboundAt: null,
      contactsForUpdatedAt: new Date('2026-10-22T00:00:00Z'),
      contactCount: 1,
      sellerAccount: { displayName: '美国主店' },
    }
    const contact = { id: 'k1', contactId: 'c1', channel: 'EMAIL', direction: 'FROM_AMAZON', senderName: null, body: '请补充证据', attachmentsJson: [], occurredAt: new Date('2026-10-22T00:00:00Z') }
    const noId = await open(['reimbursements.read', 'support.read'])
    expect((await noId.call('GET', '/reimbursements/c1')).json.data.supportCases.state).toBe('NO_ID')
    await harness?.close()
    const linked = await open(['reimbursements.read', 'support.read'], {
      reimbursementCase: { findMany: none(), findFirst: vi.fn().mockResolvedValue(caseRecord({ amazonCaseId: '123456789' })) },
      supportCase: { findFirst: vi.fn().mockResolvedValue(supportRow) },
      supportContact: { findMany: vi.fn().mockResolvedValue([contact]) },
    })
    const view = (await linked.call('GET', '/reimbursements/c1')).json.data.supportCases
    expect(view.state).toBe('OK')
    expect(view.case).toMatchObject({ caseId: '123456789', statusLabel: '等待亚马逊处理', reimbursementCaseNo: 'PC-20261023-ABCDE', contactCount: 1 })
    expect(view.contacts[0]).toMatchObject({ body: '请补充证据', directionLabel: '亚马逊' })
    await harness?.close()
    const missing = await open(['reimbursements.read', 'support.read'], {
      reimbursementCase: { findMany: none(), findFirst: vi.fn().mockResolvedValue(caseRecord({ amazonCaseId: '123456789' })) },
      supportCase: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    const notConnected = (await missing.call('GET', '/reimbursements/c1')).json.data.supportCases
    expect(notConnected.state).toBe('NOT_CONNECTED') // 从没同步过：不能说“没有这个案件”
  })

  it('生成证据包：清单先存下来，再建导出任务并回填任务编号；导出建不成时清单不留', async () => {
    const { call, prisma } = await open(['reimbursements.read', 'reimbursements.write', 'export.create'])
    const res = await call('POST', '/reimbursements/c1/evidence-pack', { body: {} })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ exportJobId: 'job1' })
    expect(res.json.data.lineCount).toBeGreaterThan(5)
    const pack = (prisma.evidencePack.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(pack).toMatchObject({ tenantId: 'tenant-1', caseId: 'c1', generatedBy: 'user-1' })
    expect(pack.contentManifestJson.lines.map((line: { section: string }) => line.section)).toEqual(expect.arrayContaining(['案件', '识别依据', '证据引用']))
    expect(JSON.stringify(pack.contentManifestJson)).toContain('PC-20261023-ABCDE')
    const job = (prisma.exportJob.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data
    expect(job).toMatchObject({ kind: 'reimbursement-evidence', tenantId: 'tenant-1' })
    expect(job.filterJson).toMatchObject({ packId: pack.id, storeIds: ['s1'] })
    expect((prisma.evidencePack.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toEqual({ exportJobId: 'job1' })
    // 没有导出权限：导出建不成，清单被撤掉
    await harness?.close()
    const second = await open(['reimbursements.read', 'reimbursements.write'])
    const denied = await second.call('POST', '/reimbursements/c1/evidence-pack', { body: {} })
    expect(denied.status).toBe(403)
    expect((second.prisma.evidencePack.deleteMany as ReturnType<typeof vi.fn>).mock).toBeDefined()
    expect((second.prisma.evidencePack.deleteMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})
