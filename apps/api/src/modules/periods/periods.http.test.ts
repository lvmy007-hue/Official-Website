import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { periodRow, periodsPrisma, passedChecklist, type PeriodsStubOptions } from '../../testing/periods-stub'

// 期间关账接口（P2b-13）：权限先于参数校验、数据范围、列表与详情、创建期间、完整性检查（含确认放行）、审批。
// 锁定与重新开账在 periods-close.http.test.ts。检查项的判定细节在 api-contracts 的 periods.test.ts 里逐条验证。

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
// 数据范围只授予店铺 s2（范围解析按店铺清单求交集，所以店铺查询也要返回 s2）
const S2_ONLY = {
  membershipScope: { findMany: async () => [{ legalEntityId: null, sellerAccountId: 's2' }] },
  sellerAccount: { findMany: async () => [{ id: 's2', displayName: '欧洲店' }], findFirst: async () => ({ id: 's2', displayName: '欧洲店' }) },
}
const audit = (prisma: Awaited<ReturnType<typeof open>>['prisma']) => prisma.auditEvent.create.mock.calls.map(([args]) => args.data)

describe('权限与范围', () => {
  it('未登录 401；没有 finance.read 403 且先于参数校验；没有 finance.period.close 不能创建、检查、审批', async () => {
    const { call } = await open(['finance.read'])
    expect((await call('GET', '/finance/periods', { auth: false })).status).toBe(401)
    const denied = await open(['seller.read'])
    expect((await denied.call('GET', '/finance/periods?status=NOPE&pageSize=9999')).status).toBe(403)
    expect(denied.prisma.accountingPeriod.findMany).not.toHaveBeenCalled()
    const readOnly = await open(['finance.read'])
    for (const [path, body] of [
      ['/finance/periods', { sellerAccountId: 's1', month: '2025-03' }],
      ['/finance/periods/p1/check', {}],
      ['/finance/periods/p1/approve', { version: 1, decision: 'APPROVED' }],
    ] as const) {
      expect((await readOnly.call('POST', path, { body })).status).toBe(403)
    }
    expect(readOnly.prisma.accountingPeriod.create).not.toHaveBeenCalled()
    expect(readOnly.prisma.accountingPeriod.updateMany).not.toHaveBeenCalled()
  })

  it('范围外的期间与不存在一样返回 404；列表只列范围内店铺', async () => {
    const { call, prisma } = await open(CLOSER, { over: S2_ONLY })
    expect((await call('GET', '/finance/periods')).status).toBe(200)
    expect(JSON.stringify(prisma.accountingPeriod.findMany.mock.calls[0]![0].where)).toContain('s2')
    prisma.accountingPeriod.findFirst.mockResolvedValue(null)
    expect((await call('GET', '/finance/periods/p1')).status).toBe(404)
    expect(JSON.stringify(prisma.accountingPeriod.findFirst.mock.calls[0]![0].where)).toContain('s2')
    expect((await call('POST', '/finance/periods/p1/check', { body: {} })).status).toBe(404)
  })
})

describe('列表', () => {
  it('分页、各状态张数、可创建标记与店铺清单（只有能创建的人才拿到店铺清单）', async () => {
    const { call } = await open(CLOSER, { period: periodRow({ status: 'CLOSED', closeCount: 1, closedBy: 'user-1', closedAt: new Date('2026-10-01T00:00:00Z'), checklistJson: passedChecklist }) })
    const res = await call('GET', '/finance/periods?page=1&pageSize=20')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ total: 1, page: 1, pageSize: 20, canCreate: true, stores: [{ id: 's1', name: '美国主店' }], summary: { CLOSED: 1, OPEN: 0, CLOSING: 0, REOPENED: 0 } })
    expect(res.json.data.items[0]).toMatchObject({
      month: '2025-03',
      periodStart: '2025-03-01',
      periodEnd: '2025-03-31',
      status: 'CLOSED',
      statusLabel: '已关账',
      closedBy: '财务小王',
      checkPassed: true,
      storeName: '美国主店',
    })
    const viewer = await open(['finance.read'])
    const plain = await viewer.call('GET', '/finance/periods')
    expect(plain.json.data).toMatchObject({ canCreate: false, stores: [] })
    expect(viewer.prisma.sellerAccount.findMany).not.toHaveBeenCalled()
  })

  it('状态筛选传给数据库；不合法的参数 422', async () => {
    const { call, prisma } = await open(CLOSER)
    expect((await call('GET', '/finance/periods?status=CLOSING')).status).toBe(200)
    expect(prisma.accountingPeriod.findMany.mock.calls[0]![0].where).toMatchObject({ status: 'CLOSING' })
    expect((await call('GET', '/finance/periods?status=NOPE')).status).toBe(422)
    expect((await call('GET', '/finance/periods?sort=revenue')).status).toBe(422)
  })
})

