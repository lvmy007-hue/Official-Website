import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 支持案件接口（P2b-04）：权限先于参数校验、数据范围、列表状态（没同步 / 没案件 / 受限角色没批）、详情的沟通记录与关联、只读（没有写入口）。

const none = () => vi.fn().mockResolvedValue([])
const caseRecord = (over: Record<string, unknown> = {}) => ({
  id: 'sc1',
  caseId: '9876543210',
  sellerAccountId: 's1',
  subject: '货件 FBA15ABCDE 少收 12 件',
  status: 'PENDING_AMAZON_ACTION',
  amazonCreatedAt: new Date('2026-10-20T03:00:00Z'),
  amazonUpdatedAt: new Date('2026-10-22T05:00:00Z'),
  amazonResolvedAt: null,
  lastOutboundAt: null,
  contactsForUpdatedAt: new Date('2026-10-22T05:00:00Z'),
  contactCount: 2,
  appointmentsJson: [{ appointmentId: 'a1', status: 'SCHEDULED', earliestAt: '2026-10-25T01:00:00.000Z', latestAt: '2026-10-25T02:00:00.000Z', answeringParty: null }],
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const contactRecord = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  contactId: 'ct-1',
  channel: 'EMAIL',
  direction: 'FROM_AMAZON',
  senderName: 'Amazon Seller Support',
  body: '请提供入库证据。',
  attachmentsJson: ['照片.png'],
  occurredAt: new Date('2026-10-20T03:00:00Z'),
  ...over,
})
const freshnessRow = (over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  sourceKey: 'support.api',
  lastAttemptAt: new Date(),
  lastSuccessAt: new Date(),
  dataThrough: null,
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  return {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    supportCase: { findMany: vi.fn().mockResolvedValue([caseRecord()]), findFirst: vi.fn().mockResolvedValue(caseRecord()) },
    supportContact: { findMany: vi.fn().mockResolvedValue([contactRecord()]) },
    reimbursementCase: { findMany: none(), findFirst: vi.fn().mockResolvedValue(null) },
    fbaInboundShipment: { findMany: none() },
    fbaProduct: { findFirst: vi.fn().mockResolvedValue(null) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([freshnessRow()]) },
    ...over,
  } as unknown as Record<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>>
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

describe('权限、范围与只读', () => {
  it('未登录 401；没有 support.read 时列表与详情 403（先于参数校验）', async () => {
    const { call } = await open(['support.read'])
    expect((await call('GET', '/support-cases', { auth: false })).status).toBe(401)
    await harness?.close()
    const denied = await open(['seller.read'])
    for (const path of ['/support-cases?pageSize=99999', '/support-cases/sc1']) expect((await denied.call('GET', path)).status, path).toBe(403)
  })

  it('没有写入口：POST、PATCH、DELETE 都不存在', async () => {
    const { call } = await open(['support.read'])
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) expect((await call(method, '/support-cases/sc1', { body: {} })).status, method).toBe(404)
    expect((await call('POST', '/support-cases', { body: {} })).status).toBe(404)
  })

  it('查询一律带企业条件；数据范围收窄到一个店铺时按店铺过滤，范围外的案件详情 404', async () => {
    const scoped = {
      membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) },
      supportCase: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    }
    const { call, prisma } = await open(['support.read'], scoped)
    await call('GET', '/support-cases')
    expect(JSON.stringify(prisma.supportCase.findMany.mock.calls[0][0].where)).toMatch(/tenant-1[\s\S]*s1/)
    expect((await call('GET', '/support-cases/other')).status).toBe(404)
    expect(JSON.stringify(prisma.supportCase.findFirst.mock.calls[0][0].where)).toContain('s1')
    expect((await call('GET', '/support-cases/bad%20id')).status).toBe(404)
  })
})

