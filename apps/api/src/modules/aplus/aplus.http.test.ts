import { aplusCompareWindows } from '@nova/api-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS, closeAplus, contentRow, OTHER_SCOPE, openAplus, READ, runRow, uploadRun, WRITE } from '../../testing/aplus-kit'

// A+ 内容读取接口（P4-14）：列表、图片库、详情。写入接口见 aplus-write.http.test.ts 与 aplus-upload.http.test.ts；真实数据库的行为见 testing/aplus.db.test.ts。
afterEach(closeAplus)

const DAY = 86_400_000
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)

describe('A+ 内容：登录与权限', () => {
  it('未登录 401；没有 aplus.read 读取类接口一律 403，而且先于参数校验、也不读数据库', async () => {
    const { app, stubs } = await openAplus(['products.read'])
    for (const path of ['/aplus', '/aplus/uploads', '/aplus/c1']) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/aplus?sort=password:asc&status=bad')).status).toBe(403)
    expect((await app.call('GET', '/aplus/uploads?extra=1')).status).toBe(403)
    expect(stubs.aplusContent.findMany).not.toHaveBeenCalled()
    expect(stubs.aplusContent.findFirst).not.toHaveBeenCalled()
    expect(stubs.aplusWriteRun.findMany).not.toHaveBeenCalled()
  })
})