describe('详情', () => {
  it('开放期间：实时预览、没有检查清单、可用动作与原因', async () => {
    const { call } = await open(CLOSER)
    const res = await call('GET', '/finance/periods/p1')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.period).toMatchObject({ id: 'p1', status: 'OPEN', createdBy: '财务小王' })
    expect(data.checklist).toBeNull()
    expect(data.preview).toMatchObject({ state: 'OK', source: 'LIVE' })
    expect(data.preview.bases).toHaveLength(3)
    expect(data.preview.bases[0].items.find((item: { key: string }) => item.key === 'REVENUE')).toMatchObject({ value: 1000, state: 'OK' })
    expect(data.actions.check.allowed).toBe(true)
    expect(data.actions.approve).toMatchObject({ allowed: false })
    expect(data.actions.reopen.reason).toContain('finance.period.reopen')
    expect(data.snapshots).toEqual([])
    expect(data.diff).toBeNull()
  })

  it('没有利润字段权限：预览只显示受限提示、不查利润日表；没有成本字段权限：三项成本不给数', async () => {
    const noProfit = await open(['finance.read'], { migratedRole: true })
    const res = await noProfit.call('GET', '/finance/periods/p1')
    expect(res.status).toBe(200)
    expect(res.json.data.preview).toMatchObject({ state: 'RESTRICTED', bases: [] })
    expect(noProfit.prisma.profitDaily.aggregate).not.toHaveBeenCalled()
    const noCost = await open(['finance.read', 'field.profit'], { migratedRole: true })
    const items = (await noCost.call('GET', '/finance/periods/p1')).json.data.preview.bases[0].items
    expect(items.find((item: { key: string }) => item.key === 'PRODUCT_COST')).toMatchObject({ value: null, state: 'RESTRICTED' })
    expect(items.find((item: { key: string }) => item.key === 'REVENUE').value).toBe(1000)
  })

  it('已关账：预览读快照而不是实时数据；快照列表带修订号、锁定人与汇率、成本版本数', async () => {
    const snapshot = {
      revision: 1,
      lockedBy: 'user-1',
      lockedAt: new Date('2026-10-01T00:00:00Z'),
      diffJson: null,
      profitSnapshotJson: {
        version: 1,
        metricVersions: ['profit-v1'],
        from: '2025-03-01',
        to: '2025-03-31',
        bases: Object.fromEntries(
          ['ORDERED', 'SHIPPED', 'SETTLED'].map(basis => [
            basis,
            {
              totals: {
                units: 10,
                costedUnits: 10,
                revenue: 777,
                refunds: 0,
                feeCommission: 0,
                feeFulfillment: 0,
                feeStorage: 0,
                feeAged: 0,
                feeInbound: 0,
                feeOther: 0,
                promotion: 0,
                adsSpendAllocated: null,
                adsUnallocated: null,
                productCost: 100,
                firstMileCost: null,
                otherCost: null,
                reimbursement: 0,
                rows: 3,
                incompleteRows: 0,
                profit: 500,
              },
              skus: [],
              skuCount: 0,
              truncated: false,
            },
          ]),
        ),
      },
      fxSnapshotJson: { from: '2025-03-01', to: '2025-03-31', currencies: ['CNY'], rates: [{ quote: 'CNY', date: '2025-03-03', rate: 7.1, source: 'ECB', fallback: false, manual: false }] },
      costVersionSnapshotJson: {
        asOf: '2025-03-31',
        skuCount: 1,
        truncated: false,
        versions: [{ sku: 'A', versionNo: 1, status: 'ACTIVE', effectiveFrom: '2025-01-01', currency: 'CNY', productCost: 20, firstMileCost: null, otherCost: null }],
      },
    }
    const { call, prisma } = await open(CLOSER, { period: periodRow({ status: 'CLOSED', closeCount: 1 }), snapshots: [snapshot] })
    const res = await call('GET', '/finance/periods/p1')
    expect(res.json.data.preview).toMatchObject({ source: 'SNAPSHOT', costVersions: 1, fx: { currencies: ['CNY'], rates: 1 } })
    expect(res.json.data.preview.bases[0].items.find((item: { key: string }) => item.key === 'REVENUE').value).toBe(777)
    expect(res.json.data.snapshots).toMatchObject([{ revision: 1, lockedBy: '财务小王', fxRates: 1, costVersions: 1, hasDiff: false }])
    expect(res.json.data.snapshots[0].bases[0]).toMatchObject({ basis: 'ORDERED', revenue: 777, netProfit: 500 })
    expect(res.json.data.actions.reopen.allowed).toBe(false)
    expect(prisma.profitDaily.aggregate).not.toHaveBeenCalled()
  })
})