describe('列表', () => {
  it('字段、状态中文名、沟通条数；游标多取一行；按最近更新新到旧；筛选状态与关键词', async () => {
    const { call, prisma } = await open(['support.read'])
    const res = await call('GET', '/support-cases?pageSize=20&status=PENDING_AMAZON_ACTION&q=FBA15')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.state).toBe('OK')
    expect(data.items[0]).toMatchObject({ id: 'sc1', caseId: '9876543210', statusLabel: '等待亚马逊处理', storeName: '美国主店', contactCount: 2 })
    expect(data.sync).toMatchObject({ status: 'NORMAL', rolePending: false })
    const args = prisma.supportCase.findMany.mock.calls[0][0]
    expect(args.take).toBe(21)
    expect(JSON.stringify(args.where)).toContain('PENDING_AMAZON_ACTION')
    expect(JSON.stringify(args.where)).toContain('FBA15')
    expect(JSON.stringify(args.orderBy)).toContain('amazonUpdatedAt')
  })

  it('沟通记录还没同步的案件：沟通条数是空，不是 0', async () => {
    const { call } = await open(['support.read'], { supportCase: { findMany: vi.fn().mockResolvedValue([caseRecord({ contactsForUpdatedAt: null, contactCount: 0 })]), findFirst: vi.fn() } })
    expect((await call('GET', '/support-cases')).json.data.items[0].contactCount).toBeNull()
  })

  it('没有案件：同步正常写“尚无记录”；从没同步写“尚未同步”；受限角色没批给申请方式', async () => {
    const empty = { supportCase: { findMany: none(), findFirst: vi.fn() } }
    const normal = await open(['support.read'], empty)
    const ok = (await normal.call('GET', '/support-cases')).json.data
    expect(ok).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(ok.note).toContain('尚无记录')
    await harness?.close()
    const never = await open(['support.read'], { ...empty, dataFreshness: { findMany: none() } })
    const notSynced = (await never.call('GET', '/support-cases')).json.data
    expect(notSynced).toMatchObject({ state: 'NOT_CONNECTED' })
    expect(notSynced.note).toContain('尚未同步')
    await harness?.close()
    const pending = await open(['support.read'], {
      ...empty,
      dataFreshness: { findMany: vi.fn().mockResolvedValue([freshnessRow({ status: 'UNAUTHORIZED', lastSuccessAt: null, lastErrorCode: 'SUP_ROLE_PENDING' })]) },
    })
    const guide = (await pending.call('GET', '/support-cases')).json.data
    expect(guide).toMatchObject({ state: 'ROLE_PENDING', sync: { rolePending: true, status: 'UNAUTHORIZED' } })
    expect(guide.note).toContain('Selling Partner Support')
  })

  it('有赔付读取权限时带赔付案件关联；没有就不带（不借支持案件看赔付）', async () => {
    const withLink = () => ({ reimbursementCase: { findMany: vi.fn().mockResolvedValue([{ id: 'c1', caseNo: 'PC-1', amazonCaseId: '9876543210' }]), findFirst: vi.fn() } })
    const allowed = await open(['support.read', 'reimbursements.read'], withLink())
    expect((await allowed.call('GET', '/support-cases')).json.data.items[0]).toMatchObject({ reimbursementCaseId: 'c1', reimbursementCaseNo: 'PC-1' })
    await harness?.close()
    const limited = await open(['support.read'], withLink())
    expect((await limited.call('GET', '/support-cases')).json.data.items[0]).toMatchObject({ reimbursementCaseId: null, reimbursementCaseNo: null })
    expect(limited.prisma.reimbursementCase.findMany).not.toHaveBeenCalled()
  })
})

