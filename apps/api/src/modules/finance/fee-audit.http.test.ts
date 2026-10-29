import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 费用核查接口（P2b-06）：权限先于参数校验、数据范围、列表（只看最近核查日、汇总、尺寸分段变化、空状态）、
// 转为赔付机会（权限先于路径校验、新建、已转幂等、已忽略不重建、没有多收、超期、并发冲突、范围外 404、审计）。

const none = () => vi.fn().mockResolvedValue([])
const dec = (value: string) => ({ toString: () => value })
const DAY = new Date('2026-10-23T00:00:00Z')
const auditRecord = (over: Record<string, unknown> = {}) => ({
  id: 'fa1',
  sellerAccountId: 's1',
  feeKind: 'FULFILLMENT',
  subjectKey: 'SKU-1',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  shipmentRef: null,
  snapshotDate: DAY,
  currency: 'USD',
  expectedAmount: dec('9'),
  actualAmount: dec('12'),
  diffAmount: dec('3'),
  overchargeAmount: dec('3'),
  occurrences: 1,
  checkedCount: 2,
  firstSeenAt: new Date('2026-10-20T08:00:00Z'),
  lastSeenAt: new Date('2026-10-21T08:00:00Z'),
  status: 'SUSPECTED',
  basisJson: { summary: '核对 2 个订单行', lines: [], dims: null, notes: ['限制说明'] },
  opportunityId: null,
  sellerAccount: { displayName: '美国主店' },
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const prisma: Record<string, unknown> = {
    ...sessionStub(permissions),
    feeAudit: {
      groupBy: vi
        .fn()
        .mockImplementation(async (args: { by: string[] }) =>
          args.by.length === 1 && args.by[0] === 'sellerAccountId'
            ? [{ sellerAccountId: 's1', _max: { snapshotDate: DAY } }]
            : args.by.length === 1
              ? [{ feeKind: 'FULFILLMENT', _count: { _all: 1 } }]
              : [{ feeKind: 'FULFILLMENT', currency: 'USD', _count: { _all: 2 }, _sum: { occurrences: 1, overchargeAmount: dec('3') } }],
        ),
      findMany: vi.fn().mockResolvedValue([auditRecord()]),
      findFirst: vi.fn().mockResolvedValue(auditRecord()),
      update: vi.fn().mockResolvedValue({}),
    },
    feeBaseline: { findMany: none() },
    reimbursementOpportunity: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'op1' }) },
    systemSetting: { findFirst: vi.fn().mockResolvedValue(null), findMany: none(), findUnique: vi.fn().mockResolvedValue(null) },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null), findMany: none(), findUnique: vi.fn().mockResolvedValue(null) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: { findMany: none() },
    ...over,
  }
  const guards = createWriteGuardStubs()
  prisma.auditEvent = guards.auditEvent
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>
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
const reopen = async (permissions: string[], over: Record<string, unknown> = {}) => {
  await harness?.close()
  return open(permissions, over)
}

