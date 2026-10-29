import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { costsPrisma, daysAgo, dec, versionRow, type CostsStubOptions } from '../../testing/costs-stub'

// 商品成本接口（P2b-14）：权限先于参数校验、成本字段权限、数据范围、列表与详情、录入、导入、确认生效、改与丢弃草稿、版本对比。
// 迁移后的角色（version 2）下 costs.read 不再顺带带出 field.cost，所以这里一律用迁移后的角色，权限点按需给。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], options: CostsStubOptions = {}) => {
  await harness?.close()
  const prisma = costsPrisma(permissions, { migratedRole: true, ...options })
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const READER = ['costs.read', 'field.cost']
const WRITER = [...READER, 'costs.write']
const S2_ONLY = {
  membershipScope: { findMany: async () => [{ legalEntityId: null, sellerAccountId: 's2' }] },
  sellerAccount: { findMany: async () => [{ id: 's2', displayName: '欧洲店' }], findFirst: async () => ({ id: 's2', displayName: '欧洲店' }) },
}
const today = () => daysAgo(0)
const draft = (over: Record<string, unknown> = {}) =>
  versionRow({ id: 'cv2', versionNo: 2, status: 'DRAFT', version: 1, activatedBy: null, activatedAt: null, effectiveFrom: today(), unitProductCost: dec('12'), ...over })
const actions = (prisma: Awaited<ReturnType<typeof open>>['prisma']) => prisma.auditEvent.create.mock.calls.map(([args]) => (args as { data: { action: string } }).data.action)
const NEW_BODY = { sku: 'SKU-A', effectiveFrom: daysAgo(0).toISOString().slice(0, 10), currency: 'usd', unitProductCost: 12.5 }

describe('权限与范围', () => {
  it('未登录 401；没有 costs.read 或没有 field.cost 403 且先于参数校验', async () => {
    const { call } = await open(READER)
    expect((await call('GET', '/costs', { auth: false })).status).toBe(401)
    for (const permissions of [['seller.read'], ['costs.read']]) {
      const denied = await open(permissions)
      expect((await denied.call('GET', '/costs?coverage=NOPE&pageSize=9999')).status).toBe(403)
      expect((await denied.call('GET', '/costs/SKU-A')).status).toBe(403)
      expect(denied.prisma.costVersion.groupBy).not.toHaveBeenCalled()
      expect(denied.prisma.costVersion.findMany).not.toHaveBeenCalled()
    }
  })

  it('只读账号不能录入、导入、生效、改、丢弃；写入前不碰数据库', async () => {
    const { call, prisma } = await open(READER)
    const attempts = [
      call('POST', '/costs', { body: NEW_BODY }),
      call('POST', '/costs/import', { body: { fileName: 'a.csv', content: 'x' } }),
      call('POST', '/costs/activate', { body: { items: [{ id: 'cv2', version: 1 }] } }),
      call('PATCH', '/costs/versions/cv2', { body: { version: 1, note: 'x' } }),
      call('DELETE', '/costs/versions/cv2?version=1'),
    ]
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403)
    for (const name of ['create', 'createMany', 'updateMany', 'deleteMany'] as const) expect(prisma.costVersion[name]).not.toHaveBeenCalled()
    // 被拒绝的写入只留“被拒绝”的审计，没有任何成功的记录
    expect(prisma.auditEvent.create.mock.calls.every(([args]) => (args as { data: { result: string } }).data.result === 'DENIED')).toBe(true)
  })

  it('受限数据范围的成员只看范围内店铺的商品，不能写（成本在企业层面）', async () => {
    const { call, prisma } = await open(WRITER, { over: S2_ONLY })
    const list = await call('GET', '/costs')
    expect(list.status).toBe(200)
    expect(list.json.data.canWrite).toBe(false)
    expect(JSON.stringify(prisma.fbaProduct.groupBy.mock.calls[0]![0].where)).toContain('s2')
    const res = await call('POST', '/costs', { body: NEW_BODY })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    expect(prisma.costVersion.create).not.toHaveBeenCalled()
  })

  it('范围外的 SKU 与不存在一样返回 404', async () => {
    const { call } = await open(READER, { hasProduct: false, versions: [] })
    expect((await call('GET', '/costs/NOPE')).status).toBe(404)
    expect((await call('GET', '/costs/NOPE/compare?a=x&b=y')).status).toBe(404)
  })
})

