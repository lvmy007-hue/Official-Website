import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 评价与反馈接口（P4-13）：未登录与权限、权限先于参数校验、四个页签的外形、导入整份拒绝、批量请求的开关与连接守卫、参数上限。
// 数据读取、导入覆盖、批量请求的落库与跨企业隔离见 testing/reviews.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const emptyRows = () => vi.fn().mockResolvedValue([])
const open = async (permissions: string[], extra: Record<string, unknown> = {}) => {
  await harness?.close()
  const stubs = {
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    membership: { ...(sessionStub(permissions).membership as object), findMany: emptyRows() },
    reviewMetricSnapshot: { findMany: emptyRows() },
    reviewTopic: { findMany: emptyRows(), groupBy: emptyRows(), count: vi.fn().mockResolvedValue(0), aggregate: vi.fn().mockResolvedValue({ _max: { snapshotDate: null } }) },
    browseNodeReturnTrend: { groupBy: emptyRows(), findMany: emptyRows() },
    browseNodeReviewTrend: { findMany: emptyRows() },
    fbaProduct: { groupBy: emptyRows(), findMany: emptyRows() },
    fbaReturnCase: { groupBy: emptyRows() },
    dataFreshness: { findMany: emptyRows() },
    orderPackage: { groupBy: emptyRows() },
    order: { findMany: emptyRows() },
    orderItem: { findMany: emptyRows() },
    solicitationRequest: { findMany: emptyRows(), groupBy: emptyRows() },
    integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) },
    platformConnection: { findFirst: vi.fn().mockResolvedValue(null) },
    ...extra,
  }
  harness = await createTestApp({ ...sessionStub(permissions), ...stubs })
  return { app: harness, stubs }
}

// 受限成员：只有店铺 s9 的数据范围（替身的店铺查询不看条件，所以一并把可见店铺换成 s9）
const OTHER_SCOPE = {
  membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's9' }]) },
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's9', displayName: '店铺 s9' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
}

const READ_PATHS = ['/reviews', '/reviews?tab=topics', '/reviews?tab=returns', '/reviews?tab=solicit', '/reviews/solicitations/eligible']
const FILE = 'ASIN,采集日期,平均星级,评分数\nB0ABCDE123,2026-10-20,4.5,100\n'

describe('评价与反馈接口：登录与权限', () => {
  it('未登录 401；没有 reviews.read 读取类接口 403，而且先于参数校验、也不读数据库', async () => {
    const { app, stubs } = await open(['products.read'])
    for (const path of READ_PATHS) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/reviews?tab=bad&sort=password:asc')).status).toBe(403)
    expect((await app.call('GET', '/reviews/solicitations/eligible?sort=password:asc')).status).toBe(403)
    expect(stubs.reviewMetricSnapshot.findMany).not.toHaveBeenCalled()
    expect(stubs.orderPackage.groupBy).not.toHaveBeenCalled()
  })

  it('导入要 data.import：只有 reviews.read 是 403（未登录 401），参数校验在权限之后，也不读文件内容', async () => {
    const { app, stubs } = await open(['reviews.read', 'reviews.solicit'])
    expect((await app.call('POST', '/reviews/ratings-import', { body: {} })).status).toBe(403)
    expect((await app.call('POST', '/reviews/ratings-import', { body: { storeId: 's1', fileName: 'a.csv', content: FILE }, auth: false })).status).toBe(401)
    expect(stubs.sellerAccount.findFirst).not.toHaveBeenCalled()
  })

  it('批量请求要 reviews.solicit：只有 reviews.read 与 data.import 是 403，不查订单、不查开关', async () => {
    const { app, stubs } = await open(['reviews.read', 'data.import'])
    expect((await app.call('POST', '/reviews/solicitations', { body: {} })).status).toBe(403)
    expect((await app.call('POST', '/reviews/solicitations', { body: { storeId: 's1', orderIds: ['111-1234567-1234567'] }, auth: false })).status).toBe(401)
    expect(stubs.order.findMany).not.toHaveBeenCalled()
    expect(stubs.integrationSwitch.findFirst).not.toHaveBeenCalled()
  })
})