describe('创建期间', () => {
  it('成功返回 201 并写审计；一个店铺一个月份', async () => {
    const { call, prisma } = await open(CLOSER)
    const res = await call('POST', '/finance/periods', { body: { sellerAccountId: 's1', month: '2025-03' } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'p9', status: 'OPEN', statusLabel: '开放' })
    const data = prisma.accountingPeriod.create.mock.calls[0]![0].data
    expect(data).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', createdBy: 'user-1' })
    expect(data.periodStart.toISOString()).toBe('2025-03-01T00:00:00.000Z')
    expect(data.periodEnd.toISOString()).toBe('2025-03-31T00:00:00.000Z')
    expect(audit(prisma)[0]).toMatchObject({ action: 'PERIOD_CREATED', resourceType: 'AccountingPeriod' })
  })

  it('参数不合法 422；还没结束的月份、太早的月份 422；店铺不存在 404；店铺在范围外 403；重复 409', async () => {
    const { call, prisma } = await open(CLOSER)
    for (const body of [{ sellerAccountId: 's1', month: '2025-3' }, { sellerAccountId: 's1' }, { month: '2025-03' }, { sellerAccountId: 's1', month: '2025-03', extra: 1 }]) {
      expect((await call('POST', '/finance/periods', { body })).status).toBe(422)
    }
    const nowMonth = new Date().toISOString().slice(0, 7)
    const future = await call('POST', '/finance/periods', { body: { sellerAccountId: 's1', month: nowMonth } })
    expect(future.status).toBe(422)
    expect(future.json.error.fieldErrors.month).toBeDefined()
    expect((await call('POST', '/finance/periods', { body: { sellerAccountId: 's1', month: '2010-01' } })).status).toBe(422)
    expect(prisma.accountingPeriod.create).not.toHaveBeenCalled()
    prisma.sellerAccount.findFirst.mockResolvedValue(null)
    expect((await call('POST', '/finance/periods', { body: { sellerAccountId: 'sX', month: '2025-03' } })).status).toBe(404)
    prisma.sellerAccount.findFirst.mockResolvedValue({ id: 's1', displayName: '美国主店' })
    prisma.accountingPeriod.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    expect((await call('POST', '/finance/periods', { body: { sellerAccountId: 's1', month: '2025-03' } })).status).toBe(409)
    const scoped = await open(CLOSER, { over: S2_ONLY })
    expect((await scoped.call('POST', '/finance/periods', { body: { sellerAccountId: 's1', month: '2025-03' } })).status).toBe(403)
  })
})

