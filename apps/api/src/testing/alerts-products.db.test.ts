import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 商品与口碑预警（P4-15，真实数据库）：刊登问题新增、被搜索抑制、详情页被他人修改、失去推荐报价资格、价格健康异常、负面评论主题上升
// 从业务表到预警实例、待办的整条链路；两个口径相邻的预警互不重复、重复评估不重复建、业务状态变化后自动恢复、两个企业互不可见。
// 评估代码在后台任务进程里，这里按路径动态加载。

type Ids = Awaited<ReturnType<typeof seedTenant>>
type Evaluate = (deps: Record<string, unknown>) => Promise<{ tenants: number; created: number }>
const DAY = 86_400_000
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString()
const dayOffset = (days: number) => iso(days).slice(0, 10)
const NEW_CODES = ['PRD_LISTING_ISSUE_NEW', 'PRD_SEARCH_SUPPRESSED', 'PRD_CONTENT_CHANGED_BY_OTHERS', 'PRD_FEATURED_OFFER_LOST', 'PRD_PRICE_HEALTH', 'REV_NEGATIVE_TOPIC_RISING']

describe('商品与口碑预警（P4-15，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let a: Ids
  let b: Ids
  let evaluateAll: Evaluate
  let provision: (db: unknown, tenantId: string) => Promise<string[]>
  let createEvaluators: () => unknown
  let seq = 0

  const logger = { info: () => undefined, warn: () => undefined }
  const run = () =>
    evaluateAll({
      systemDb: { tenant: { findMany: async () => [{ id: a.tenantId }, { id: b.tenantId }] } },
      db: scoped,
      registry: createEvaluators(),
      provision,
      now: () => new Date(),
      logger,
    })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[]
  type Instance = { code: string; entityType: string; entityId: string; status: string; triggerCount: number; evidenceJson: Record<string, unknown> }
  const instances = (tenantId: string) =>
    rows<Instance>(
      `SELECT r."code", i."entityType", i."entityId", i."status", i."triggerCount", i."evidenceJson" FROM "AlertInstance" i JOIN "AlertRule" r ON r."id" = i."ruleId" WHERE i."tenantId" = $1 ORDER BY r."code", i."entityId"`,
      [tenantId],
    )
  const openOf = async (tenantId: string) =>
    (await instances(tenantId))
      .filter(item => ['NEW', 'ACKED'].includes(item.status))
      .map(item => `${item.code}:${item.entityId}`)
      .sort()

  const owner = async (ids: Ids) => {
    await insertRow(admin, 'Role', { id: `role-${ids.tenantId}`, tenantId: ids.tenantId, name: '所有者', permissions: JSON.stringify(['*']), resourceScope: '{}', version: 1 })
    await insertRow(admin, 'Membership', { id: `ms-${ids.tenantId}`, tenantId: ids.tenantId, userId: ids.userId, roleId: `role-${ids.tenantId}` })
  }
  const product = (ids: Ids, id: string, sku: string, asin: string) =>
    insertRow(admin, 'FbaProduct', { id, tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, sellerSku: sku, asin, title: `商品 ${sku}`, sourceUpdatedAt: iso(-1) })
  const issue = (ids: Ids, sku: string, over: Record<string, unknown> = {}) =>
    insertRow(admin, 'ListingIssue', {
      id: `li-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      sellerSku: sku,
      asin: `ASIN-${sku}`,
      issueKind: 'ISSUE',
      issueCode: '90220',
      attributeName: 'color',
      severity: 'ERROR',
      impact: 'NONE',
      message: '缺少颜色',
      firstSeenAt: iso(-1),
      lastSeenAt: iso(0),
      ...over,
    })
  const change = (ids: Ids, sku: string, over: Record<string, unknown> = {}) =>
    insertRow(admin, 'ListingChangeEvent', {
      id: `lc-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      sellerSku: sku,
      asin: `ASIN-${sku}`,
      changeKind: 'CONTENT_CHANGE',
      fieldPath: 'item_name',
      beforeText: '旧标题',
      afterText: '新标题',
      actorKind: 'UNKNOWN',
      occurredAt: iso(-1),
      sourceRef: `s${seq}`,
      ...over,
    })
  const box = (ids: Ids, asin: string, days: number, own: boolean, over: Record<string, unknown> = {}) =>
    insertRow(admin, 'BuyBoxSnapshot', {
      id: `bb-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      asin,
      sellerSku: '',
      hasFeaturedOffer: own,
      ownIsFeatured: own,
      source: 'SYNC',
      observedAt: iso(days),
      ...over,
    })
  const price = (ids: Ids, sku: string, value: number, asin = '') =>
    insertRow(admin, 'PriceSnapshot', {
      id: `ps-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      sellerSku: sku,
      asin,
      price: value,
      source: 'LISTING_API',
      observedAt: iso(-0.05),
    })
  const expected = (ids: Ids, sku: string, value: number) =>
    insertRow(admin, 'FeaturedOfferExpectedPrice', {
      id: `fe-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      sellerSku: sku,
      expectedPrice: value,
      resultStatus: 'VALID',
      observedAt: iso(-0.05),
    })
  const summary = (ids: Ids, asin: string, own: boolean) =>
    insertRow(admin, 'CompetitiveSummarySnapshot', { id: `cs-${++seq}`, tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, asin, featuredIsOwn: own, observedAt: iso(-0.05) })
  const topic = (ids: Ids, asin: string, days: number, key: string, rank: number, mentionRange: string | null) =>
    insertRow(admin, 'ReviewTopic', {
      id: `rv-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      asin,
      topicKey: key,
      sentiment: 'NEGATIVE',
      rank,
      mentionRange,
      snapshotDate: dayOffset(days),
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alertsp415')
    db.migrate('alertsp415')
    admin = await db.connect('alertsp415')
    a = await seedTenant(admin, 'ap-a')
    b = await seedTenant(admin, 'ap-b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('alertsp415', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    evaluateAll = (await import(/* @vite-ignore */ String('../../../worker/src/platform/alert-evaluate'))).evaluateAllTenants
    provision = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/provision'))).ensureDefaultRules
    createEvaluators = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/register'))).createAlertEvaluators
    await owner(a)
    await owner(b)

    await product(a, 'fp-A', 'SKU-A', 'B0A')
    await product(a, 'fp-H', 'SKU-H', 'B0H')

    // 刊登问题：新增的错误（命中）、10 天前的（窗口外）、新增的警告（默认不看）、已解决的；搜索抑制两种口径（问题类型、执法动作）都只归“被搜索抑制”
    await issue(a, 'SKU-A')
    await issue(a, 'SKU-OLD', { firstSeenAt: iso(-10) })
    await issue(a, 'SKU-WARN', { severity: 'WARNING' })
    await issue(a, 'SKU-RES', { firstSeenAt: iso(-2), resolvedAt: iso(-1) })
    await issue(a, 'SKU-SUP', { issueKind: 'SEARCH_SUPPRESSED', issueCode: 'FYP', attributeName: '', impact: 'SEARCH_SUPPRESSED', firstSeenAt: iso(-10) })
    await issue(a, 'SKU-IMP', { impact: 'SEARCH_SUPPRESSED' })
    // 详情页修改：未知来源的标题修改（命中）、本系统自己改的、商品类型变更、10 天前他人的修改
    await change(a, 'SKU-A')
    await change(a, 'SKU-SELF', { actorKind: 'SELF' })
    await change(a, 'SKU-PT', { changeKind: 'PRODUCT_TYPE_CHANGE', fieldPath: '' })
    await change(a, 'SKU-OLDC', { actorKind: 'OTHER', occurredAt: iso(-10) })
    // 推荐报价：B0A 获得后失去（命中）；B0B 失去后又获得；B0P 因价格失去资格（归价格健康，不在失去推荐报价里重复）
    await box(a, 'B0A', -5, true)
    await box(a, 'B0A', -2, false)
    await box(a, 'B0B', -5, true)
    await box(a, 'B0B', -2, false)
    await box(a, 'B0B', -1, true)
    await box(a, 'B0P', -5, true)
    await box(a, 'B0P', -2, false)
    await box(a, 'B0P', -1, false, { lostReason: 'PRICE', source: 'PUSH_PRICING_HEALTH' })
    // 价格健康：SKU-H 价格 20 高于预期 18 且没获得推荐报价（命中）；SKU-W 同价但已获得；SKU-S 只高 1.1%；SKU-P 因价格失去资格（命中，没有预期价格也成立）
    await price(a, 'SKU-H', 20, 'B0H')
    await expected(a, 'SKU-H', 18)
    await summary(a, 'B0H', false)
    await price(a, 'SKU-W', 20, 'B0W')
    await expected(a, 'SKU-W', 18)
    await summary(a, 'B0W', true)
    await price(a, 'SKU-S', 18.2, 'B0S')
    await expected(a, 'SKU-S', 18)
    await summary(a, 'B0S', false)
    await price(a, 'SKU-P', 10, 'B0P')
    // 评论主题：B0R 最近一次“提及量上升”（命中）；B0Q 只有一次快照不判断
    await topic(a, 'B0R', -1, 'Zipper breaks', 1, '100-250')
    await topic(a, 'B0R', -8, 'Zipper breaks', 2, '50-100')
    await topic(a, 'B0Q', -1, 'Wheels loose', 1, '100-250')

    // 租户 B：自己的一条被搜索抑制
    await issue(b, 'SKU-B', { issueKind: 'SEARCH_SUPPRESSED', issueCode: 'FYP', attributeName: '', impact: 'SEARCH_SUPPRESSED' })
  }, 180_000)

  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('第一轮：六类预警各命中应命中的对象；相邻口径不重复（搜索抑制不进“新增问题”、价格原因的失去不进“失去推荐报价”）；企业互不可见', async () => {
    const result = await run()
    expect(result.tenants).toBe(2)
    expect(await openOf(a.tenantId)).toEqual(
      [
        'PRD_CONTENT_CHANGED_BY_OTHERS:fp-A',
        'PRD_FEATURED_OFFER_LOST:fp-A',
        'PRD_LISTING_ISSUE_NEW:fp-A',
        'PRD_PRICE_HEALTH:fp-H',
        `PRD_PRICE_HEALTH:${a.sellerAccountId}|SKU-P`,
        `PRD_SEARCH_SUPPRESSED:${a.sellerAccountId}|SKU-IMP`,
        `PRD_SEARCH_SUPPRESSED:${a.sellerAccountId}|SKU-SUP`,
        `REV_NEGATIVE_TOPIC_RISING:${a.sellerAccountId}|B0R`,
      ].sort(),
    )
    expect(await openOf(b.tenantId)).toEqual([`PRD_SEARCH_SUPPRESSED:${b.sellerAccountId}|SKU-B`])
    expect(result.created).toBe(9)
  })

  it('命中的证据与对象登记：有商品记录的链到商品全景或定价详情，没有的按店铺|键登记；价格健康两种状态各一条', async () => {
    const list = await instances(a.tenantId)
    const of = (code: string) => list.filter(item => item.code === code)
    expect(of('PRD_LISTING_ISSUE_NEW')[0]).toMatchObject({ entityType: 'ASIN', entityId: 'fp-A' })
    expect(of('PRD_LISTING_ISSUE_NEW')[0].evidenceJson).toMatchObject({ sku: 'SKU-A', issueCount: 1, errorCount: 1, issues: [{ code: '90220', attribute: 'color', severity: 'ERROR' }] })
    expect(of('PRD_SEARCH_SUPPRESSED').map(item => item.entityType)).toEqual(['LISTING_SKU', 'LISTING_SKU'])
    expect(of('PRD_CONTENT_CHANGED_BY_OTHERS')[0].evidenceJson).toMatchObject({
      sku: 'SKU-A',
      byOthers: false,
      changeCount: 1,
      changes: [{ field: 'item_name', before: '旧标题', after: '新标题', actorLabel: '未知' }],
    })
    expect(of('PRD_FEATURED_OFFER_LOST')[0]).toMatchObject({ entityType: 'ASIN', entityId: 'fp-A' })
    expect(of('PRD_FEATURED_OFFER_LOST')[0].evidenceJson).toMatchObject({ asin: 'B0A', lostReason: null, source: 'SYNC' })
    const health = of('PRD_PRICE_HEALTH')
    expect(health.find(item => item.entityId === 'fp-H')).toMatchObject({ entityType: 'SKU' })
    expect(health.find(item => item.entityId === 'fp-H')?.evidenceJson).toMatchObject({ state: 'ABOVE_EXPECTED', ownPrice: 20, expectedPrice: 18, gap: 2, gapRatio: 0.1111 })
    expect(health.find(item => item.entityId.endsWith('|SKU-P'))).toMatchObject({ entityType: 'PRICING_SKU' })
    expect(health.find(item => item.entityId.endsWith('|SKU-P'))?.evidenceJson).toMatchObject({ state: 'LOST_ELIGIBILITY', expectedPrice: null })
    expect(of('REV_NEGATIVE_TOPIC_RISING')[0]).toMatchObject({ entityType: 'REVIEW_ASIN' })
    expect(of('REV_NEGATIVE_TOPIC_RISING')[0].evidenceJson).toMatchObject({ asin: 'B0R', risingCount: 1, topics: [{ topic: 'Zipper breaks', kind: 'MENTIONS_UP', previousMentionRange: '50-100' }] })
  })

  it('每个预警都生成待办：商品类域是 PRODUCT，口碑类是 AFTER_SALES；没有估算依据不写影响金额；新增预置规则每个企业都有', async () => {
    const works = await rows<{ ruleCode: string; kind: string; severity: string; impactMin: string | null; ownerId: string }>(
      `SELECT "ruleCode", "kind", "severity", "impactMin", "ownerId" FROM "WorkItem" WHERE "tenantId" = $1 ORDER BY "ruleCode"`,
      [a.tenantId],
    )
    expect(works).toHaveLength(8)
    expect([...new Set(works.map(work => work.ruleCode))].sort()).toEqual([...NEW_CODES].sort())
    for (const work of works) {
      expect(work.kind).toBe(work.ruleCode.startsWith('REV_') ? 'AFTER_SALES' : 'PRODUCT')
      expect(work.impactMin).toBeNull()
      expect(work.ownerId).toBe(a.userId)
    }
    expect(works.filter(work => work.ruleCode === 'PRD_SEARCH_SUPPRESSED').every(work => work.severity === 'CRITICAL')).toBe(true)
    for (const tenantId of [a.tenantId, b.tenantId]) {
      const codes = await rows<{ code: string }>(`SELECT "code" FROM "AlertRule" WHERE "tenantId" = $1 AND "code" = ANY($2)`, [tenantId, NEW_CODES])
      expect(codes).toHaveLength(NEW_CODES.length)
    }
  })

  it('第二轮数据没变：不新建预警与待办，只刷新命中次数', async () => {
    const result = await run()
    expect(result.created).toBe(0)
    expect((await instances(a.tenantId)).every(item => item.triggerCount === 2)).toBe(true)
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(8)
  })

  it('业务状态变化后自动恢复：问题解决、抑制解除、修改超出窗口、重新获得推荐报价、价格调到预期、重新获得资格、主题回落；待办留给人确认；租户 B 不受影响', async () => {
    await admin.query(`UPDATE "ListingIssue" SET "resolvedAt" = $2 WHERE "tenantId" = $1`, [a.tenantId, iso(0)])
    await admin.query(`UPDATE "ListingChangeEvent" SET "occurredAt" = $2 WHERE "tenantId" = $1`, [a.tenantId, iso(-20)])
    await box(a, 'B0A', -0.5, true)
    await box(a, 'B0P', -0.2, true) // 重新获得推荐报价：因价格失去资格的状态随之结束
    await admin.query(`UPDATE "PriceSnapshot" SET "price" = 18 WHERE "tenantId" = $1 AND "sellerSku" = 'SKU-H'`, [a.tenantId])
    await admin.query(`DELETE FROM "ReviewTopic" WHERE "tenantId" = $1 AND "snapshotDate" < $2`, [a.tenantId, dayOffset(-3)])
    await run()
    expect(await openOf(a.tenantId)).toEqual([])
    expect((await instances(a.tenantId)).every(item => item.status === 'AUTO_CLOSED')).toBe(true)
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1 AND "status" = 'PENDING'`, [a.tenantId])).toHaveLength(8)
    expect(await openOf(b.tenantId)).toEqual([`PRD_SEARCH_SUPPRESSED:${b.sellerAccountId}|SKU-B`])
  })

  it('冷却期内再次命中不重复建待办；规则范围改到别的店铺后命中消失，企业改过的规则不被预置覆盖；后台账号不在租户上下文里读不到预警', async () => {
    await admin.query(`UPDATE "ListingIssue" SET "resolvedAt" = NULL WHERE "tenantId" = $1 AND "sellerSku" = 'SKU-SUP'`, [a.tenantId])
    await run()
    expect(await openOf(a.tenantId)).toEqual([])
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(8)
    await admin.query(`UPDATE "AlertRule" SET "scopeJson" = $2 WHERE "tenantId" = $1 AND "code" = 'PRD_SEARCH_SUPPRESSED'`, [a.tenantId, JSON.stringify({ sellerAccountIds: ['other-store'] })])
    await run()
    expect(await openOf(a.tenantId)).toEqual([])
    const rule = await rows<{ scopeJson: Record<string, unknown> }>(`SELECT "scopeJson" FROM "AlertRule" WHERE "tenantId" = $1 AND "code" = 'PRD_SEARCH_SUPPRESSED'`, [a.tenantId])
    expect(rule[0].scopeJson).toEqual({ sellerAccountIds: ['other-store'] })
    expect(await base.alertInstance.count()).toBe(0)
  })
})