describe('A+ 内容列表', () => {
  it('排序字段不在白名单、状态不认识、未知参数、页大小为 0 都是 422', async () => {
    const { app } = await openAplus([READ])
    for (const query of ['sort=password:asc', 'status=bad', 'extra=1', 'pageSize=0']) expect((await app.call('GET', `/aplus?${query}`)).status, query).toBe(422)
  })

  it('店铺不在成员的数据范围内是 403', async () => {
    const { app, stubs } = await openAplus([READ], OTHER_SCOPE)
    const res = await app.call('GET', '/aplus?storeId=s1')
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
    expect(stubs.aplusContent.findMany).not.toHaveBeenCalled()
  })

  it('没有授权的卖家连接：NOT_CONNECTED 并说明原因；写入状态指向“连接”这一步', async () => {
    const { app } = await openAplus([READ, WRITE], { platformConnection: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } })
    const res = await app.call('GET', '/aplus')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'NOT_CONNECTED', items: [], truncated: false, write: { allowed: false, step: 'CONNECTION' } })
    expect(res.json.data.note).toContain('授权')
    // 没有同步成功过的来源：没有最近成功时间，也不列来源
    expect(res.json.data.freshness).toMatchObject({ lastSuccessAt: null, sources: [] })
  })

  it('已连接但没有内容：NO_DATA，汇总是 0 条而且是真实的 0（有连接才有“0 条内容”这个说法）', async () => {
    const { app } = await openAplus([READ])
    const res = await app.call('GET', '/aplus')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'NO_DATA', items: [], summary: { total: 0, pending: 0 }, stores: [{ id: 's1', name: '店铺 s1' }], write: { allowed: false, step: 'PERMISSION' } })
  })

  it('店铺都缺品牌内容角色时，NO_DATA 的说明写明前提（不是通用的“尚无记录”）', async () => {
    const { app } = await openAplus([READ], { dataFreshness: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', lastErrorCode: 'APL_ROLE_MISSING' }]) } })
    const res = await app.call('GET', '/aplus')
    expect(res.json.data.state).toBe('NO_DATA')
    expect(res.json.data.note).toContain('品牌备案')
  })

  it('有内容：每行带店铺名、状态中文、进行中的写入；汇总按状态且不受分页影响；写入状态在可写时是允许', async () => {
    const { app, stubs } = await openAplus([READ, WRITE], {
      aplusContent: {
        findMany: vi.fn().mockResolvedValue([contentRow(), contentRow({ id: 'c2', name: '被拒的', status: 'REJECTED', rejectionReason: 'price' })]),
        groupBy: vi.fn().mockResolvedValue([
          { status: 'DRAFT', _count: { _all: 4 } },
          { status: 'REJECTED', _count: { _all: 1 } },
        ]),
      },
      aplusWriteRun: { findMany: vi.fn().mockResolvedValue([{ contentId: 'c1', kind: 'UPDATE', status: 'RUNNING' }]), groupBy: vi.fn().mockResolvedValue([{ contentId: 'c1' }]) },
      // 新鲜度只认“接口来源 aplus.api”（登记在库存类新鲜度来源表里）
      dataFreshness: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { sellerAccountId: 's1', sourceKey: 'aplus.api', lastAttemptAt: day('2026-10-22'), lastSuccessAt: day('2026-10-22'), dataThrough: null, status: 'NORMAL', lastErrorCode: null },
          ]),
      },
    })
    const res = await app.call('GET', '/aplus?pageSize=1')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(data.summary).toMatchObject({ total: 5, pending: 1, byStatus: { DRAFT: 4, REJECTED: 1, SUBMITTED: 0, APPROVED: 0, PUBLISHED: 0 } })
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({
      id: 'c1',
      storeName: '店铺 s1',
      name: '春季新品',
      status: 'DRAFT',
      statusLabel: '草稿',
      asinCount: 2,
      updatedAt: '2026-10-20T00:00:00.000Z',
      pendingRun: { kind: 'UPDATE', status: 'RUNNING' },
    })
    expect(data.pageInfo).toMatchObject({ hasMore: true })
    expect(data.write).toEqual({ allowed: true, step: null, reason: null, remedyPath: null })
    expect(data.freshness).toMatchObject({ lastSuccessAt: '2026-10-22T00:00:00.000Z', sources: ['A+ 内容'] })
    // 状态汇总只按店铺范围收窄：不带状态、名称、ASIN 条件
    expect(stubs.aplusContent.groupBy.mock.calls[0]![0].where).toEqual({ tenantId: 'tenant-1' })
  })

  it('筛选条件落到查询里：店铺、状态、名称模糊（忽略大小写）、关联的 ASIN；默认按最近更新倒序，多读一行判断截断', async () => {
    const { app, stubs } = await openAplus([READ])
    const res = await app.call('GET', '/aplus?storeId=s1&status=DRAFT&q=%20%E6%98%A5%20&asin=b0abcde123')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const args = stubs.aplusContent.findMany.mock.calls[0]![0]
    expect(args.where).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      status: 'DRAFT',
      name: { contains: '春', mode: 'insensitive' },
      asinRelations: { some: { tenantId: 'tenant-1', asin: 'B0ABCDE123' } },
    })
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }])
    expect(args.take).toBe(20_000)
  })

  it('按名称、关联数排序交给数据库；按状态排序按生命周期顺序（草稿 → … → 已发布）', async () => {
    const rows = [contentRow({ id: 'a', status: 'PUBLISHED' }), contentRow({ id: 'b', status: 'DRAFT' }), contentRow({ id: 'c', status: 'REJECTED' })]
    const { app, stubs } = await openAplus([READ], { aplusContent: { findMany: vi.fn().mockResolvedValue(rows), groupBy: vi.fn().mockResolvedValue([{ status: 'DRAFT', _count: { _all: 3 } }]) } })
    await app.call('GET', '/aplus?sort=name:asc')
    expect(stubs.aplusContent.findMany.mock.calls[0]![0].orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }])
    const res = await app.call('GET', '/aplus?sort=status:asc')
    expect(res.json.data.items.map((item: { id: string }) => item.id)).toEqual(['b', 'c', 'a'])
  })

  it('翻页：第二页接着第一页，游标绑定查询条件，换条件再用旧游标是 400', async () => {
    const rows = ['a', 'b', 'c'].map(id => contentRow({ id }))
    const { app } = await openAplus([READ], { aplusContent: { findMany: vi.fn().mockResolvedValue(rows), groupBy: vi.fn().mockResolvedValue([{ status: 'DRAFT', _count: { _all: 3 } }]) } })
    const first = await app.call('GET', '/aplus?pageSize=2')
    expect(first.json.data.items.map((item: { id: string }) => item.id)).toEqual(['a', 'b'])
    expect(first.json.data.pageInfo.hasMore).toBe(true)
    const cursor = encodeURIComponent(first.json.data.pageInfo.nextCursor)
    const second = await app.call('GET', `/aplus?pageSize=2&cursor=${cursor}`)
    expect(second.json.data.items.map((item: { id: string }) => item.id)).toEqual(['c'])
    expect(second.json.data.pageInfo).toMatchObject({ hasMore: false, nextCursor: null })
    expect((await app.call('GET', `/aplus?pageSize=2&status=DRAFT&cursor=${cursor}`)).status).toBe(400)
  })
})