describe('评价与反馈接口：读取参数', () => {
  it('页签不认识、排序字段不在白名单、星级上限超范围、未知参数、页大小为 0 都是 422', async () => {
    const { app } = await open(['reviews.read'])
    for (const query of ['tab=bad', 'sort=password:asc', 'ratingBelow=6', 'ratingBelow=0', 'extra=1', 'pageSize=0']) expect((await app.call('GET', `/reviews?${query}`)).status, query).toBe(422)
    for (const query of ['sort=avgRating:asc', 'extra=1', 'pageSize=0']) expect((await app.call('GET', `/reviews/solicitations/eligible?${query}`)).status, query).toBe(422)
  })

  it('店铺不在成员的数据范围内是 403', async () => {
    const { app } = await open(['reviews.read'], OTHER_SCOPE)
    const res = await app.call('GET', '/reviews?tab=topics&storeId=s1')
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
  })
})

describe('评价与反馈接口：四个页签的外形', () => {
  it('评分概况（默认页签）：没有导入时是“尚无记录，请先导入评分文件”，汇总为空而不是 0', async () => {
    const { app } = await open(['reviews.read'])
    const res = await app.call('GET', '/reviews')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({
      tab: 'ratings',
      state: 'NO_DATA',
      note: '尚无记录，请先导入评分文件',
      items: [],
      summary: { catalogAsins: 0, withRating: 0, latestCapture: null, lowestRating: null, below4: null },
      stores: [{ id: 's1', name: '店铺 s1' }],
      truncated: false,
    })
    expect(res.json.data.pageInfo).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('评分概况：每个店铺 × ASIN 一行最新评分，带上一次对比与采集点，来源标注为文件导入', async () => {
    const snapshot = (date: string, rating: number, count: number) => ({
      sellerAccountId: 's1',
      asin: 'B0ABCDE123',
      avgRating: rating,
      ratingCount: count,
      distributionJson: { '5': 80, '1': 2, '9': 1 },
      captureDate: new Date(`${date}T00:00:00.000Z`),
      sourceFileName: 'ratings.csv',
      importedBy: 'user-1',
    })
    const { app } = await open(['reviews.read'], {
      reviewMetricSnapshot: { findMany: vi.fn().mockResolvedValue([snapshot('2026-10-20', 4.2, 130), snapshot('2026-10-10', 4.5, 100)]) },
      fbaProduct: { groupBy: vi.fn().mockResolvedValue([{}, {}, {}]), findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', asin: 'B0ABCDE123', title: '行李箱' }]) },
      membership: { ...(sessionStub(['reviews.read']).membership as object), findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '小王', email: 'w@example.com' } }]) },
    })
    const res = await app.call('GET', '/reviews?ratingBelow=4.5')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data.state).toBe('OK')
    expect(res.json.data.summary).toMatchObject({ catalogAsins: 3, withRating: 1, latestCapture: '2026-10-20', lowestRating: 4.2, below4: 0 })
    expect(res.json.data.items[0]).toMatchObject({
      storeId: 's1',
      storeName: '店铺 s1',
      asin: 'B0ABCDE123',
      title: '行李箱',
      avgRating: 4.2,
      ratingCount: 130,
      captureDate: '2026-10-20',
      distribution: { '1': 2, '5': 80 },
      sourceLabel: '文件导入',
      sourceFileName: 'ratings.csv',
      importedBy: '小王',
      ratingDelta: -0.3,
      countDelta: 30,
      previousDate: '2026-10-10',
    })
    expect(res.json.data.items[0].trend.map((point: { date: string }) => point.date)).toEqual(['2026-10-10', '2026-10-20'])
    // 星级上限筛选：4.2 < 4.5 命中，4.1 之下不命中
    expect((await app.call('GET', '/reviews?ratingBelow=4.1')).json.data.items).toEqual([])
  })

  it('评论主题：没有同步过是“尚未接入”并写明前提；店铺没有品牌分析权限是“不适用”', async () => {
    const { app } = await open(['reviews.read'])
    const res = await app.call('GET', '/reviews?tab=topics')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ tab: 'topics', state: 'NOT_CONNECTED', options: [], selected: null })
    expect(res.json.data.note).toContain('品牌分析')
    expect(res.json.data.freshness).toBeTruthy()
    const blocked = await open(['reviews.read'], {
      dataFreshness: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', sourceKey: 'feedback.api', lastErrorCode: 'FBK_NO_BRAND_ACCESS' }]) },
    })
    const other = await blocked.app.call('GET', '/reviews?tab=topics')
    expect(other.json.data.state).toBe('NOT_APPLICABLE')
    expect(other.json.data.note).toContain('品牌')
  })

  it('退货主题：没有同步过是“尚未接入”；没有 returns.read 时改进清单是“无权限”（不是 403），有时是“尚未接入”', async () => {
    const { app } = await open(['reviews.read'])
    const res = await app.call('GET', '/reviews?tab=returns')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ tab: 'returns', state: 'NOT_CONNECTED', nodes: [], selectedNode: null })
    expect(res.json.data.improvements).toMatchObject({ state: 'RESTRICTED', rows: [], days: 90 })
    const withReturns = await open(['reviews.read', 'returns.read'])
    expect((await withReturns.app.call('GET', '/reviews?tab=returns')).json.data.improvements.state).toBe('NOT_CONNECTED')
  })

  it('请求评价：没有订单数据是 NO_DATA，覆盖率为 null 而不是 0，翻页游标与可请求订单接口同一条件', async () => {
    const { app } = await open(['reviews.read'])
    const res = await app.call('GET', '/reviews?tab=solicit')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ tab: 'solicit', state: 'NO_DATA', items: [], growth: [], recent: [], truncated: false })
    expect(res.json.data.coverage).toEqual([{ storeId: 's1', storeName: '店铺 s1', deliveredOrders: 0, requestedOrders: 0, coverage: null, eligibleNow: 0 }])
    expect(res.json.data.basis).toContain('每个订单只能请求一次')
    const eligible = await app.call('GET', '/reviews/solicitations/eligible')
    expect(eligible.status).toBe(200)
    expect(eligible.json.data).toMatchObject({ items: [], truncated: false })
  })

  it('请求评价页签带写入开关状态：没有开关记录或没有 reviews.solicit 权限时按钮要禁用', async () => {
    const off = await open(['reviews.read'])
    expect((await off.app.call('GET', '/reviews?tab=solicit')).json.data.switch).toEqual({ enabled: false, permitted: false })
    const on = await open(['reviews.read', 'reviews.solicit'], { integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: true, autoDisabledReason: null }) } })
    expect((await on.app.call('GET', '/reviews?tab=solicit')).json.data.switch).toEqual({ enabled: true, permitted: true })
  })
})