describe('列表', () => {
  it('每个 SKU 一行：当前各项成本、到岸成本、覆盖状态、各状态个数、可写标记', async () => {
    const { call } = await open(WRITER, { versions: [versionRow({ unitFirstMileCost: dec('1.5'), id: 'cv1' }), draft()] })
    const res = await call('GET', '/costs')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ state: 'OK', canWrite: true, truncated: false, draftSkus: 1, summary: { COVERED: 1, STALE: 0, DRAFT_ONLY: 0, MISSING: 0 } })
    expect(data.items[0]).toMatchObject({ sku: 'SKU-A', title: '示例商品', coverage: 'COVERED', landedUsd: 11.5, landedState: 'OK', activeCount: 1, draftCount: 1 })
    expect(data.items[0].parts.product).toMatchObject({ amount: '10', currency: 'USD', usd: 10, versionNo: 1, source: 'MANUAL' })
    expect(data.items[0].parts.duty).toBeNull()
    expect(data.pageInfo).toMatchObject({ hasMore: false, nextCursor: null, approxTotal: 1 })
    expect((await open(READER).then(({ call: readerCall }) => readerCall('GET', '/costs'))).json.data.canWrite).toBe(false)
  })

  it('筛选：覆盖状态、只看有草稿的、SKU 关键字；没有符合的给出提示', async () => {
    const { call } = await open(READER, { versions: [versionRow({ effectiveFrom: daysAgo(400) })] })
    expect((await call('GET', '/costs?coverage=STALE')).json.data.items).toHaveLength(1)
    const none = (await call('GET', '/costs?coverage=MISSING')).json.data
    expect(none.items).toEqual([])
    expect(none.note).toContain('没有符合条件')
    expect((await call('GET', '/costs?draft=true')).json.data.items).toEqual([])
    expect((await call('GET', '/costs?q=sku-a')).json.data.items).toHaveLength(1)
    expect((await call('GET', '/costs?q=zzz')).json.data.items).toEqual([])
  })

  it('没有商品也没有成本：NO_DATA；不合法的参数 422', async () => {
    const empty = await open(READER, { hasProduct: false, versions: [] })
    expect((await empty.call('GET', '/costs')).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
    const { call } = await open(READER)
    expect((await call('GET', '/costs?coverage=NOPE')).status).toBe(422)
    expect((await call('GET', '/costs?sort=title')).status).toBe(422)
    expect((await call('GET', '/costs?cursor=garbage')).status).toBe(400)
  })
})