describe('A+ 图片库', () => {
  it('店铺不在范围内 403；参数不认识 422', async () => {
    const scoped = await openAplus([READ], OTHER_SCOPE)
    expect((await scoped.app.call('GET', '/aplus/uploads?storeId=s1')).status).toBe(403)
    const plain = await openAplus([READ])
    expect((await plain.app.call('GET', '/aplus/uploads?extra=1')).status).toBe(422)
  })

  it('最近的上传记录：带宽高、状态、上传编号与失败原因；请求内容残缺的记录不展示', async () => {
    const rows = [
      uploadRun('ok', 970, 600, { createdAt: new Date('2026-10-21T00:00:00.000Z') }),
      uploadRun('bad', 300, 300, { status: 'FAILED', resultJson: null, failureCode: 'APL_UPLOAD_FAILED' }),
      runRow({ id: 'broken', kind: 'UPLOAD', contentId: null, requestJson: { fileName: 'x.png' } }),
    ]
    const { app, stubs } = await openAplus([READ], { aplusWriteRun: { findMany: vi.fn().mockResolvedValue(rows) } })
    const res = await app.call('GET', '/aplus/uploads?storeId=s1')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(stubs.aplusWriteRun.findMany.mock.calls[0]![0]).toMatchObject({ where: { tenantId: 'tenant-1', kind: 'UPLOAD', sellerAccountId: 's1' }, take: 50 })
    expect(res.json.data.items).toHaveLength(2)
    expect(res.json.data.items[0]).toMatchObject({ id: 'up-ok', fileName: 'ok.png', width: 970, height: 600, status: 'SUCCEEDED', uploadDestinationId: 'ok', failureCode: null })
    expect(res.json.data.items[1]).toMatchObject({ status: 'FAILED', uploadDestinationId: null, failureCode: 'APL_UPLOAD_FAILED' })
    expect(res.json.data.items[1].failureText).toContain('重新上传')
    expect(res.json.data).toMatchObject({ types: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, stores: [{ id: 's1' }] })
  })
})