describe('评价与反馈接口：评分导入', () => {
  const importBody = (content: string) => ({ storeId: 's1', fileName: 'ratings.csv', content })

  it('缺字段、多余字段、文件名过长、空文件都是 422', async () => {
    const { app } = await open(['data.import'])
    const bad = [{}, { storeId: 's1' }, { ...importBody(FILE), extra: 1 }, { ...importBody(FILE), fileName: 'x'.repeat(201) }, importBody('')]
    for (const body of bad) expect((await app.call('POST', '/reviews/ratings-import', { body })).status, JSON.stringify(body).slice(0, 80)).toBe(422)
  })

  it('一行有错整份拒绝（422），逐行错误放在 fieldErrors.content，什么都没写入', async () => {
    const { app } = await open(['data.import'])
    const content = 'ASIN,采集日期,平均星级,评分数\nB0ABCDE123,2026-10-20,6,100\nBAD,2026-10-21,4.5,10\n'
    const res = await app.call('POST', '/reviews/ratings-import', { body: importBody(content) })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('VALIDATION_FAILED')
    expect(res.json.error.fieldErrors.content).toEqual(['第 2 行（平均星级）：平均星级要在 1 到 5 之间', '第 3 行（ASIN）：ASIN 要是 10 位字母或数字'])
  })

  it('错误超过 50 条只列前 50 条并给出条数', async () => {
    const { app } = await open(['data.import'])
    const content = `ASIN,采集日期,平均星级,评分数\n${Array.from({ length: 60 }, (_, index) => `B0ABCDE${String(index).padStart(3, '0')},2026-10-20,9,1`).join('\n')}\n`
    const res = await app.call('POST', '/reviews/ratings-import', { body: importBody(content) })
    expect(res.status).toBe(422)
    expect(res.json.error.fieldErrors.content).toHaveLength(51)
    expect(res.json.error.fieldErrors.content[50]).toContain('还有 10 条错误')
  })

  it('店铺不存在是 404；店铺不在范围内是 403', async () => {
    const missing = await open(['data.import'], { sellerAccount: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) } })
    expect((await missing.app.call('POST', '/reviews/ratings-import', { body: importBody(FILE) })).status).toBe(404)
    const scoped = await open(['data.import'], OTHER_SCOPE)
    const res = await scoped.app.call('POST', '/reviews/ratings-import', { body: importBody(FILE) })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
  })
})