describe('详情与对比', () => {
  it('版本时间线、来源、构成、没有库存报告时的估算说明', async () => {
    const { call } = await open(READER, { versions: [draft({ unitProductCost: null, unitDutyCost: dec('2') }), versionRow({ unitFirstMileCost: dec('1') })] })
    const res = await call('GET', '/costs/SKU-A')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ sku: 'SKU-A', title: '示例商品', canWrite: false, versionsTruncated: false })
    expect(data.versions.map((item: { versionNo: number }) => item.versionNo)).toEqual([2, 1])
    expect(data.versions[0]).toMatchObject({ status: 'DRAFT', statusLabel: '草稿', sourceLabel: '手工录入', editable: 'ALL', canDiscard: true, duty: '2' })
    expect(data.versions[1]).toMatchObject({ status: 'ACTIVE', createdByName: '采购小李', activatedByName: '采购小李', canDiscard: false })
    expect(data.composition.slices.map((item: { component: string }) => item.component)).toEqual(['product', 'firstMile'])
    expect(data.composition.totalUsd).toBe(11)
    expect(data.pricing).toMatchObject({ product: 'PRICE', firstMile: 'PRICE', duty: null })
    expect(data.valuation).toMatchObject({ state: 'NO_STOCK_DATA', method: 'FIFO', onHandUnits: null, valueUsd: null })
    expect(data.notes.length).toBeGreaterThan(2)
  })

  it('有库存规划报告：按企业的计价方法估算库存成本', async () => {
    const snapshot = [{ sellerAccountId: 's1', snapshotDate: daysAgo(1), available: 7 }]
    const { call, prisma } = await open(READER, { over: { inventoryPlanningSnapshot: { findMany: async () => snapshot } } })
    const res = await call('GET', '/costs/SKU-A')
    expect(res.json.data.valuation).toMatchObject({ state: 'OK', onHandUnits: 7, valueUsd: 70, uncoveredUnits: 0 })
    expect(prisma.tenantSetting.findFirst).toHaveBeenCalled()
  })

  it('版本对比：同币种给差额与百分比；版本不属于这个 SKU 404；缺参数 422', async () => {
    const newer = versionRow({ id: 'cv3', versionNo: 3, unitProductCost: dec('12.5'), effectiveFrom: daysAgo(2) })
    const { call } = await open(READER, { versions: [versionRow(), newer] })
    const res = await call('GET', '/costs/SKU-A/compare?a=cv1&b=cv3')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ sameCurrency: true, effectiveDays: 8 })
    expect(res.json.data.rows[0]).toMatchObject({ component: 'product', a: '10', b: '12.5', delta: 2.5, deltaPct: 0.25 })
    expect((await call('GET', '/costs/SKU-A/compare?a=cv1&b=nope')).status).toBe(404)
    expect((await call('GET', '/costs/SKU-A/compare?a=cv1')).status).toBe(422)
  })
})

describe('录入', () => {
  it('新建手工草稿：版本号递增、币种转大写、写审计；草稿不参与利润', async () => {
    const { call, prisma } = await open(WRITER)
    const res = await call('POST', '/costs', { body: NEW_BODY })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ status: 'DRAFT', versionNo: 2 })
    expect(res.json.data.message).toContain('草稿')
    const data = prisma.costVersion.create.mock.calls[0]![0].data
    expect(data).toMatchObject({
      tenantId: 'tenant-1',
      sku: 'SKU-A',
      versionNo: 2,
      currency: 'USD',
      source: 'MANUAL',
      status: 'DRAFT',
      unitProductCost: 12.5,
      unitFirstMileCost: null,
      createdBy: 'user-1',
    })
    expect(actions(prisma)).toContain('COST_VERSION_CREATED')
    expect(prisma.costVersion.updateMany).not.toHaveBeenCalled()
  })

  it('校验：四项成本至少一项、不能为负、最多六位小数、日期不能晚于一年后、未知字段、SKU 必须存在', async () => {
    const { call, prisma } = await open(WRITER)
    const bad = async (body: Record<string, unknown>) => (await call('POST', '/costs', { body: { ...NEW_BODY, ...body } })).status
    expect(await bad({ unitProductCost: undefined })).toBe(422)
    expect(await bad({ unitProductCost: -1 })).toBe(422)
    expect(await bad({ unitProductCost: 1.1234567 })).toBe(422)
    expect(await bad({ currency: 'US' })).toBe(422)
    expect(await bad({ effectiveFrom: '2026-02-30' })).toBe(422)
    expect(await bad({ effectiveFrom: '2099-01-01' })).toBe(422)
    expect(await bad({ extra: 1 })).toBe(422)
    expect(prisma.costVersion.create).not.toHaveBeenCalled()
    const unknown = await open(WRITER, { hasProduct: false, versions: [] })
    const res = await unknown.call('POST', '/costs', { body: NEW_BODY })
    expect(res.status).toBe(422)
    expect(res.json.error.fieldErrors.sku).toBeDefined()
  })

  it('新建并生效：同一个事务里草稿变生效中，写创建与生效两条审计', async () => {
    const created = draft({ id: 'cv9', versionNo: 2 })
    const { call, prisma } = await open(WRITER, { versions: [versionRow({ effectiveFrom: daysAgo(10) }), created] })
    const res = await call('POST', '/costs', { body: { ...NEW_BODY, activate: true } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ status: 'ACTIVE' })
    expect(actions(prisma)).toEqual(['COST_VERSION_CREATED', 'COST_VERSION_ACTIVATED'])
    expect(prisma.costVersion.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'ACTIVE', activatedBy: 'user-1' })
  })
})