describe('A+ 内容详情', () => {
  it('内容不存在 404；范围外与别的企业一样是 404（查询条件带成员的店铺范围与企业）', async () => {
    const { app, stubs } = await openAplus([READ], OTHER_SCOPE)
    const res = await app.call('GET', '/aplus/c1')
    expect(res.status).toBe(404)
    expect(stubs.aplusContent.findFirst.mock.calls[0]![0].where).toMatchObject({ id: 'c1', tenantId: 'tenant-1', sellerAccountId: { in: ['s9'] } })
  })

  it('草稿：模块、版本、可编辑、按钮可用性、关联 ASIN 带标题（目录里没有的标题是 null）、时间线与写入记录', async () => {
    const { app } = await openAplus([READ, WRITE], {
      aplusContent: { findFirst: vi.fn().mockResolvedValue(contentRow()) },
      aplusAsinRelation: {
        findMany: vi.fn().mockResolvedValue([
          { asin: 'B0AAAAAAA1', publishedAt: null },
          { asin: 'B0AAAAAAA2', publishedAt: day('2026-10-01') },
        ]),
      },
      fbaProduct: { findMany: vi.fn().mockResolvedValue([{ asin: 'B0AAAAAAA1', title: '行李箱' }]) },
      aplusReviewEvent: { findMany: vi.fn().mockResolvedValue([{ status: 'DRAFT', message: null, occurredAt: day('2026-10-02'), source: 'LOCAL' }]) },
      aplusWriteRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([runRow({ status: 'FAILED', failureCode: 'SP_API_400', warningsJson: ['图片偏小'] })]),
      },
      membership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'm1', tenantId: 'tenant-1', role: { permissions: [READ, WRITE] }, tenant: { lifecycleStatus: 'ACTIVE' } }),
        findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '小王', email: 'w@example.com' } }]),
      },
    })
    const res = await app.call('GET', '/aplus/c1')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ version: 3, editable: true, editNote: null, asinsTruncated: false, rejection: null })
    expect(data.item).toMatchObject({ id: 'c1', storeName: '店铺 s1', statusLabel: '草稿', pendingRun: null })
    expect(data.modules).toHaveLength(1)
    expect(data.asins).toEqual([
      { asin: 'B0AAAAAAA1', title: '行李箱', publishedAt: null },
      { asin: 'B0AAAAAAA2', title: null, publishedAt: '2026-10-01T00:00:00.000Z' },
    ])
    expect(data.timeline).toEqual([{ status: 'DRAFT', statusLabel: '草稿', message: null, occurredAt: '2026-10-02T00:00:00.000Z', source: 'LOCAL' }])
    expect(data.runs[0]).toMatchObject({ kind: 'UPDATE', status: 'FAILED', failureCode: 'SP_API_400', warnings: ['图片偏小'], requestedBy: '小王' })
    expect(data.runs[0].failureText).toContain('拒绝')
    expect(data.actions).toEqual({ edit: { allowed: true, reason: null }, associate: { allowed: true, reason: null }, submit: { allowed: true, reason: null } })
    expect(data.write.allowed).toBe(true)
    expect(data.compare.state).toBe('NOT_PUBLISHED')
  })

  it('含编辑器不支持的模块：模块原样返回、不可编辑并写明原因，编辑按钮不可用', async () => {
    const draftJson = { contentModuleList: [{ contentModuleType: 'STANDARD_TECH_SPECS', standardTechSpecs: {} }] }
    const { app } = await openAplus([READ], { aplusContent: { findFirst: vi.fn().mockResolvedValue(contentRow({ draftJson })) } })
    const res = await app.call('GET', '/aplus/c1')
    expect(res.json.data.modules).toEqual(draftJson.contentModuleList)
    expect(res.json.data.editable).toBe(false)
    expect(res.json.data.editNote).toBeTruthy()
    expect(res.json.data.actions.edit).toMatchObject({ allowed: false })
    expect(res.json.data.actions.edit.reason).toBeTruthy()
  })

  it('被拒的内容：给出拒绝原文与关键词建议；进行中的写入让三个按钮都不可用；没有亚马逊编号的新草稿不能提交', async () => {
    const { app } = await openAplus([READ], {
      aplusContent: { findFirst: vi.fn().mockResolvedValue(contentRow({ status: 'REJECTED', rejectionReason: 'Image contains price and discount', contentReferenceKey: null })) },
    })
    const rejected = await app.call('GET', '/aplus/c1')
    expect(rejected.json.data.rejection.reason).toBe('Image contains price and discount')
    expect(rejected.json.data.rejection.advice.length).toBeGreaterThan(0)
    expect(rejected.json.data.actions.submit.allowed).toBe(false)

    const busy = await openAplus([READ], {
      aplusContent: { findFirst: vi.fn().mockResolvedValue(contentRow()) },
      aplusWriteRun: { findFirst: vi.fn().mockResolvedValue({ kind: 'SUBMIT', status: 'QUEUED' }), findMany: vi.fn().mockResolvedValue([]) },
    })
    const res = await busy.app.call('GET', '/aplus/c1')
    expect(res.json.data.item.pendingRun).toMatchObject({ kind: 'SUBMIT', status: 'QUEUED' })
    for (const key of ['edit', 'associate', 'submit']) expect(res.json.data.actions[key].allowed, key).toBe(false)
  })
})