describe('权限与范围', () => {
  it('未登录 401；没有 finance.read 读接口 403（先于参数校验）；没有 reimbursements.write 转机会 403（先于路径校验）', async () => {
    const { call } = await open(['finance.read'])
    expect((await call('GET', '/finance/fee-audit', { auth: false })).status).toBe(401)
    expect((await call('POST', '/finance/fee-audit/fa1/reimbursement', { auth: false, body: {} })).status).toBe(401)
    const denied = await reopen(['seller.read'])
    expect((await denied.call('GET', '/finance/fee-audit?kind=NOPE&pageSize=99999')).status).toBe(403)
    const readOnly = await reopen(['finance.read'])
    expect((await readOnly.call('POST', '/finance/fee-audit/bad%20id/reimbursement', { body: {} })).status).toBe(403)
    expect(readOnly.prisma.reimbursementOpportunity.create).not.toHaveBeenCalled()
  })

  it('查询一律带企业条件；范围收窄到一个店铺时按店铺过滤，范围外的核查结果转机会 404', async () => {
    const scoped = {
      membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) },
      feeAudit: { groupBy: vi.fn().mockResolvedValue([]), findMany: none(), findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    }
    const { call, prisma } = await open(['finance.read', 'reimbursements.write'], scoped)
    await call('GET', '/finance/fee-audit')
    expect(JSON.stringify(prisma.feeAudit.groupBy.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect(JSON.stringify(prisma.feeBaseline.findMany.mock.calls[0][0].where)).toContain('s1')
    expect((await call('POST', '/finance/fee-audit/other/reimbursement', { body: {} })).status).toBe(404)
    expect(JSON.stringify(prisma.feeAudit.findFirst.mock.calls[0][0].where)).toContain('s1')
    expect((await call('POST', '/finance/fee-audit/bad%20id/reimbursement', { body: {} })).status).toBe(404)
  })
})

describe('列表', () => {
  it('字段与中文名、依据、汇总、只看每个店铺最近一个核查日、多取一行做游标、没有写权限时 canConvert 为 false', async () => {
    const { call, prisma } = await open(['finance.read'])
    const res = await call('GET', '/finance/fee-audit?pageSize=20')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data).toMatchObject({ state: 'OK', note: null, snapshotDate: '2026-10-23', canConvert: false })
    expect(data.items[0]).toMatchObject({
      id: 'fa1',
      storeName: '美国主店',
      feeKindLabel: '配送费',
      statusLabel: '疑似多收',
      expectedAmount: 9,
      actualAmount: 12,
      overchargeAmount: 3,
      occurrences: 1,
      checkedCount: 2,
      basis: { summary: '核对 2 个订单行', notes: ['限制说明'] },
    })
    expect(data.summary).toHaveLength(4)
    expect(data.summary[0]).toMatchObject({ kind: 'FULFILLMENT', subjects: 2, suspected: 1, occurrences: 1, overcharge: [{ currency: 'USD', amount: 3 }] })
    expect(data.summary[1]).toMatchObject({ kind: 'COMMISSION', subjects: 0, suspected: 0, overcharge: [] })
    const args = prisma.feeAudit.findMany.mock.calls[0][0]
    expect(args.take).toBe(21)
    expect(JSON.stringify(args.where)).toContain('2026-10-23')
    expect(args.orderBy[0]).toEqual({ overchargeAmount: 'desc' })
  })

  it('没有任何核查结果：状态 NO_DATA 并写明原因；有结果但筛选后为空：提示放宽条件', async () => {
    const empty = await open(['finance.read', 'reimbursements.write'], { feeAudit: { groupBy: vi.fn().mockResolvedValue([]), findMany: none(), findFirst: vi.fn(), update: vi.fn() } })
    const res = await empty.call('GET', '/finance/fee-audit')
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [], snapshotDate: null, canConvert: true })
    expect(res.json.data.note).toContain('尚无费用核查结果')
    const filtered = await reopen(['finance.read'], { feeAudit: { ...stub(['finance.read']).feeAudit, findMany: none() } })
    const second = await filtered.call('GET', '/finance/fee-audit?kind=STORAGE')
    expect(second.json.data.state).toBe('NO_DATA')
    expect(second.json.data.note).toContain('放宽')
  })

  it('筛选与排序参数传到查询；非法取值 422', async () => {
    const { call, prisma } = await open(['finance.read'])
    await call('GET', '/finance/fee-audit?kind=STORAGE&status=SUSPECTED&q=sku-1&sort=occurrences:desc')
    const where = JSON.stringify(prisma.feeAudit.findMany.mock.calls[0][0].where)
    expect(where).toContain('"feeKind":"STORAGE"')
    expect(where).toContain('"status":"SUSPECTED"')
    expect(where).toContain('sku-1')
    expect(prisma.feeAudit.findMany.mock.calls[0][0].orderBy[0]).toEqual({ occurrences: 'desc' })
    expect((await call('GET', '/finance/fee-audit?kind=NOPE')).status).toBe(422)
    expect((await call('GET', '/finance/fee-audit?status=NOPE')).status).toBe(422)
    expect((await call('GET', '/finance/fee-audit?pageSize=0')).status).toBe(422)
    expect((await call('GET', '/finance/fee-audit?sort=sku:asc')).status).toBe(422)
  })

  it('尺寸分段变化：只列真变化（忽略大小写），每个 SKU 只列最近一次', async () => {
    const baseline = (sku: string, previous: string, current: string, day: string) => ({
      sellerAccountId: 's1',
      sku,
      asin: 'B0TEST0001',
      snapshotDate: new Date(`${day}T00:00:00Z`),
      sizeTier: current,
      prevSizeTier: previous,
      sellerAccount: { displayName: '美国主店' },
    })
    const { call } = await open(['finance.read'], {
      feeBaseline: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            baseline('SKU-A', 'Small Standard', 'Large Standard', '2026-10-22'),
            baseline('SKU-A', 'Small Standard', 'Large Standard', '2026-10-21'),
            baseline('SKU-B', 'large standard', 'Large Standard', '2026-10-22'),
          ]),
      },
    })
    const res = await call('GET', '/finance/fee-audit')
    expect(res.json.data.sizeTierChanges).toEqual([
      { sellerAccountId: 's1', storeName: '美国主店', sku: 'SKU-A', asin: 'B0TEST0001', previousTier: 'Small Standard', currentTier: 'Large Standard', changedOn: '2026-10-22' },
    ])
  })
})