describe('完整性检查', () => {
  it('全部通过：进入关账中，带版本号更新，清掉旧的审批，写审计', async () => {
    const { call, prisma } = await open(CLOSER)
    const res = await call('POST', '/finance/periods/p1/check', { body: {} })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'p1', status: 'CLOSING', statusLabel: '关账中', passed: true, version: 2 })
    expect(res.json.data.checklist.items).toHaveLength(6)
    const update = prisma.accountingPeriod.updateMany.mock.calls[0]![0]
    expect(update.where).toMatchObject({ id: 'p1', tenantId: 'tenant-1', version: 1 })
    expect(update.data).toMatchObject({ status: 'CLOSING', checkedBy: 'user-1', approvalDecision: null, approvedBy: null, version: { increment: 1 } })
    expect(audit(prisma)[0]).toMatchObject({ action: 'PERIOD_CHECKED', afterJson: { status: 'CLOSING', passed: true } })
  })

  it('广告分摊尚未接入：不通过，状态仍是开放；确认放行（写明原因）后通过，并记下放行的人与原因', async () => {
    const { call, prisma } = await open(CLOSER, { adsAllocatedRows: 0 })
    const first = await call('POST', '/finance/periods/p1/check', { body: {} })
    expect(first.json.data).toMatchObject({ passed: false, status: 'OPEN' })
    const ads = first.json.data.checklist.items.find((item: { key: string }) => item.key === 'ADS_ALLOCATED')
    expect(ads).toMatchObject({ state: 'NOT_CONNECTED', acknowledgeable: true })
    const second = await call('POST', '/finance/periods/p1/check', { body: { acknowledgements: [{ key: 'ADS_ALLOCATED', note: '广告分摊要到广告阶段才上线' }] } })
    expect(second.json.data).toMatchObject({ passed: true, status: 'CLOSING' })
    const acked = second.json.data.checklist.items.find((item: { key: string }) => item.key === 'ADS_ALLOCATED')
    expect(acked).toMatchObject({ state: 'ACKNOWLEDGED', baseState: 'NOT_CONNECTED', acknowledgement: { by: '财务小王', note: '广告分摊要到广告阶段才上线' } })
    expect(audit(prisma)[1].detail.acknowledged[0]).toMatchObject({ key: 'ADS_ALLOCATED' })
  })

  it('数据缺口不能确认放行；多余的确认、没写原因的确认都是 422', async () => {
    const gap = await open(CLOSER, { settlements: [] })
    const res = await gap.call('POST', '/finance/periods/p1/check', { body: {} })
    expect(res.json.data.passed).toBe(false)
    expect(res.json.data.checklist.items.find((item: { key: string }) => item.key === 'SETTLEMENTS_ARRIVED').state).toBe('FAIL')
    expect((await gap.call('POST', '/finance/periods/p1/check', { body: { acknowledgements: [{ key: 'SETTLEMENTS_ARRIVED', note: '想放行' }] } })).status).toBe(422)
    const ok = await open(CLOSER)
    const needless = await ok.call('POST', '/finance/periods/p1/check', { body: { acknowledgements: [{ key: 'RECON_EXCEPTIONS', note: '没有异常也确认' }] } })
    expect(needless.status).toBe(422)
    expect((await ok.call('POST', '/finance/periods/p1/check', { body: { acknowledgements: [{ key: 'RECON_EXCEPTIONS', note: '' }] } })).status).toBe(422)
    expect(ok.prisma.accountingPeriod.updateMany).not.toHaveBeenCalled()
  })

  it('同步没覆盖到期间结束、对账有未处理异常：不通过并说明原因', async () => {
    const { call } = await open(CLOSER, { freshness: [{ sourceKey: 'orders.api', status: 'NORMAL', dataThrough: new Date('2025-03-30T00:00:00Z'), lastSuccessAt: null }], openExceptions: 2 })
    const res = await call('POST', '/finance/periods/p1/check', { body: {} })
    const items = res.json.data.checklist.items as Array<{ key: string; state: string; summary: string; details: string[] }>
    expect(items.find(item => item.key === 'SYNC_COMPLETE')).toMatchObject({ state: 'FAIL' })
    expect(items.find(item => item.key === 'SYNC_COMPLETE')!.details.join('')).toContain('财务交易：尚无同步记录')
    expect(items.find(item => item.key === 'RECON_EXCEPTIONS')).toMatchObject({ state: 'FAIL' })
  })

  it('已关账的期间不能检查；关账过又重开的期间检查没通过回到“重新开账”', async () => {
    const closed = await open(CLOSER, { period: periodRow({ status: 'CLOSED', closeCount: 1 }) })
    expect((await closed.call('POST', '/finance/periods/p1/check', { body: {} })).status).toBe(409)
    expect(closed.prisma.accountingPeriod.updateMany).not.toHaveBeenCalled()
    const reopened = await open(CLOSER, { period: periodRow({ status: 'REOPENED', closeCount: 1 }), settlements: [] })
    expect((await reopened.call('POST', '/finance/periods/p1/check', { body: {} })).json.data).toMatchObject({ passed: false, status: 'REOPENED' })
  })
})