describe('评价与反馈接口：批量请求评价', () => {
  const ORDER = '111-1234567-1234567'
  const body = (orderIds: string[]) => ({ storeId: 's1', orderIds })

  it('缺店铺、没有订单、订单重复、超过 50 个、多余字段都是 422', async () => {
    const { app } = await open(['reviews.solicit'])
    const many = Array.from({ length: 51 }, (_, index) => `111-0000000-${String(index).padStart(7, '0')}`)
    const bad = [{}, { orderIds: [ORDER] }, body([]), body([ORDER, ORDER]), body(many), { ...body([ORDER]), extra: 1 }]
    for (const item of bad) expect((await app.call('POST', '/reviews/solicitations', { body: item })).status, JSON.stringify(item).slice(0, 80)).toBe(422)
  })

  it('连接不可用是 409 CONNECTION_UNAVAILABLE，开关关闭是 409 WRITE_SWITCH_OFF，都不查订单、不入队', async () => {
    const { app, stubs } = await open(['reviews.solicit'])
    const noConnection = await app.call('POST', '/reviews/solicitations', { body: body([ORDER]) })
    expect(noConnection.status).toBe(409)
    expect(noConnection.json.error.code).toBe('CONNECTION_UNAVAILABLE')
    stubs.platformConnection.findFirst.mockResolvedValue({ id: 'conn-1', lastErrorCode: null, healthChecks: [] })
    const off = await app.call('POST', '/reviews/solicitations', { body: body([ORDER]) })
    expect(off.status).toBe(409)
    expect(off.json.error.code).toBe('WRITE_SWITCH_OFF')
    expect(stubs.order.findMany).not.toHaveBeenCalled()
    expect(app.queue.add).not.toHaveBeenCalled()
    expect(app.workflow.registerWriteRun).not.toHaveBeenCalled()
  })

  it('开关打开、订单都查不到：不建任务、不入队，全部记入 skipped（NOT_FOUND）', async () => {
    const { app, stubs } = await open(['reviews.solicit'], {
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: true, autoDisabledReason: null }) },
      platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', lastErrorCode: null, healthChecks: [] }) },
    })
    const res = await app.call('POST', '/reviews/solicitations', { body: body([ORDER]) })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toEqual({ accepted: 0, skipped: [{ amazonOrderId: ORDER, reason: 'NOT_FOUND' }], batchId: null, jobId: null })
    expect(stubs.order.findMany).toHaveBeenCalled()
    expect(app.queue.add).not.toHaveBeenCalled()
  })

  it('店铺不在范围内是 403（先于开关与连接）', async () => {
    const { app, stubs } = await open(['reviews.solicit'], OTHER_SCOPE)
    const res = await app.call('POST', '/reviews/solicitations', { body: body([ORDER]) })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
    expect(stubs.integrationSwitch.findFirst).not.toHaveBeenCalled()
  })
})