describe('A+ 发布前后对照', () => {
  const published = () => new Date(Date.now() - 20 * DAY)
  const published0 = () => published().toISOString()
  const withContent = (extra: Record<string, unknown> = {}) => ({
    aplusContent: { findFirst: vi.fn().mockResolvedValue(contentRow({ status: 'PUBLISHED', publishedAt: published() })) },
    aplusAsinRelation: {
      findMany: vi.fn().mockResolvedValue([
        { asin: 'B0AAAAAAA1', publishedAt: published() },
        { asin: 'B0AAAAAAA2', publishedAt: null },
      ]),
    },
    ...extra,
  })
  const sale = (asin: string, date: Date, sessions: number | null, units: number | null, source = 'DATA_KIOSK') => ({ asin, sku: `${asin}-sku`, source, date, sessions, units })

  it('没有“分析”权限：RESTRICTED（详情本身仍然能看），不查销售流量', async () => {
    const { app, stubs } = await openAplus([READ], withContent())
    const res = await app.call('GET', '/aplus/c1')
    expect(res.status).toBe(200)
    expect(res.json.data.compare).toMatchObject({ state: 'RESTRICTED', before: null, after: null })
    expect(stubs.salesTrafficAsinDaily.findMany).not.toHaveBeenCalled()
  })

  it('没有任何销售流量行：NOT_CONNECTED，不是 0', async () => {
    const { app } = await openAplus([READ, ANALYTICS], withContent())
    const res = await app.call('GET', '/aplus/c1')
    expect(res.json.data.compare).toMatchObject({ state: 'NOT_CONNECTED', before: null, after: null, delta: null })
  })

  it('有数据：前后各合计所有关联 ASIN；同键只用数据中心的行；会话为空的日期不算有数据；只查子 ASIN 粒度与美元', async () => {
    const windows = aplusCompareWindows(published0(), new Date())
    const before = day(windows.before.from)
    const after = day(windows.after.from)
    const nextDay = new Date(after.getTime() + DAY)
    const rows = [
      sale('B0AAAAAAA1', before, 100, 10),
      sale('B0AAAAAAA1', before, 999, 99, 'REPORT'),
      sale('B0AAAAAAA2', before, 50, 5),
      sale('B0AAAAAAA1', after, 100, 15),
      sale('B0AAAAAAA2', after, 50, 7),
      sale('B0AAAAAAA1', nextDay, null, null),
    ]
    const { app, stubs } = await openAplus([READ, ANALYTICS], withContent({ salesTrafficAsinDaily: { findMany: vi.fn().mockResolvedValue(rows) } }))
    const res = await app.call('GET', '/aplus/c1')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const compare = res.json.data.compare
    expect(compare.state).toBe('OK')
    expect(compare.before).toMatchObject({ sessions: 150, units: 15, daysWithData: 1 })
    expect(compare.before.conversion).toBeCloseTo(0.1, 10)
    expect(compare.after).toMatchObject({ sessions: 150, units: 22, daysWithData: 1 })
    expect(compare.after.conversion).toBeCloseTo(22 / 150, 10)
    expect(compare.delta).toBeCloseTo(22 / 150 - 0.1, 10)
    expect(compare.asinCount).toBe(2)
    expect(stubs.salesTrafficAsinDaily.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      asinGranularity: 'CHILD',
      currency: 'USD',
      asin: { in: ['B0AAAAAAA1', 'B0AAAAAAA2'] },
    })
  })

  it('某一侧会话不足 100：INSUFFICIENT_DATA，不给结论', async () => {
    const windows = aplusCompareWindows(published0(), new Date())
    const rows = [sale('B0AAAAAAA1', day(windows.before.from), 40, 4), sale('B0AAAAAAA1', day(windows.after.from), 500, 50)]
    const { app } = await openAplus([READ, ANALYTICS], withContent({ salesTrafficAsinDaily: { findMany: vi.fn().mockResolvedValue(rows) } }))
    const res = await app.call('GET', '/aplus/c1')
    expect(res.json.data.compare).toMatchObject({ state: 'INSUFFICIENT_DATA', delta: null, relative: null })
    expect(res.json.data.compare.note).toContain('发布前')
  })
})