describe('审批', () => {
  const closing = (over: Record<string, unknown> = {}) => periodRow({ status: 'CLOSING', version: 3, checkedBy: 'user-2', checklistJson: passedChecklist, ...over })

  it('另一个人审批通过：只记审批，状态仍是关账中，等待锁定', async () => {
    const { call, prisma } = await open(CLOSER, { period: closing() })
    const res = await call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'APPROVED', comment: '数字核对无误' } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ status: 'CLOSING' })
    const update = prisma.accountingPeriod.updateMany.mock.calls[0]![0]
    expect(update.where).toMatchObject({ version: 3 })
    expect(update.data).toMatchObject({ approvalDecision: 'APPROVED', approvedBy: 'user-1', approvalComment: '数字核对无误' })
    expect(audit(prisma)[0]).toMatchObject({ action: 'PERIOD_APPROVED', reason: '数字核对无误' })
  })

  it('发起检查的人不能审批自己的检查；不是关账中不能审批；重复审批不行', async () => {
    const self = await open(CLOSER, { period: closing({ checkedBy: 'user-1' }) })
    const res = await self.call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'APPROVED' } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('不能审批')
    expect(self.prisma.accountingPeriod.updateMany).not.toHaveBeenCalled()
    const wrong = await open(CLOSER, { period: periodRow() })
    expect((await wrong.call('POST', '/finance/periods/p1/approve', { body: { version: 1, decision: 'APPROVED' } })).status).toBe(409)
    const done = await open(CLOSER, { period: closing({ approvalDecision: 'APPROVED', approvedBy: 'user-2' }) })
    expect((await done.call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'APPROVED' } })).status).toBe(409)
  })

  it('驳回必须写意见，驳回后回到开放（重开过的回到重新开账）', async () => {
    const { call, prisma } = await open(CLOSER, { period: closing() })
    expect((await call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'REJECTED' } })).status).toBe(422)
    const res = await call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'REJECTED', comment: '成本不对' } })
    expect(res.json.data).toMatchObject({ status: 'OPEN' })
    expect(prisma.accountingPeriod.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'OPEN', approvalDecision: 'REJECTED' })
    expect(audit(prisma)[0]).toMatchObject({ action: 'PERIOD_REJECTED', reason: '成本不对' })
    const again = await open(CLOSER, { period: closing({ closeCount: 1 }) })
    expect((await again.call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'REJECTED', comment: '重来' } })).json.data.status).toBe('REOPENED')
  })

  it('版本号过期 409；缺版本号 422', async () => {
    const { call, prisma } = await open(CLOSER, { period: closing() })
    prisma.accountingPeriod.updateMany.mockResolvedValue({ count: 0 })
    prisma.accountingPeriod.findFirst.mockImplementation(async (args: { select?: Record<string, unknown> }) => (args.select && 'sellerAccount' in args.select ? closing() : { version: 4 }))
    const stale = await call('POST', '/finance/periods/p1/approve', { body: { version: 3, decision: 'APPROVED' } })
    expect(stale.status).toBe(409)
    expect((await call('POST', '/finance/periods/p1/approve', { body: { decision: 'APPROVED' } })).status).toBe(422)
  })
})
