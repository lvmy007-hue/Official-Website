import { EVENT_PER_TYPE_LIMIT, EVENT_TYPES, type EventsResponse } from '@nova/api-contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 统一事件接口（P6-06，真实数据库 + 完整应用）：多来源合并与时间倒序、按类型过滤与分类权限、每类 200 条与截断标记、
// 数据范围（范围外与别的企业按“不存在”）、对象读权限、时间窗（日期按企业时区、默认 90 天、跨度上限）、读写来源互不串对象。
// 造数时间都相对现在（企业时区设为 UTC），所以不依赖今天是几号；时间一律传 ISO 文字（不带时区的时间戳列别传 Date）。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const ago = (days: number, hour = 12) => new Date(Math.floor((Date.now() - days * DAY) / DAY) * DAY + hour * 3_600_000).toISOString()
const dayOf = (days: number) => ago(days).slice(0, 10)

describe('统一事件（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let owner: Member
  let readerOnly: Member
  let adsReader: Member
  let scopedB: Member
  let noAccess: Member
  let other: Member

  const query = (params: Record<string, string>) => `/events?${new URLSearchParams(params).toString()}`
  const get = async (member: Member, params: Record<string, string>, expected = 200) => {
    const res = await h.call(member.token, 'GET', query(params))
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as EventsResponse
  }
  const ids = (data: EventsResponse) => data.items.map(item => item.id)
  const typesOf = (data: EventsResponse) => [...new Set(data.items.map(item => item.type))].sort()

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'events' })
    const a = await h.createTenant('ev-a')
    const b = await h.createTenant('ev-b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-ev-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-EV-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    owner = await h.createMember(tenantId, 'ev-owner', ['*'])
    readerOnly = await h.createMember(tenantId, 'ev-reader', ['products.read'])
    adsReader = await h.createMember(tenantId, 'ev-ads', ['products.read', 'ads.read', 'alerts.read'])
    scopedB = await h.createMember(tenantId, 'ev-scoped', ['*'], { scopes: [{ sellerAccountId: storeB }] })
    noAccess = await h.createMember(tenantId, 'ev-none', [])
    other = await h.createMember(otherTenantId, 'ev-other', ['*'])

    // 商品：p1 属于店铺 A，p2 属于店铺 B；p-o 是别的企业的
    await insertRow(h.client, 'FbaProduct', { id: 'p1', tenantId, sellerAccountId: storeA, asin: 'B0EVENT01', sellerSku: 'SKU-A' })
    await insertRow(h.client, 'FbaProduct', { id: 'p2', tenantId, sellerAccountId: storeB, asin: 'B0EVENT02', sellerSku: 'SKU-B' })
    await insertRow(h.client, 'FbaProduct', { id: 'p-o', tenantId: otherTenantId, sellerAccountId: b.sellerAccountId, asin: 'B0EVENT03', sellerSku: 'SKU-O' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsCampaign', {
      id: 'cam-1',
      tenantId,
      adsProfileId: 'ap-a',
      externalCampaignId: 'c1',
      adProduct: 'SPONSORED_PRODUCTS',
      name: '春季推广',
      state: 'ENABLED',
      sourceUpdatedAt: ago(30),
    })
    await insertRow(h.client, 'AlertRule', { id: 'rule-1', tenantId, code: 'rule-1', domain: 'INVENTORY', name: '测试规则', conditionJson: '{}', scopeJson: '{}' })

    // 运营日志：商品 p1 两条（相差一天）、店铺 A 一条、别的商品一条（不应出现在 p1）
    await insertRow(h.client, 'OperationLog', { id: 'log-1', tenantId, scope: 'ASIN', scopeRef: 'p1', occurredAt: ago(3), category: 'PRICE', text: '降价 2 美元冲销量', authorId: owner.userId })
    await insertRow(h.client, 'OperationLog', { id: 'log-2', tenantId, scope: 'ASIN', scopeRef: 'p1', occurredAt: ago(3, 15), category: 'ADS', text: '加预算', authorId: owner.userId })
    await insertRow(h.client, 'OperationLog', { id: 'log-s', tenantId, scope: 'STORE', scopeRef: storeA, occurredAt: ago(2), category: 'OTHER', text: '店铺级记录', authorId: owner.userId })
    await insertRow(h.client, 'OperationLog', { id: 'log-x', tenantId, scope: 'ASIN', scopeRef: 'p2', occurredAt: ago(2), category: 'OTHER', text: '别的商品', authorId: owner.userId })

    // 对象事件：p1 的改价、手工记录、内容变更；活动 cam-1 的预算变更
    const event = (id: string, entityType: string, entityId: string, kind: string, days: number, title: string, detailJson?: unknown) =>
      insertRow(h.client, 'EntityEvent', { id, tenantId, entityType, entityId, kind, occurredAt: ago(days), title, sourceRef: id, ...(detailJson ? { detailJson: JSON.stringify(detailJson) } : {}) })
    await event('ev-price', 'ASIN', 'p1', 'price.change', 5, '价格 19.99 → 17.99', { before: 19.99, after: 17.99 })
    await event('ev-manual', 'ASIN', 'p1', 'manual', 4, '手工备注')
    await event('ev-content', 'ASIN', 'p1', 'content.change', 6, '主图更换')
    await event('ev-budget', 'CAMPAIGN', 'cam-1', 'budget.change', 4, '预算 50 → 80', { before: '50', after: '80' })

    // 改价写入：p1 的 SKU-A 成功一条、失败一条；SKU-B 一条（店铺 B）
    const run = (id: string, store: string, sku: string, status: string, days: number, requestJson: unknown) =>
      insertRow(h.client, 'ListingWriteRun', {
        id,
        tenantId,
        sellerAccountId: store,
        kind: 'PRICE_PATCH',
        sellerSku: sku,
        status,
        requestJson: JSON.stringify(requestJson),
        createdAt: ago(days),
        finishedAt: ago(days, 13),
      })
    await run('run-ok', storeA, 'SKU-A', 'SUCCEEDED', 1, { sku: 'SKU-A', price: 18.5, previousPrice: 17.99, currency: 'USD', source: 'RULE_AUTO' })
    await run('run-fail', storeA, 'SKU-A', 'FAILED', 1, { sku: 'SKU-A', price: 1, previousPrice: 17.99, currency: 'USD', source: 'MANUAL' })
    await run('run-b', storeB, 'SKU-B', 'SUCCEEDED', 1, { sku: 'SKU-B', price: 9, previousPrice: 8, currency: 'USD', source: 'MANUAL' })

    // 广告变更日志、预警、Listing 变更、审计
    await insertRow(h.client, 'AdsChangeLog', {
      id: 'adc-1',
      tenantId,
      adsProfileId: 'ap-a',
      entityType: 'CAMPAIGN',
      entityId: 'cam-1',
      entityLabel: '春季推广',
      changedField: 'budget',
      beforeValue: '50',
      afterValue: '80',
      actorKind: 'EXTERNAL',
      occurredAt: ago(2),
    })
    await insertRow(h.client, 'AlertInstance', {
      id: 'al-1',
      tenantId,
      sellerAccountId: storeA,
      ruleId: 'rule-1',
      ruleVersionNo: 1,
      entityType: 'ASIN',
      entityId: 'p1',
      severity: 'WARNING',
      firstTriggeredAt: ago(2, 8),
      lastTriggeredAt: ago(2, 8),
      evidenceJson: '{}',
      dedupKey: 'al-1',
      title: '库存即将断货',
      entityLabel: 'SKU-A',
    })
    await insertRow(h.client, 'AlertInstance', {
      id: 'al-b',
      tenantId,
      sellerAccountId: storeB,
      ruleId: 'rule-1',
      ruleVersionNo: 1,
      entityType: 'ASIN',
      entityId: 'p2',
      severity: 'WARNING',
      evidenceJson: '{}',
      dedupKey: 'al-b',
      title: '别家店铺的预警',
    })
    await insertRow(h.client, 'ListingChangeEvent', {
      id: 'lc-1',
      tenantId,
      sellerAccountId: storeA,
      sellerSku: 'SKU-A',
      asin: 'B0EVENT01',
      changeKind: 'CONTENT_CHANGE',
      fieldPath: 'title',
      beforeText: '旧标题',
      afterText: '新标题',
      actorKind: 'AMAZON',
      occurredAt: ago(1),
      sourceRef: 'lc-1',
    })
    await insertRow(h.client, 'ListingChangeEvent', {
      id: 'lc-b',
      tenantId,
      sellerAccountId: storeB,
      sellerSku: 'SKU-B',
      asin: 'B0EVENT02',
      changeKind: 'CONTENT_CHANGE',
      fieldPath: 'title',
      actorKind: 'AMAZON',
      occurredAt: ago(1),
      sourceRef: 'lc-b',
    })
    const audit = (id: string, action: string, result: string, resourceId: string) =>
      insertRow(h.client, 'AuditEvent', { id, tenantId, actorId: owner.userId, action, resourceType: 'FbaProduct', resourceId, requestId: `req-${id}`, result, source: 'PAGE', occurredAt: ago(1, 9) })
    await audit('aud-ok', 'PRODUCT_META_UPDATED', 'SUCCEEDED', 'p1')
    await audit('aud-denied', 'PRODUCT_META_UPDATED', 'DENIED', 'p1')
    await audit('aud-sim', 'PRICE_SIMULATED', 'SUCCEEDED', 'p1')
    await audit('aud-p2', 'PRODUCT_META_UPDATED', 'SUCCEEDED', 'p2')
  })
  afterAll(async () => {
    await h?.close()
  })

  it('商品：运营日志、改价写入、对象事件、预警、Listing 变更、业务写审计合并，新的在前；不带别的商品与失败的记录', async () => {
    const data = await get(owner, { objectType: 'ASIN', objectId: 'p1' })
    expect(typesOf(data)).toEqual(['ALERT', 'AUDIT', 'LISTING', 'OPERATION', 'OTHER', 'PRICE'])
    expect(ids(data)).toEqual(expect.arrayContaining(['log:log-1', 'log:log-2', 'event:ev-price', 'event:ev-manual', 'event:ev-content', 'price:run-ok', 'alert:al-1', 'listing:lc-1', 'audit:aud-ok']))
    expect(ids(data)).not.toEqual(expect.arrayContaining(['log:log-x']))
    for (const unexpected of ['price:run-fail', 'price:run-b', 'alert:al-b', 'listing:lc-b', 'audit:aud-denied', 'audit:aud-sim', 'audit:aud-p2', 'log:log-s'])
      expect(ids(data)).not.toContain(unexpected)
    const times = data.items.map(item => item.occurredAt)
    expect([...times].sort().reverse()).toEqual(times)
    expect(data).toMatchObject({ truncated: false, truncatedTypes: [], unavailableTypes: [] })
  })

  it('每条事件的标题、摘要、链接、操作者、企业时区日期都有', async () => {
    const data = await get(owner, { objectType: 'ASIN', objectId: 'p1' })
    const by = (id: string) => data.items.find(item => item.id === id)!
    expect(by('log:log-1')).toMatchObject({ type: 'OPERATION', title: '运营记录：价格', summary: '降价 2 美元冲销量', day: dayOf(3), link: '/app/products/p1' })
    expect(by('log:log-1').actor).not.toBe('系统')
    expect(by('price:run-ok')).toMatchObject({ type: 'PRICE', title: 'SKU-A：改价 17.99 → 18.5（USD）', summary: '规则自动执行', link: '/app/pricing/SKU-A' })
    expect(by('event:ev-price')).toMatchObject({ type: 'PRICE', summary: '19.99 → 17.99', actor: '系统' })
    expect(by('alert:al-1')).toMatchObject({ type: 'ALERT', title: '库存即将断货', summary: 'SKU-A', link: '/app/alerts/al-1', day: dayOf(2) })
    expect(by('listing:lc-1')).toMatchObject({ type: 'LISTING', summary: '旧标题 → 新标题', actor: '亚马逊' })
    expect(by('audit:aud-ok')).toMatchObject({ type: 'AUDIT' })
  })

  it('types 只取指定类型；写错的类型 422', async () => {
    const data = await get(owner, { objectType: 'ASIN', objectId: 'p1', types: 'OPERATION,PRICE' })
    expect(typesOf(data)).toEqual(['OPERATION', 'PRICE'])
    expect(
      data.items
        .filter(item => item.type === 'PRICE')
        .map(item => item.id)
        .sort(),
    ).toEqual(['event:ev-price', 'price:run-ok'])
    expect((await h.call(owner.token, 'GET', query({ objectType: 'ASIN', objectId: 'p1', types: 'NOPE' }))).status).toBe(422)
  })

  it('时间窗：日期按企业时区取整日、终点含当天；范围外的事件不返回；开始晚于结束、跨度超过 400 天 422', async () => {
    const day = await get(owner, { objectType: 'ASIN', objectId: 'p1', from: dayOf(3), to: dayOf(3) })
    expect(ids(day).sort()).toEqual(['log:log-1', 'log:log-2'])
    const empty = await get(owner, { objectType: 'ASIN', objectId: 'p1', from: dayOf(30), to: dayOf(20) })
    expect(empty).toMatchObject({ items: [], truncated: false })
    const bad = async (params: Record<string, string>) => (await h.call(owner.token, 'GET', query({ objectType: 'ASIN', objectId: 'p1', ...params }))).status
    expect(await bad({ from: dayOf(1), to: dayOf(5) })).toBe(422)
    expect(await bad({ from: dayOf(500), to: dayOf(1) })).toBe(422)
    expect(await bad({ from: 'yesterday' })).toBe(422)
    const longAgo = await get(owner, { objectType: 'ASIN', objectId: 'p1', from: dayOf(200) })
    expect(ids(longAgo)).toEqual(expect.arrayContaining(['log:log-1']))
  })

  it('默认只看最近 90 天：更早的事件不返回', async () => {
    await insertRow(h.client, 'OperationLog', { id: 'log-old', tenantId, scope: 'ASIN', scopeRef: 'p1', occurredAt: ago(120), category: 'OTHER', text: '很久以前', authorId: owner.userId })
    expect(ids(await get(owner, { objectType: 'ASIN', objectId: 'p1' }))).not.toContain('log:log-old')
    expect(ids(await get(owner, { objectType: 'ASIN', objectId: 'p1', from: dayOf(150) }))).toContain('log:log-old')
  })

  it('分类权限：没有价格、预警、审计等读权限的类型不报错，列在 unavailableTypes；有广告与预警权限的能看到预警', async () => {
    const reader = await get(readerOnly, { objectType: 'ASIN', objectId: 'p1' })
    expect(typesOf(reader)).toEqual(['OPERATION', 'OTHER'])
    expect(reader.unavailableTypes).toEqual(['PRICE', 'ADS', 'ALERT', 'LISTING', 'AUDIT'])
    const ads = await get(adsReader, { objectType: 'ASIN', objectId: 'p1' })
    expect(typesOf(ads)).toEqual(['ALERT', 'OPERATION', 'OTHER'])
    expect(ads.unavailableTypes).toEqual(['PRICE', 'LISTING', 'AUDIT'])
    const only = await get(readerOnly, { objectType: 'ASIN', objectId: 'p1', types: 'ALERT' })
    expect(only).toMatchObject({ items: [], unavailableTypes: ['ALERT'] })
  })

  it('广告活动：广告变更日志与预算变更事件；店铺：店铺级运营日志、预警、Listing 变更、该店铺广告账户的变更', async () => {
    const campaign = await get(owner, { objectType: 'CAMPAIGN', objectId: 'cam-1' })
    expect(ids(campaign).sort()).toEqual(['ads:adc-1', 'event:ev-budget'])
    expect(campaign.items.find(item => item.id === 'ads:adc-1')).toMatchObject({
      type: 'ADS',
      title: '春季推广：budget',
      summary: '50 → 80',
      actor: '广告后台（外部修改）',
      link: '/app/advertising/campaigns/cam-1',
    })
    const store = await get(owner, { objectType: 'STORE', objectId: storeA })
    expect(ids(store)).toEqual(expect.arrayContaining(['log:log-s', 'ads:adc-1', 'alert:al-1', 'listing:lc-1', 'price:run-ok']))
    expect(ids(store)).not.toEqual(expect.arrayContaining(['alert:al-b', 'price:run-b', 'log:log-1']))
  })

  it('每类最多 200 条，超出标记截断且只截断那一类', async () => {
    await h.client.query(
      `INSERT INTO "EntityEvent" (id, "tenantId", "entityType", "entityId", kind, "occurredAt", title, "sourceRef")
       SELECT 'bulk-' || g, $1, 'ASIN', 'p2', 'manual', (now() at time zone 'utc') - (g || ' minutes')::interval, '批量 ' || g, 'bulk-' || g FROM generate_series(1, ${EVENT_PER_TYPE_LIMIT + 1}) g`,
      [tenantId],
    )
    const data = await get(owner, { objectType: 'ASIN', objectId: 'p2' })
    expect(data.items.filter(item => item.type === 'OTHER')).toHaveLength(EVENT_PER_TYPE_LIMIT)
    expect(data).toMatchObject({ truncated: true, truncatedTypes: ['OTHER'] })
    expect(data.items.some(item => item.id === 'event:bulk-1')).toBe(true)
    expect(data.items.some(item => item.id === `event:bulk-${EVENT_PER_TYPE_LIMIT + 1}`)).toBe(false)
    expect(data.items.some(item => item.type === 'PRICE')).toBe(true)
  })

  it('数据范围与企业隔离：范围外的商品、别的企业的商品都是 404；没有对象读权限 403；没登录 401', async () => {
    expect((await h.call(scopedB.token, 'GET', query({ objectType: 'ASIN', objectId: 'p1' }))).status).toBe(404)
    expect((await h.call(scopedB.token, 'GET', query({ objectType: 'STORE', objectId: storeA }))).status).toBe(404)
    expect((await h.call(scopedB.token, 'GET', query({ objectType: 'CAMPAIGN', objectId: 'cam-1' }))).status).toBe(404)
    expect(ids(await get(scopedB, { objectType: 'ASIN', objectId: 'p2', types: 'PRICE' }))).toEqual(['price:run-b'])
    expect((await h.call(owner.token, 'GET', query({ objectType: 'ASIN', objectId: 'p-o' }))).status).toBe(404)
    expect((await h.call(other.token, 'GET', query({ objectType: 'ASIN', objectId: 'p1' }))).status).toBe(404)
    expect((await h.call(noAccess.token, 'GET', query({ objectType: 'ASIN', objectId: 'p1' }))).status).toBe(403)
    expect((await h.call(readerOnly.token, 'GET', query({ objectType: 'STORE', objectId: storeA }))).status).toBe(403)
    expect((await h.call(null, 'GET', query({ objectType: 'ASIN', objectId: 'p1' }))).status).toBe(401)
    expect((await h.call(owner.token, 'GET', '/events')).status).toBe(422)
    expect((await h.call(owner.token, 'GET', query({ objectType: 'NOPE', objectId: 'x' }))).status).toBe(422)
  })

  it('其他对象类型（库存规则）只读对象事件表：没有专门来源的类型返回空，不报错', async () => {
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-policy',
      tenantId,
      entityType: 'REPLENISHMENT_POLICY',
      entityId: 'TENANT:ALL',
      kind: 'manual',
      occurredAt: ago(2),
      title: '库存规则 v2 生效',
      sourceRef: 'ev-policy',
    })
    const data = await get(owner, { objectType: 'REPLENISHMENT_POLICY', objectId: 'TENANT:ALL' })
    expect(ids(data)).toEqual(['event:ev-policy'])
    expect(await get(owner, { objectType: 'REPLENISHMENT_POLICY', objectId: 'TENANT:ALL', types: 'OPERATION,AUDIT' })).toMatchObject({ items: [] })
    expect(EVENT_TYPES).toHaveLength(7)
  })
})
