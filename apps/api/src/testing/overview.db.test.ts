import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { KpiCard, WaterfallItem } from '@nova/api-contracts'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'

// 经营控制台（P2a-02，真实数据库）：指标卡、趋势、归因、店铺对比、ASIN 排名、增长瀑布、现金视角。
// 覆盖：数值与对比、没有数据时的状态（不显示成 0）、利润字段权限、数据范围收窄、租户隔离、事件标注。

type Ids = Awaited<ReturnType<DbTestApp['createTenant']>>
type Member = { userId: string; token: string }
const LA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
const laDay = (date: Date) => LA.format(date)
const daysFromNow = (offset: number, hour = 12) => {
  const date = new Date(Date.now() + offset * 86_400_000)
  date.setUTCHours(hour, 0, 0, 0)
  return date
}

describe('经营控制台（真实数据库）', () => {
  let h: DbTestApp
  let a: Ids
  let b: Ids
  let c: Ids
  let a2: string
  let owner: Member
  let operator: Member
  let storeOnly: Member
  let financeAll: Member
  let financeStore: Member
  let ownerB: Member
  let ownerC: Member
  let operatorC: Member
  let seq = 0

  const store = async (ids: Ids, date: string, patch: Record<string, unknown>, sellerAccountId = ids.sellerAccountId) =>
    insertRow(h.client, 'StoreDailySummary', { id: `sd-${++seq}`, tenantId: ids.tenantId, sellerAccountId, summaryDate: date, metricVersion: 'p2a-01@1', ...patch })
  const asin = async (ids: Ids, date: string, code: string, patch: Record<string, unknown>, sellerAccountId = ids.sellerAccountId) =>
    insertRow(h.client, 'AsinDailySummary', { id: `ad-${++seq}`, tenantId: ids.tenantId, sellerAccountId, summaryDate: date, asin: code, metricVersion: 'p2a-01@1', ...patch })
  const get = async (member: Member, path: string) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const RANGE = 'from=2026-10-01&to=2026-10-07&compare=previous'

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'overview' })
    a = await h.createTenant('ova')
    b = await h.createTenant('ovb')
    c = await h.createTenant('ovc')
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE "id" = $1`, [a.sellerAccountId, 'A 一店'])
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE "id" = $1`, [b.sellerAccountId, 'B 一店'])
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE "id" = $1`, [c.sellerAccountId, 'C 一店'])
    a2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-ova-2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-OVA-2', displayName: 'A 二店' })).id
    owner = await h.createMember(a.tenantId, 'ov-owner', ['*'])
    operator = await h.createMember(a.tenantId, 'ov-op', ['overview.read'])
    storeOnly = await h.createMember(a.tenantId, 'ov-store', ['overview.read'], { scopes: [{ sellerAccountId: a.sellerAccountId }] })
    financeAll = await h.createMember(a.tenantId, 'ov-fin', ['overview.read', 'finance.read'])
    financeStore = await h.createMember(a.tenantId, 'ov-fins', ['overview.read', 'finance.read'], { scopes: [{ sellerAccountId: a.sellerAccountId }] })
    ownerB = await h.createMember(b.tenantId, 'ov-ownerb', ['*'])
    ownerC = await h.createMember(c.tenantId, 'ov-ownerc', ['*'])
    operatorC = await h.createMember(c.tenantId, 'ov-opc', ['overview.read'])

    // 租户 A：本期 10-01 至 10-07，上一期 09-24 至 09-30，去年同期 2025-10-01 至 07；利润、广告、会话都没有（为空）
    await store(a, '2026-10-01', { orders: 2, units: 3, salesAmount: 100 })
    await store(a, '2026-10-01', { orders: 1, units: 1, salesAmount: 50 }, a2)
    await store(a, '2026-10-03', { orders: 4, units: 5, salesAmount: 200 })
    await store(a, '2026-10-07', { orders: 1, units: 1, salesAmount: 30 }, a2)
    await store(a, '2026-09-25', { orders: 2, units: 2, salesAmount: 80 })
    await store(a, '2026-09-30', { orders: 3, units: 4, salesAmount: 120 }, a2)
    await store(a, '2025-10-02', { orders: 1, units: 1, salesAmount: 40 })
    await asin(a, '2026-10-01', 'A1', { units: 2, salesAmount: 60, sku: 'SKU-A1' })
    await asin(a, '2026-10-03', 'A1', { units: 3, salesAmount: 150, sku: 'SKU-A1' })
    await asin(a, '2026-10-01', 'A2', { units: 1, salesAmount: 30 })
    await asin(a, '2026-08-01', 'A2', { units: 1, salesAmount: 5 })
    await asin(a, '2026-10-01', 'A3', { units: 1, salesAmount: 50 }, a2)
    await asin(a, '2026-10-07', 'N1', { units: 1, salesAmount: 30 }, a2)
    await asin(a, '2026-09-25', 'A1', { units: 2, salesAmount: 80 })
    await asin(a, '2026-09-30', 'A3', { units: 4, salesAmount: 120 }, a2)

    // 租户 B：只用来验证隔离
    await store(b, '2026-10-02', { orders: 9, units: 9, salesAmount: 9999 })

    // 租户 C：利润、广告、会话都已接入
    await store(c, '2026-09-30', { orders: 4, units: 8, salesAmount: 80, profit: 10, adsSpend: 20, sessions: 100 })
    await store(c, '2026-10-01', { orders: 3, units: 6, salesAmount: 60, profit: 12, adsSpend: 15, sessions: 100 })
    await store(c, '2026-10-02', { orders: 5, units: 10, salesAmount: 100, profit: 30, adsSpend: 20, sessions: 200 })
    await asin(c, '2026-10-01', 'P1', { units: 3, salesAmount: 30, profit: 8 })
    await asin(c, '2026-10-02', 'P1', { units: 4, salesAmount: 40, profit: 12 })
    await asin(c, '2026-10-02', 'P2', { units: 3, salesAmount: 30, profit: 10 })
    await asin(c, '2026-09-30', 'P1', { units: 5, salesAmount: 50, profit: 5 })
    await asin(c, '2026-09-30', 'P2', { units: 3, salesAmount: 30, profit: 5 })

    // 预警：A 店的严重、企业级的警告（不属于任何店铺）、二店的提示；已处理、已忽略、自动关闭的不计；租户 B 的不计
    // （状态取值受数据库约束限制：NEW、ACKED、HANDLED、IGNORED、AUTO_CLOSED）
    const rule = (ids: Ids, id: string) => insertRow(h.client, 'AlertRule', { id, tenantId: ids.tenantId, code: id, domain: 'INVENTORY', name: '测试规则', conditionJson: '{}', scopeJson: '{}' })
    await rule(a, 'rule-a')
    await rule(b, 'rule-b')
    const alert = (ids: Ids, ruleId: string, severity: string, status: string, sellerAccountId: string | null) =>
      insertRow(h.client, 'AlertInstance', {
        id: `al-${++seq}`,
        tenantId: ids.tenantId,
        ruleId,
        sellerAccountId,
        severity,
        status,
        entityType: 'SKU',
        entityId: `e-${seq}`,
        evidenceJson: '{}',
        dedupKey: `k-${seq}`,
      })
    await alert(a, 'rule-a', 'CRITICAL', 'NEW', a.sellerAccountId)
    await alert(a, 'rule-a', 'WARNING', 'ACKED', null)
    await alert(a, 'rule-a', 'INFO', 'NEW', a2)
    for (const closed of ['HANDLED', 'IGNORED', 'AUTO_CLOSED']) await alert(a, 'rule-a', 'CRITICAL', closed, a.sellerAccountId)
    await alert(b, 'rule-b', 'CRITICAL', 'NEW', b.sellerAccountId)

    // 事件标注：一条改价事件；待办处理记录不算经营事件
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-1',
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      entityType: 'ASIN',
      entityId: 'A1',
      kind: 'PRICE_CHANGE',
      title: 'A1 调价到 19.99',
      occurredAt: '2026-10-03T19:00:00Z',
    })
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-2',
      tenantId: a.tenantId,
      entityType: 'WORK_ITEM',
      entityId: 'w1',
      kind: 'WORK_ITEM_ACK',
      title: '待办已确认',
      occurredAt: '2026-10-03T19:00:00Z',
    })
    await insertRow(h.client, 'EntityEvent', { id: 'ev-3', tenantId: b.tenantId, entityType: 'ASIN', entityId: 'B1', kind: 'PRICE_CHANGE', title: 'B 的事件', occurredAt: '2026-10-03T19:00:00Z' })
  }, 240_000)
  afterAll(async () => {
    await h?.close()
  })

  describe('指标卡', () => {
    it('销售额、对比期变化、逐日走势；利润、广告、库存、会话尚未接入时为空而不是 0；异常数是真实计数', async () => {
      const data = await get(owner, `/overview/kpis?${RANGE}`)
      expect(data.period).toEqual({ from: '2026-10-01', to: '2026-10-07', days: 7 })
      expect(data.compare).toMatchObject({ mode: 'previous', from: '2026-09-24', to: '2026-09-30' })
      expect(data.defaulted).toBe(false)
      const cards = Object.fromEntries((data.cards as KpiCard[]).map(card => [card.key, card]))
      expect(cards.sales).toMatchObject({ state: 'OK', value: 380, compareValue: 200, trend: [150, 0, 200, 0, 0, 0, 30] })
      expect(cards.sales.change).toBeCloseTo(0.9)
      for (const key of ['profit', 'margin', 'adsSpend', 'adsShare', 'stockRisk']) expect(cards[key], key).toMatchObject({ state: 'NOT_CONNECTED', value: null, trend: null, change: null })
      expect(cards.anomalies).toMatchObject({ state: 'OK', value: 3 })
      expect(data.anomalyBreakdown).toEqual({ critical: 1, warning: 1, info: 1 })
      expect(data.officialProfit.state).toBe('NOT_CONNECTED')
      expect(data.target.state).toBe('NOT_CONNECTED')
      expect(data.metricVersion).toBe('p2a-01@1')
      expect(data.refreshedAt).toBeTruthy()
    })

    it('没有选择时间范围：默认近 30 天并对比上一期，如实标记为默认', async () => {
      const data = await get(owner, '/overview/kpis')
      expect(data.defaulted).toBe(true)
      expect(data.period.days).toBe(30)
      expect(data.compare).toMatchObject({ mode: 'previous', days: 30 })
      expect(data.period.to).toBe(laDay(new Date()))
    })

    it('不对比：没有对比值与变化；范围内没有汇总：销售额是“尚无记录”，值为空', async () => {
      const none = await get(owner, '/overview/kpis?from=2026-10-01&to=2026-10-07&compare=none')
      expect(none.compare).toBeNull()
      expect(none.cards[0]).toMatchObject({ value: 380, compareValue: null, change: null })
      const empty = await get(owner, '/overview/kpis?from=2026-12-01&to=2026-12-07&compare=none')
      expect(empty.cards[0]).toMatchObject({ state: 'NO_DATA', value: null, trend: null })
    })

    it('对比期没有记录：不给变化，并说明', async () => {
      const data = await get(owner, '/overview/kpis?from=2026-10-01&to=2026-10-07&compare=custom&compareFrom=2026-01-01&compareTo=2026-01-07')
      expect(data.cards[0]).toMatchObject({ value: 380, compareValue: null, change: null })
      expect(data.cards[0].note).toContain('对比期')
    })

    it('去年同期：对比的是去年同日期范围', async () => {
      const data = await get(owner, '/overview/kpis?from=2026-10-01&to=2026-10-07&compare=yoy')
      expect(data.compare).toMatchObject({ mode: 'yoy', from: '2025-10-01', to: '2025-10-07' })
      expect(data.cards[0]).toMatchObject({ compareValue: 40 })
    })

    it('利润、广告、会话已接入的租户：净利润、利润率（百分点差）、广告花费、广告占总销售比', async () => {
      const data = await get(ownerC, `/overview/kpis?${RANGE}`)
      const cards = Object.fromEntries((data.cards as KpiCard[]).map(card => [card.key, card]))
      expect(cards.sales).toMatchObject({ value: 160, compareValue: 80 })
      expect(cards.profit).toMatchObject({ state: 'OK', value: 42, compareValue: 10 })
      expect(cards.margin.value).toBeCloseTo(42 / 160)
      expect(cards.margin.change).toBeCloseTo(42 / 160 - 10 / 80)
      expect(cards.margin.changeKind).toBe('points')
      expect(cards.adsSpend).toMatchObject({ state: 'OK', value: 35, compareValue: 20 })
      expect(cards.adsShare.value).toBeCloseTo(35 / 160)
      expect(cards.profit.trend).toEqual([12, 30, null, null, null, null, null])
    })

    it('没有“利润”字段权限：净利润与利润率受限且不带数值，整个响应里也找不到利润数字；销售额正常', async () => {
      const res = await h.call(operatorC.token, 'GET', `/overview/kpis?${RANGE}`)
      expect(res.status).toBe(200)
      const cards = Object.fromEntries((res.json.data.cards as KpiCard[]).map(card => [card.key, card]))
      expect(cards.profit).toMatchObject({ state: 'RESTRICTED', value: null, compareValue: null, trend: null })
      expect(cards.margin).toMatchObject({ state: 'RESTRICTED', value: null })
      expect(cards.sales.value).toBe(160)
      expect(JSON.stringify(res.json.data)).not.toContain('"profit":42')
    })

    it('数据范围收窄到一家店：销售额、异常数只含该店与企业级预警；其他店的数据看不到', async () => {
      const data = await get(storeOnly, `/overview/kpis?${RANGE}`)
      expect(data.cards[0]).toMatchObject({ value: 300, compareValue: 80 })
      expect(data.anomalyBreakdown).toEqual({ critical: 1, warning: 1, info: 0 })
    })

    it('租户隔离：租户 B 只看到自己的数据，看不到租户 A 的销售额与预警', async () => {
      const data = await get(ownerB, `/overview/kpis?${RANGE}`)
      expect(data.cards[0]).toMatchObject({ value: 9999, compareValue: null })
      expect(data.anomalyBreakdown).toEqual({ critical: 1, warning: 0, info: 0 })
    })

    it('没有 overview.read 的成员 403；未登录 401', async () => {
      const nobody = await h.createMember(a.tenantId, 'ov-none', ['orders.read'])
      expect((await h.call(nobody.token, 'GET', `/overview/kpis?${RANGE}`)).status).toBe(403)
      expect((await h.call(null, 'GET', `/overview/kpis?${RANGE}`)).status).toBe(401)
    })
  })

  describe('趋势', () => {
    it('按日：本期、环比、同比三条线按位置对齐；没有记录的日子销售额按 0', async () => {
      const data = await get(owner, `/overview/trend?${RANGE}&metric=sales&granularity=day`)
      expect(data.state).toBe('OK')
      expect(data.points.map((p: { value: number }) => p.value)).toEqual([150, 0, 200, 0, 0, 0, 30])
      expect(data.previous.map((p: { value: number }) => p.value)).toEqual([0, 80, 0, 0, 0, 0, 120])
      expect(data.yoy.map((p: { value: number }) => p.value)).toEqual([0, 40, 0, 0, 0, 0, 0])
      expect(data.points[0].key).toBe('2026-10-01')
    })

    it('按周（周一起）与按月：桶内合并，环比按位置并入同一个桶', async () => {
      const week = await get(owner, `/overview/trend?${RANGE}&metric=sales&granularity=week`)
      expect(week.points).toEqual([
        { key: '2026-09-28', value: 350 },
        { key: '2026-10-05', value: 30 },
      ])
      expect(week.previous).toEqual([
        { key: '2026-09-28', value: 80 },
        { key: '2026-10-05', value: 120 },
      ])
      const month = await get(owner, `/overview/trend?${RANGE}&metric=orders&granularity=month`)
      expect(month.points).toEqual([{ key: '2026-10-01', value: 8 }])
      expect(month.unit).toBe('number')
    })

    it('利润、广告花费尚未接入：状态为“尚未接入”，没有点位；销售额的双轴里利润线也如实标注', async () => {
      for (const metric of ['profit', 'adsSpend']) {
        const data = await get(owner, `/overview/trend?${RANGE}&metric=${metric}`)
        expect(data, metric).toMatchObject({ state: 'NOT_CONNECTED', points: [], previous: null })
      }
      const sales = await get(owner, `/overview/trend?${RANGE}&metric=sales`)
      expect(sales.profit).toMatchObject({ state: 'NOT_CONNECTED', points: null })
    })

    it('利润已接入且有权限：销售额叠加净利润线（缺失的日子为空）；没有权限：受限', async () => {
      const data = await get(ownerC, `/overview/trend?${RANGE}&metric=sales`)
      expect(data.profit.state).toBe('OK')
      expect(data.profit.points.map((p: { value: number | null }) => p.value)).toEqual([12, 30, null, null, null, null, null])
      const restricted = await get(operatorC, `/overview/trend?${RANGE}&metric=sales`)
      expect(restricted.profit).toMatchObject({ state: 'RESTRICTED', points: null })
      expect(JSON.stringify(restricted)).not.toContain('12,30')
      const direct = await get(operatorC, `/overview/trend?${RANGE}&metric=profit`)
      expect(direct).toMatchObject({ state: 'RESTRICTED', points: [] })
    })

    it('没有记录的范围：状态是“尚无记录”，没有线', async () => {
      const data = await get(owner, '/overview/trend?from=2026-12-01&to=2026-12-07&compare=none')
      expect(data).toMatchObject({ state: 'NO_DATA', points: [], previous: null, yoy: null })
    })

    it('事件标注：只含本企业、范围内的经营事件；按企业时区落日；待办处理记录不算；收窄范围后看不到其他店的事件', async () => {
      const data = await get(owner, `/overview/trend?${RANGE}`)
      expect(data.events).toEqual([{ date: '2026-10-03', label: 'A1 调价到 19.99', kind: 'PRICE_CHANGE' }])
      const other = await get(ownerB, `/overview/trend?${RANGE}`)
      expect(other.events.map((event: { label: string }) => event.label)).toEqual(['B 的事件'])
    })
  })

  describe('指标树归因', () => {
    it('没有会话数据：退化为 件数 × 件单价，并说明会话、转化率未接入', async () => {
      const data = await get(owner, '/overview/attribution?date=2026-10-03&granularity=day')
      expect(data).toMatchObject({
        state: 'OK',
        mode: 'TWO_FACTOR',
        current: { from: '2026-10-03', to: '2026-10-03' },
        previous: { from: '2026-10-02', to: '2026-10-02' },
        sales: { before: 0, after: 200 },
      })
      expect(data.factors.map((f: { key: string }) => f.key)).toEqual(['units', 'unitPrice'])
      expect(data.unavailable.map((item: { key: string }) => item.key)).toEqual(['sessions', 'conversion'])
      expect(data.profitBridge.state).toBe('NOT_CONNECTED')
    })

    it('周粒度：本周对上周', async () => {
      const data = await get(owner, '/overview/attribution?date=2026-10-01&granularity=week')
      expect(data).toMatchObject({ current: { from: '2026-09-28', to: '2026-10-04' }, previous: { from: '2026-09-21', to: '2026-09-27' }, sales: { before: 80, after: 470 } })
    })

    it('有会话数据：会话 × 转化率 × 件单价，三因子相乘等于销售额', async () => {
      const data = await get(ownerC, '/overview/attribution?date=2026-10-02')
      expect(data.mode).toBe('THREE_FACTOR')
      expect(data.unavailable).toEqual([])
      const factors = data.factors as Array<{ key: string; before: number; after: number }>
      expect(factors.map(f => f.key)).toEqual(['sessions', 'conversion', 'unitPrice'])
      expect(factors.reduce((p, f) => p * f.after, 1)).toBeCloseTo(100)
      expect(factors.reduce((p, f) => p * f.before, 1)).toBeCloseTo(60)
    })

    it('没有记录：状态为“尚无记录”', async () => {
      expect((await get(owner, '/overview/attribution?date=2026-12-03')).state).toBe('NO_DATA')
    })

    it('没有利润权限时利润桥受限', async () => {
      expect((await get(operatorC, '/overview/attribution?date=2026-10-02')).profitBridge.state).toBe('RESTRICTED')
    })
  })

  describe('店铺对比与 ASIN 排名', () => {
    it('店铺对比：按销售额排序，含对比期变化；利润、库存风险、账户健康尚未接入', async () => {
      const data = await get(owner, `/overview/store-compare?${RANGE}`)
      expect(data.rows.map((row: { storeName: string }) => row.storeName)).toEqual(['A 一店', 'A 二店'])
      expect(data.rows[0]).toMatchObject({ sales: 300, compareSales: 80, profit: null, margin: null, adsShare: null })
      expect(data.rows[0].salesChange).toBeCloseTo(2.75)
      expect(data.rows[1]).toMatchObject({ sales: 80, compareSales: 120 })
      expect(data.rows[1].salesChange).toBeCloseTo(-1 / 3)
      expect(data.columns).toEqual({ profit: 'NOT_CONNECTED', ads: 'NOT_CONNECTED', inventoryRisk: 'NOT_CONNECTED', accountHealth: 'NOT_CONNECTED' })
    })

    it('店铺对比：没有销售的店铺也列出（销售额 0）；收窄范围只含授权店铺；利润无权限时为空', async () => {
      const empty = await insertRow(h.client, 'SellerAccount', { id: 'seller-ova-3', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-OVA-3', displayName: 'A 三店' })
      const all = await get(owner, `/overview/store-compare?${RANGE}`)
      expect(all.rows.at(-1)).toMatchObject({ storeId: empty.id, sales: 0, compareSales: 0 })
      const scoped = await get(storeOnly, `/overview/store-compare?${RANGE}`)
      expect(scoped.rows.map((row: { storeName: string }) => row.storeName)).toEqual(['A 一店'])
      const profit = await get(operatorC, `/overview/store-compare?${RANGE}`)
      expect(profit.columns.profit).toBe('RESTRICTED')
      expect(profit.rows[0].profit).toBeNull()
      const owned = await get(ownerC, `/overview/store-compare?${RANGE}`)
      expect(owned.rows[0]).toMatchObject({ sales: 160, profit: 42 })
      expect(owned.columns.profit).toBe('OK')
      expect(owned.rows[0].adsShare).toBeCloseTo(35 / 160)
    })

    it('ASIN 排名（销售额）：前几名与后几名不重叠；带销售额变化；利润尚未接入时为空', async () => {
      const data = await get(owner, `/overview/asin-rank?${RANGE}&rankBy=sales`)
      expect(data.state).toBe('OK')
      expect(data.top.map((row: { asin: string }) => row.asin)).toEqual(['A1', 'A3', 'A2', 'N1'])
      expect(data.bottom).toEqual([])
      expect(data.top[0]).toMatchObject({ asin: 'A1', sku: 'SKU-A1', sales: 210, units: 5, profit: null, margin: null })
      expect(data.top[0].salesChange).toBeCloseTo(130 / 80)
      expect(data.top[3]).toMatchObject({ asin: 'N1', salesChange: null })
    })

    it('ASIN 排名：前后各 10 个，超过 20 个时前后两端不重叠', async () => {
      for (let i = 1; i <= 25; i++) await asin(b, '2026-10-02', `Z${String(i).padStart(2, '0')}`, { units: 1, salesAmount: i })
      const data = await get(ownerB, '/overview/asin-rank?from=2026-10-01&to=2026-10-07&compare=none')
      expect(data.top.map((row: { sales: number }) => row.sales)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16])
      expect(data.bottom.map((row: { sales: number }) => row.sales)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    it('ASIN 排名（利润）：尚未接入时是“尚未接入”；接入后按净利润、利润率、利润变化排名；无权限是受限', async () => {
      expect(await get(owner, `/overview/asin-rank?${RANGE}&rankBy=profit`)).toMatchObject({ state: 'NOT_CONNECTED', top: [], bottom: [] })
      const profit = await get(ownerC, `/overview/asin-rank?${RANGE}&rankBy=profit`)
      expect(profit.top.map((row: { asin: string }) => row.asin)).toEqual(['P1', 'P2'])
      expect(profit.top[0]).toMatchObject({ profit: 20, sales: 70, profitChange: 15 })
      const margin = await get(ownerC, `/overview/asin-rank?${RANGE}&rankBy=margin`)
      // 候选不足 10 个时全部排在“前”，后面的列表为空（与销售额排名一致，前后不重叠）
      expect(margin.top.map((row: { asin: string }) => row.asin)).toEqual(['P2', 'P1'])
      expect(margin.bottom).toEqual([])
      expect(margin.candidateLimit).toBe(1000)
      const change = await get(ownerC, `/overview/asin-rank?${RANGE}&rankBy=profitChange`)
      expect(change.top[0]).toMatchObject({ asin: 'P1', profitChange: 15 })
      expect(change.top[1]).toMatchObject({ asin: 'P2', profitChange: 5 })
      expect(await get(operatorC, `/overview/asin-rank?${RANGE}&rankBy=profit`)).toMatchObject({ state: 'RESTRICTED', top: [] })
      const sales = await get(operatorC, `/overview/asin-rank?${RANGE}&rankBy=sales`)
      expect(sales.top.every((row: { profit: number | null; margin: number | null }) => row.profit === null && row.margin === null)).toBe(true)
    })

    it('利润变化需要对比期', async () => {
      const data = await get(ownerC, '/overview/asin-rank?from=2026-10-01&to=2026-10-07&compare=none&rankBy=profitChange')
      expect(data.state).toBe('NO_DATA')
    })
  })

  describe('增长归因瀑布', () => {
    it('按店铺与按驱动因素拆解，各项之和等于总变化；断货损失未接入为空且标注模型估算', async () => {
      const data = await get(owner, `/overview/growth-waterfall?${RANGE}`)
      expect(data).toMatchObject({ state: 'OK', base: 200, current: 380, total: 180, note: null })
      const sum = (items: Array<{ amount: number | null }>) => items.reduce((total, item) => total + (item.amount ?? 0), 0)
      expect(data.byStore.map((item: { label: string; amount: number }) => [item.label, item.amount])).toEqual([
        ['A 一店', 220],
        ['A 二店', -40],
        ['A 三店', 0],
      ])
      expect(sum(data.byStore)).toBe(180)
      const byKey = Object.fromEntries((data.byDriver as WaterfallItem[]).map(item => [item.key, item]))
      expect(byKey['asin:A1']).toMatchObject({ amount: 130, kind: 'asin' })
      expect(byKey['asin:A2']).toMatchObject({ amount: 30 })
      expect(byKey['asin:A3']).toMatchObject({ amount: -70 })
      expect(byKey.new).toMatchObject({ amount: 30, kind: 'new' })
      expect(byKey.other.amount).toBe(0)
      expect(byKey.unattributed.amount).toBe(60)
      expect(byKey.stockout).toMatchObject({ amount: null, estimate: true })
      expect(sum(data.byDriver)).toBe(180)
    })

    it('没有选择对比期时按上一期拆解并说明；对比期没有记录时不拆解', async () => {
      const data = await get(owner, '/overview/growth-waterfall?from=2026-10-01&to=2026-10-07&compare=none')
      expect(data.total).toBe(180)
      expect(data.note).toContain('上一期')
      const none = await get(owner, '/overview/growth-waterfall?from=2026-12-01&to=2026-12-07')
      expect(none).toMatchObject({ state: 'NO_DATA', byStore: [], byDriver: [] })
    })

    it('收窄范围只统计授权店铺', async () => {
      const data = await get(storeOnly, `/overview/growth-waterfall?${RANGE}`)
      expect(data).toMatchObject({ base: 80, current: 300, total: 220 })
      expect(data.byStore).toHaveLength(1)
    })
  })

  describe('现金视角', () => {
    const FROM = laDay(daysFromNow(-10))
    const TO = laDay(daysFromNow(0))
    const money = (ids: Ids, sellerAccountId: string, patch: Record<string, unknown>) =>
      insertRow(h.client, 'FbaFinancialTransaction', {
        id: `ft-${++seq}`,
        tenantId: ids.tenantId,
        sellerAccountId,
        externalTransactionId: `ext-${seq}`,
        currency: 'USD',
        sourceUpdatedAt: new Date(),
        ...patch,
      })

    beforeAll(async () => {
      await money(a, a.sellerAccountId, { transactionStatus: 'RELEASED', amount: 100, postedAt: daysFromNow(-5) })
      await money(a, a.sellerAccountId, { transactionStatus: 'DEFERRED_RELEASED', amount: 50, postedAt: daysFromNow(-4) })
      await money(a, a.sellerAccountId, { transactionStatus: 'DEFERRED', amount: 999, postedAt: daysFromNow(-4) })
      await money(a, a.sellerAccountId, { transactionStatus: 'RELEASED', amount: 7, currency: 'EUR', postedAt: daysFromNow(-4) })
      await money(a, a.sellerAccountId, { transactionStatus: 'RELEASED', amount: 500, postedAt: daysFromNow(-30) })
      await money(a, a2, { transactionStatus: 'RELEASED', amount: 10, postedAt: daysFromNow(-3) })
      const balance = (sellerAccountId: string, day: number, accountType: string, amount: number) =>
        insertRow(h.client, 'AccountBalanceSnapshot', {
          id: `bal-${++seq}`,
          tenantId: a.tenantId,
          sellerAccountId,
          snapshotDate: laDay(daysFromNow(day)),
          balanceType: 'DEFERRED',
          accountType,
          currency: 'USD',
          amount,
          sourceUpdatedAt: new Date(),
        })
      await balance(a.sellerAccountId, -2, 'Standard', 300)
      await balance(a.sellerAccountId, -2, 'Invoiced', 20)
      await balance(a.sellerAccountId, -9, 'Standard', 500)
      await balance(a2, -6, 'Standard', 70)
      const settlement = (sellerAccountId: string, day: number, id: string) =>
        insertRow(h.client, 'FbaSettlement', { id: `st-${id}`, tenantId: a.tenantId, sellerAccountId, externalSettlementId: id, depositDate: daysFromNow(day), sourceUpdatedAt: new Date() })
      await settlement(a.sellerAccountId, 5, 'S-next')
      await settlement(a2, 9, 'S-later')
      await settlement(a.sellerAccountId, -3, 'S-past')
    })

    it('已释放回款（只算已释放、美元、本期）、递延中余额（每店最近一次快照）、下次打款日（最早的未来结算）', async () => {
      const data = await get(financeAll, `/overview/cash?from=${FROM}&to=${TO}`)
      expect(data.state).toBe('OK')
      expect(data.released).toBe(160)
      expect(data.deferred).toEqual({ amount: 390, asOf: laDay(daysFromNow(-6)) })
      expect(data.nextPayoutDate).toBe(laDay(daysFromNow(5)))
    })

    it('收窄到一家店：只含该店；没有 finance.read：受限且没有任何金额', async () => {
      const scoped = await get(financeStore, `/overview/cash?from=${FROM}&to=${TO}`)
      expect(scoped).toMatchObject({ released: 150, deferred: { amount: 320, asOf: laDay(daysFromNow(-2)) } })
      const denied = await get(operator, `/overview/cash?from=${FROM}&to=${TO}`)
      expect(denied).toMatchObject({ state: 'RESTRICTED', released: null, deferred: null, nextPayoutDate: null })
    })

    it('没有任何财务记录：状态是“尚无记录”，金额为空而不是 0，也不推测打款日', async () => {
      const data = await get(ownerB, `/overview/cash?from=${FROM}&to=${TO}`)
      expect(data).toMatchObject({ state: 'NO_DATA', released: null, deferred: null, nextPayoutDate: null })
      expect(data.nextPayoutNote).toContain('不做推测')
    })
  })

  describe('尚未交付的区域', () => {
    it('广告异常、库存风险如实返回“尚未接入”', async () => {
      expect(await get(owner, '/overview/ad-anomalies')).toMatchObject({ state: 'NOT_CONNECTED', workPackage: 'P3' })
      expect(await get(owner, '/overview/inventory-risk')).toMatchObject({ state: 'NOT_CONNECTED', workPackage: 'P2a-06' })
    })
  })
})