describe('详情', () => {
  it('案件、预约回电（没有电话号码）、沟通记录从早到晚、附件只有名称；按系统编号或亚马逊案件编号都能找', async () => {
    const { call, prisma } = await open(['support.read'])
    const res = await call('GET', '/support-cases/9876543210')
    expect(res.status).toBe(200)
    const { data } = res.json
    expect(data.case).toMatchObject({ id: 'sc1', caseId: '9876543210', contactCount: 2 })
    expect(data.appointments).toEqual([
      { appointmentId: 'a1', status: 'SCHEDULED', statusLabel: '已预约', earliestAt: '2026-10-25T01:00:00.000Z', latestAt: '2026-10-25T02:00:00.000Z', answeringParty: null },
    ])
    expect(data.contacts[0]).toMatchObject({ directionLabel: '亚马逊', channelLabel: '邮件', attachments: ['照片.png'] })
    expect(data.contactsState).toBe('OK')
    expect(prisma.supportContact.findMany.mock.calls[0][0].orderBy).toEqual([{ occurredAt: 'asc' }, { id: 'asc' }])
    expect(JSON.stringify(prisma.supportCase.findFirst.mock.calls[0][0].where)).toMatch(/"id":"9876543210"[\s\S]*"caseId":"9876543210"/)
  })

  it('沟通记录没同步：写原因，不当作没有沟通；案件更新后还没重取：提示最新的会在下次同步取回', async () => {
    const fresh = await open(['support.read'], {
      supportCase: { findFirst: vi.fn().mockResolvedValue(caseRecord({ contactsForUpdatedAt: null })), findMany: none() },
      supportContact: { findMany: none() },
    })
    const first = (await fresh.call('GET', '/support-cases/sc1')).json.data
    expect(first).toMatchObject({ contactsState: 'NOT_SYNCED', contacts: [] })
    expect(first.contactsNote).toContain('尚未同步')
    await harness?.close()
    const stale = await open(['support.read'], { supportCase: { findFirst: vi.fn().mockResolvedValue(caseRecord({ contactsForUpdatedAt: new Date('2026-10-21T00:00:00Z') })), findMany: none() } })
    const second = (await stale.call('GET', '/support-cases/sc1')).json.data
    expect(second.contactsState).toBe('OK')
    expect(second.contactsNote).toContain('下一次同步')
  })

  it('关联：赔付案件（编号一致）、货件（只给我们自己货件里存在的编号）、商品；缺对应模块读取权限就不给', async () => {
    const over = () => ({
      reimbursementCase: {
        findMany: none(),
        findFirst: vi.fn().mockResolvedValue({ id: 'c1', caseNo: 'PC-1', status: 'SUBMITTED', sku: 'SKU-1', evidenceRefsJson: [{ kind: 'SHIPMENT', id: 'sh1', label: '货件' }] }),
      },
      fbaInboundShipment: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'sh1', shipmentId: 'FBA15EVID1' }])
          .mockResolvedValueOnce([{ shipmentId: 'FBA15ABCDE' }]),
      },
      fbaProduct: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', sellerSku: 'SKU-1', asin: 'B0AAAAAAA1' }) },
    })
    const full = await open(['support.read', 'reimbursements.read', 'inbound.read', 'products.read'], over())
    const { links, case: row } = (await full.call('GET', '/support-cases/sc1')).json.data
    expect(links.reimbursement).toEqual({ id: 'c1', caseNo: 'PC-1', statusLabel: '已提交' })
    expect(links.shipments).toEqual([
      { ref: 'FBA15EVID1', label: '货件 FBA15EVID1', via: 'EVIDENCE' },
      { ref: 'FBA15ABCDE', label: '货件 FBA15ABCDE', via: 'SUBJECT' },
    ])
    expect(links.products).toEqual([{ id: 'p1', sku: 'SKU-1', asin: 'B0AAAAAAA1' }])
    expect(row.reimbursementCaseNo).toBe('PC-1')
    await harness?.close()
    const only = await open(['support.read'], over())
    expect((await only.call('GET', '/support-cases/sc1')).json.data.links).toEqual({ reimbursement: null, shipments: [], products: [] })
    expect(only.prisma.reimbursementCase.findFirst).not.toHaveBeenCalled()
  })
})