describe('确认生效', () => {
  it('同一生效日已有生效的价格版本：旧版本被替换，两条版本变更各写审计', async () => {
    const old = versionRow({ id: 'cv1', effectiveFrom: today() })
    const { call, prisma } = await open(WRITER, { versions: [old, draft()] })
    const res = await call('POST', '/costs/activate', { body: { items: [{ id: 'cv2', version: 1 }] } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ activated: 1, replaced: 1, versions: [{ id: 'cv2', sku: 'SKU-A', replacedVersionNos: [1] }] })
    expect(prisma.costVersion.updateMany.mock.calls.map(([args]) => (args as { data: { status: string } }).data.status)).toEqual(['REPLACED', 'ACTIVE'])
    expect(actions(prisma)).toEqual(['COST_VERSION_REPLACED', 'COST_VERSION_ACTIVATED'])
  })

  it('生效日落在已关账期间：拒绝并说明期间；一个失败整批不生效', async () => {
    const closed = [{ periodStart: daysAgo(30), periodEnd: daysAgo(-3), status: 'CLOSED', sellerAccount: { displayName: '美国主店' } }]
    const { call, prisma } = await open(WRITER, { versions: [versionRow(), draft()], closed })
    const res = await call('POST', '/costs/activate', { body: { items: [{ id: 'cv2', version: 1 }] } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('已关账')
    expect(res.json.error.message).toContain('美国主店')
    expect(prisma.costVersion.updateMany).not.toHaveBeenCalled()
  })

  it('只有草稿能生效；版本不存在 409；请求体校验：至少一个、不重复、不超过上限', async () => {
    const { call } = await open(WRITER, { versions: [versionRow(), draft()] })
    expect((await call('POST', '/costs/activate', { body: { items: [{ id: 'cv1', version: 2 }] } })).status).toBe(409)
    expect((await call('POST', '/costs/activate', { body: { items: [{ id: 'ghost', version: 1 }] } })).status).toBe(409)
    expect((await call('POST', '/costs/activate', { body: { items: [] } })).status).toBe(422)
    expect(
      (
        await call('POST', '/costs/activate', {
          body: {
            items: [
              { id: 'cv2', version: 1 },
              { id: 'cv2', version: 1 },
            ],
          },
        })
      ).status,
    ).toBe(422)
    const many = Array.from({ length: 101 }, (_, index) => ({ id: `x${index}`, version: 1 }))
    expect((await call('POST', '/costs/activate', { body: { items: many } })).status).toBe(422)
  })

  it('同一生效日的旧版本带有新版本没有的成本项：拒绝，不悄悄丢掉', async () => {
    const old = versionRow({ id: 'cv1', effectiveFrom: today(), unitFirstMileCost: dec('1') })
    const { call, prisma } = await open(WRITER, { versions: [old, draft()] })
    const res = await call('POST', '/costs/activate', { body: { items: [{ id: 'cv2', version: 1 }] } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('头程分摊')
    expect(prisma.costVersion.updateMany).not.toHaveBeenCalled()
  })
})

describe('改与丢弃草稿', () => {
  it('改手工草稿：带版本号、写审计；已生效的版本不能改；至少改一项', async () => {
    const { call, prisma } = await open(WRITER, { versions: [versionRow(), draft()] })
    const res = await call('PATCH', '/costs/versions/cv2', { body: { version: 1, unitProductCost: 13, note: '涨价' } })
    expect(res.status).toBe(200)
    expect(prisma.costVersion.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'cv2', tenantId: 'tenant-1', version: 1 }, data: { unitProductCost: 13, note: '涨价' } })
    expect(actions(prisma)).toEqual(['COST_VERSION_UPDATED'])
    expect((await call('PATCH', '/costs/versions/cv1', { body: { version: 2, note: 'x' } })).status).toBe(409)
    expect((await call('PATCH', '/costs/versions/cv2', { body: { version: 1 } })).status).toBe(422)
    expect((await call('PATCH', '/costs/versions/cv2', { body: { version: 1, unitProductCost: null } })).status).toBe(422)
    expect((await call('PATCH', '/costs/versions/ghost', { body: { version: 1, note: 'x' } })).status).toBe(404)
  })

  it('系统生成的草稿（采购收货）只能改关税、其他成本、生效日、备注', async () => {
    const system = draft({ source: 'PURCHASE_RECEIPT', sourceDocId: 'po1' })
    const { call } = await open(WRITER, { versions: [system] })
    const blocked = await call('PATCH', '/costs/versions/cv2', { body: { version: 1, unitProductCost: 9 } })
    expect(blocked.status).toBe(422)
    expect(blocked.json.error.message).toContain('来源单据')
    expect((await call('PATCH', '/costs/versions/cv2', { body: { version: 1, unitDutyCost: 0.8 } })).status).toBe(200)
  })

  it('丢弃：只有手工与导入的草稿；版本号过期 409', async () => {
    const { call, prisma } = await open(WRITER, {
      versions: [versionRow(), draft(), draft({ id: 'cv3', versionNo: 3, source: 'FIRST_MILE_ALLOCATION', unitProductCost: null, unitFirstMileCost: dec('1') })],
    })
    expect((await call('DELETE', '/costs/versions/cv2')).status).toBe(422)
    const done = await call('DELETE', '/costs/versions/cv2?version=1')
    expect(done.status).toBe(200)
    expect(prisma.costVersion.deleteMany.mock.calls[0]![0].where).toMatchObject({ id: 'cv2', status: 'DRAFT', version: 1 })
    expect(actions(prisma)).toEqual(['COST_VERSION_DISCARDED'])
    expect((await call('DELETE', '/costs/versions/cv1?version=2')).status).toBe(409)
    const system = await call('DELETE', '/costs/versions/cv3?version=1')
    expect(system.status).toBe(409)
    expect(system.json.error.message).toContain('来源单据')
    prisma.costVersion.deleteMany.mockResolvedValue({ count: 0 })
    expect((await call('DELETE', '/costs/versions/cv2?version=1')).status).toBe(409)
  })
})

describe('文件导入', () => {
  const CSV = 'SKU,生效日期,币种,采购单价,关税\nSKU-A,2026-09-15,usd,11.5,0.5\n'
  it('通过后每行一个导入草稿：来源 FILE_IMPORT、批次号:行号、版本号接着已有的往下排；写审计', async () => {
    const { call, prisma } = await open(WRITER)
    const res = await call('POST', '/costs/import', { body: { fileName: 'cost.csv', content: CSV } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ imported: 1, skus: 1, fileName: 'cost.csv' })
    const rows = prisma.costVersion.createMany.mock.calls[0]![0].data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku: 'SKU-A', versionNo: 2, currency: 'USD', unitProductCost: 11.5, unitDutyCost: 0.5, unitFirstMileCost: null, source: 'FILE_IMPORT', status: 'DRAFT' })
    expect(rows[0].sourceDocId).toMatch(/^IMP[0-9a-f]{8}:2$/)
    expect(actions(prisma)).toEqual(['COST_VERSIONS_IMPORTED'])
  })

  it('一行有错整份拒绝：错误列在 fieldErrors.content；SKU 不存在也拒绝', async () => {
    const { call, prisma } = await open(WRITER)
    const bad = await call('POST', '/costs/import', { body: { fileName: 'cost.csv', content: 'SKU,生效日期,币种,采购单价\nSKU-A,2026-13-01,USD,1\nSKU-A,2026-09-01,USD,-3\n' } })
    expect(bad.status).toBe(422)
    expect(bad.json.error.fieldErrors.content).toHaveLength(2)
    expect(bad.json.error.fieldErrors.content[0]).toContain('第 2 行')
    const missing = await open(WRITER, { hasProduct: false, versions: [] })
    const res = await missing.call('POST', '/costs/import', { body: { fileName: 'cost.csv', content: CSV } })
    expect(res.status).toBe(422)
    expect(res.json.error.fieldErrors.content[0]).toContain('不存在')
    expect(prisma.costVersion.createMany).not.toHaveBeenCalled()
    expect(missing.prisma.costVersion.createMany).not.toHaveBeenCalled()
  })
})