describe('转为赔付机会', () => {
  it('新建：金额与币种来自核查行，证据指向核查结果，核查行标为已转；同一事务写审计', async () => {
    const { call, prisma } = await open(['finance.read', 'reimbursements.write'])
    const res = await call('POST', '/finance/fee-audit/fa1/reimbursement', { body: {} })
    expect(res.status).toBe(201)
    expect(res.json.data).toEqual({ id: 'fa1', status: 'APPEALED', opportunityId: 'op1', created: true })
    const data = prisma.reimbursementOpportunity.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      ruleCode: 'FEE_OVERCHARGE',
      dedupKey: 'fee-audit:FULFILLMENT:SKU-1',
      estimatedAmount: 3,
      currency: 'USD',
      status: 'PENDING',
      sku: 'SKU-1',
    })
    expect(data.evidenceRefsJson[0]).toMatchObject({ kind: 'FEE_AUDIT', id: 'fa1' })
    expect(prisma.feeAudit.update.mock.calls[0][0]).toMatchObject({ where: { id: 'fa1' }, data: { status: 'APPEALED', opportunityId: 'op1' } })
    expect(prisma.auditEvent.create.mock.calls.some(call => JSON.stringify(call[0]).includes('FEE_AUDIT_CONVERTED'))).toBe(true)
  })

  it('已转过：返回已有机会，不再新建', async () => {
    const { call, prisma } = await open(['reimbursements.write'], { reimbursementOpportunity: { findUnique: vi.fn().mockResolvedValue({ id: 'op9', status: 'CASE_CREATED' }), create: vi.fn() } })
    const res = await call('POST', '/finance/fee-audit/fa1/reimbursement', { body: {} })
    expect(res.json.data).toEqual({ id: 'fa1', status: 'APPEALED', opportunityId: 'op9', created: false })
    expect(prisma.reimbursementOpportunity.create).not.toHaveBeenCalled()
  })

  it('已有机会被忽略、已过期或已消除：409，不重建，提示去赔付中心', async () => {
    for (const status of ['IGNORED', 'EXPIRED', 'RESOLVED']) {
      const { call, prisma } = await reopen(['reimbursements.write'], { reimbursementOpportunity: { findUnique: vi.fn().mockResolvedValue({ id: 'op9', status }), create: vi.fn() } })
      const res = await call('POST', '/finance/fee-audit/fa1/reimbursement', { body: {} })
      expect(res.status, status).toBe(409)
      expect(JSON.stringify(res.json)).toContain('赔付中心')
      expect(prisma.reimbursementOpportunity.create).not.toHaveBeenCalled()
    }
  })

  it('没有疑似多收的对象：409；最早一次多收已超过申请期限：409', async () => {
    const normal = await open(['reimbursements.write'], {
      feeAudit: { ...stub([]).feeAudit, findFirst: vi.fn().mockResolvedValue(auditRecord({ status: 'NORMAL', occurrences: 0, overchargeAmount: dec('0') })) },
    })
    const none409 = await normal.call('POST', '/finance/fee-audit/fa1/reimbursement', { body: {} })
    expect(none409.status).toBe(409)
    expect(JSON.stringify(none409.json)).toContain('没有疑似多收')
    const old = await reopen(['reimbursements.write'], { feeAudit: { ...stub([]).feeAudit, findFirst: vi.fn().mockResolvedValue(auditRecord({ firstSeenAt: new Date('2020-01-01T00:00:00Z') })) } })
    const expired = await old.call('POST', '/finance/fee-audit/fa1/reimbursement', { body: {} })
    expect(expired.status).toBe(409)
    expect(JSON.stringify(expired.json)).toContain('申请期限')
    expect(old.prisma.reimbursementOpportunity.create).not.toHaveBeenCalled()
  })

  it('并发：另一个请求刚建了同一个机会（唯一键冲突）时按已有的返回', async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'op7', status: 'PENDING' })
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    const { call } = await open(['reimbursements.write'], { reimbursementOpportunity: { findUnique, create } })
    const res = await call('POST', '/finance/fee-audit/fa1/reimbursement', { body: {} })
    expect(res.json.data).toEqual({ id: 'fa1', status: 'APPEALED', opportunityId: 'op7', created: false })
  })
})
