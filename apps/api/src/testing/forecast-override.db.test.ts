import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 人工预测规则与补货重算（P6-09，真实数据库 + 完整应用）：
//   - 规则管理：权限、数据范围（必须是“全部店铺”）、企业隔离、对象必须存在、时间段重叠 409、乐观锁、数据库约束兜底；
//   - 规则进入重算：人工规则胜过模型预测、SKU 优先于品类、去年同期取数与“去年没数据不生效”；
//   - 批次冻结：批次生成后修改、删除规则，已生成批次的数字与说明保持不变；
//   - 迁移：升级、回滚与再升级。

const TARGET = '20261212010000_forecast_override'
const MIGRATION = join(MIGRATIONS_DIR, TARGET)
const ROUTE = '/replenishment/forecast-overrides'
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const lastYear = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`

const POLICY = {
  level: 'TENANT',
  levelRef: 'ALL',
  expectedVersionNo: 0,
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED', 'RECEIVING'],
  agingFromDays: 271,
  changeReason: '首次设置',
  productionDays: 10,
  domesticDays: 3,
  receivingDays: 7,
  serviceLevel: 0.95,
  transportPreference: 'AUTO',
  transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
  casePackQty: 10,
  moq: 100,
  minOrderValue: null,
  includeUnavoidableShortage: true,
}

type Member = { userId: string; token: string }
type Rule = { id: string; version: number; status: string; summary: string }

describe('人工预测规则（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let otherTenantId: string
  let owner: Member
  let planner: Member
  let scoped: Member
  let other: Member

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const rule = (over: Record<string, unknown> = {}) => ({ scopeType: 'SKU', scopeId: 'SKU-A', from: dayOffset(0), to: dayOffset(200), mode: 'FIXED', value: 20, ...over })
  const create = (body: Record<string, unknown> = {}, member = owner) => call(member, 'POST', ROUTE, rule(body))
  const created = async (body: Record<string, unknown> = {}) => {
    const res = await create(body)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json.data as Rule
  }
  const recompute = async () => {
    const res = await call(owner, 'POST', '/replenishment/recompute', {})
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json.data.batch.id as string
  }
  const frozen = async (batchId: string) =>
    (await rows<{ calcStepsJson: Record<string, any>; recommendedQty: number }>(`SELECT "calcStepsJson", "recommendedQty" FROM "ReplenishmentRecommendation" WHERE "batchId" = $1`, [batchId]))[0]!
  const clearRules = () => h.client.query(`DELETE FROM "ForecastOverride" WHERE "tenantId" = $1`, [tenantId])

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'forecast_override' })
    const a = await h.createTenant('fo-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    const b = await h.createTenant('fo-b')
    otherTenantId = b.tenantId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" IN ($1, $2)`, [tenantId, otherTenantId])
    owner = await h.createMember(tenantId, 'fo-owner', ['*'])
    planner = await h.createMember(tenantId, 'fo-planner', ['replenishment.read', 'replenishment.plan.create'])
    scoped = await h.createMember(tenantId, 'fo-scoped', ['*'], { scopes: [{ sellerAccountId: storeA }] })
    other = await h.createMember(otherTenantId, 'fo-other', ['*'])

    // 可售 200，近 95 天每天卖 10 件；商品类型“耳机”
    await insertRow(h.client, 'FbaProduct', { id: 'fo-p1', tenantId, sellerAccountId: storeA, asin: 'B0AAAAAAAA', sellerSku: 'SKU-A', fnsku: 'X0AAAAAAAA', title: '耳机 A', productType: '耳机' })
    await insertRow(h.client, 'FbaInventoryRecord', {
      id: 'fo-inv',
      tenantId,
      sellerAccountId: storeA,
      marketplaceId: 'ATVPDKIKX0DER',
      sellerSku: 'SKU-A',
      asin: 'B0AAAAAAAA',
      fnsku: 'X0AAAAAAAA',
      fulfillableQuantity: 200,
    })
    for (let day = 1; day <= 95; day += 1) {
      await insertRow(h.client, 'AsinDailySummary', { id: `fo-ads-${day}`, tenantId, sellerAccountId: storeA, summaryDate: dayOffset(-day), asin: 'B0AAAAAAAA', units: 10, metricVersion: 'p2a-01@1' })
    }
    // 去年同期（今天后第 1 到 10 天对应的去年日期）每天卖 6 件
    for (let day = 1; day <= 10; day += 1) {
      await insertRow(h.client, 'AsinDailySummary', {
        id: `fo-ly-${day}`,
        tenantId,
        sellerAccountId: storeA,
        summaryDate: lastYear(dayOffset(day)),
        asin: 'B0AAAAAAAA',
        units: 6,
        metricVersion: 'p2a-01@1',
      })
    }
    await insertRow(h.client, 'FbaProduct', {
      id: 'fo-p-other',
      tenantId: otherTenantId,
      sellerAccountId: b.sellerAccountId,
      asin: 'B0OTHER001',
      sellerSku: 'SKU-O',
      title: '别家商品',
      productType: '耳机',
    })
    const saved = await call(owner, 'PUT', '/replenishment/policies', POLICY)
    expect(saved.status, JSON.stringify(saved.json)).toBe(200)
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('规则管理', () => {
    it('权限：没登录 401；只有读取权限能看列表但写入 403；数据范围不是全部店铺的成员写入 403', async () => {
      expect((await h.call(null, 'GET', ROUTE)).status).toBe(401)
      const list = (await call(planner, 'GET', ROUTE)).json.data
      expect(list).toMatchObject({ canManage: false, items: [], total: 0, activeLimit: 300 })
      expect(list.manageBlockedReason).toContain('补货策略维护')
      expect((await create({}, planner)).status).toBe(403)
      expect((await call(planner, 'PUT', `${ROUTE}/x`, { version: 1, value: 3 })).status).toBe(403)
      expect((await call(planner, 'DELETE', `${ROUTE}/x`)).status).toBe(403)
      const limited = await create({}, scoped)
      expect(limited.status).toBe(403)
      expect(limited.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    })

    it('新增：对象必须是已有商品（SKU 或商品类型）；参数不合法 422；成功写审计', async () => {
      expect((await create({ scopeId: 'SKU-NOPE' })).status).toBe(404)
      expect((await create({ scopeType: 'CATEGORY', scopeId: '不存在的类型' })).status).toBe(404)
      expect((await create({ to: dayOffset(-3), from: dayOffset(-10) })).status).toBe(422)
      expect((await create({ from: dayOffset(5), to: dayOffset(1) })).status).toBe(422)
      expect((await create({ mode: 'YOY_FACTOR', value: 0 })).status).toBe(422)
      expect((await create({ mode: 'YOY_FACTOR', value: 25 })).status).toBe(422)
      expect((await create({ from: dayOffset(0), to: dayOffset(400) })).status).toBe(422)
      expect((await call(owner, 'POST', ROUTE, { ...rule(), extra: 1 })).status).toBe(422)
      const made = await created({ scopeId: 'SKU-A', to: dayOffset(30) })
      expect(made).toMatchObject({ version: 1, status: 'ACTIVE' })
      expect(made.summary).toContain('固定日销 20 件/天')
      const audit = await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'REPLENISHMENT_FORECAST_OVERRIDE_CREATED' AND "resourceId" = $1 AND result = 'SUCCEEDED'`, [made.id])
      expect(audit).toHaveLength(1)
      await clearRules()
    })

    it('同一对象的时间段不能重叠（409，指出冲突的规则）；相邻不重叠可以；不同对象互不影响', async () => {
      const first = await created({ from: dayOffset(0), to: dayOffset(9) })
      const clash = await create({ from: dayOffset(9), to: dayOffset(15) })
      expect(clash.status).toBe(409)
      expect(clash.json.error.message).toContain('时间段与已有规则重叠')
      expect((await create({ from: dayOffset(10), to: dayOffset(15) })).status).toBe(201)
      expect((await create({ scopeType: 'CATEGORY', scopeId: '耳机', from: dayOffset(0), to: dayOffset(9) })).status).toBe(201)
      // 修改到与另一条重叠
      const moved = await call(owner, 'PUT', `${ROUTE}/${first.id}`, { version: first.version, to: dayOffset(12) })
      expect(moved.status).toBe(409)
      await clearRules()
    })

    it('修改带版本号：旧版本 409；空修改 422；并发两次修改只成功一次；删除写审计', async () => {
      const made = await created({ to: dayOffset(30) })
      const ok = await call(owner, 'PUT', `${ROUTE}/${made.id}`, { version: made.version, value: 25, note: '大促预热' })
      expect(ok.status, JSON.stringify(ok.json)).toBe(200)
      expect(ok.json.data).toMatchObject({ version: 2, value: 25, note: '大促预热' })
      expect((await call(owner, 'PUT', `${ROUTE}/${made.id}`, { version: 1, value: 30 })).status).toBe(409)
      expect((await call(owner, 'PUT', `${ROUTE}/${made.id}`, { version: 2 })).status).toBe(422)
      const race = await Promise.all([call(owner, 'PUT', `${ROUTE}/${made.id}`, { version: 2, value: 1 }), call(owner, 'PUT', `${ROUTE}/${made.id}`, { version: 2, value: 2 })])
      expect(race.map(res => res.status).sort()).toEqual([200, 409])
      expect((await call(owner, 'DELETE', `${ROUTE}/${made.id}`)).status).toBe(200)
      expect((await call(owner, 'DELETE', `${ROUTE}/${made.id}`)).status).toBe(404)
      expect(await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'REPLENISHMENT_FORECAST_OVERRIDE_DELETED' AND "resourceId" = $1`, [made.id])).toHaveLength(1)
    })

    it('企业隔离：别的企业看不到、改不了、删不了；也不能用别家的 SKU 建规则', async () => {
      const made = await created({ to: dayOffset(30) })
      expect((await call(other, 'GET', ROUTE)).json.data.total).toBe(0)
      expect((await call(other, 'PUT', `${ROUTE}/${made.id}`, { version: 1, value: 3 })).status).toBe(404)
      expect((await call(other, 'DELETE', `${ROUTE}/${made.id}`)).status).toBe(404)
      expect((await call(other, 'POST', ROUTE, rule({ scopeId: 'SKU-A' }))).status).toBe(404)
      expect((await call(other, 'POST', ROUTE, rule({ scopeId: 'SKU-O' }))).status).toBe(201)
      await clearRules()
      await h.client.query(`DELETE FROM "ForecastOverride" WHERE "tenantId" = $1`, [otherTenantId])
    })

    it('列表：按状态与对象类型筛选；已结束的规则不能再修改；数据库约束兜底', async () => {
      await insertRow(h.client, 'ForecastOverride', {
        id: 'fo-old',
        tenantId,
        scopeType: 'SKU',
        scopeId: 'SKU-A',
        fromDate: dayOffset(-40),
        toDate: dayOffset(-30),
        mode: 'FIXED',
        value: 3,
        createdBy: owner.userId,
      })
      const soon = await created({ from: dayOffset(20), to: dayOffset(30) })
      expect((await call(owner, 'GET', `${ROUTE}?status=EXPIRED`)).json.data.items.map((item: Rule) => item.id)).toEqual(['fo-old'])
      expect((await call(owner, 'GET', `${ROUTE}?status=UPCOMING`)).json.data.items.map((item: Rule) => item.id)).toEqual([soon.id])
      const all = (await call(owner, 'GET', ROUTE)).json.data
      expect(all).toMatchObject({ total: 2, activeCount: 1 })
      expect((await call(owner, 'PUT', `${ROUTE}/fo-old`, { version: 1, value: 4 })).status).toBe(409)
      expect((await call(owner, 'GET', `${ROUTE}?scopeType=CATEGORY`)).json.data.total).toBe(0)
      await expect(
        insertRow(h.client, 'ForecastOverride', {
          id: 'fo-bad',
          tenantId,
          scopeType: 'SKU',
          scopeId: 'SKU-A',
          fromDate: dayOffset(5),
          toDate: dayOffset(1),
          mode: 'FIXED',
          value: 3,
          createdBy: owner.userId,
        }),
      ).rejects.toThrow()
      await expect(
        insertRow(h.client, 'ForecastOverride', {
          id: 'fo-bad2',
          tenantId,
          scopeType: 'SKU',
          scopeId: 'SKU-A',
          fromDate: dayOffset(1),
          toDate: dayOffset(5),
          mode: 'YOY_FACTOR',
          value: 0,
          createdBy: owner.userId,
        }),
      ).rejects.toThrow()
      await clearRules()
    })
  })

  describe('进入重算与批次冻结', () => {
    it('人工规则胜过模型预测；改规则、删规则都不改变已生成的批次；规则只影响之后的重算', async () => {
      await clearRules()
      const plain = await recompute()
      const base = await frozen(plain)
      expect(base.calcStepsJson.dailyDemand).toBe(10)
      expect(base.calcStepsJson.appliedOverride).toEqual([])

      const made = await created({ to: dayOffset(200), value: 20 })
      const withRule = await recompute()
      const ruled = await frozen(withRule)
      expect(ruled.calcStepsJson.dailyDemand).toBe(20)
      expect(ruled.recommendedQty).toBeGreaterThan(base.recommendedQty)
      expect(ruled.calcStepsJson.appliedOverride).toMatchObject([{ id: made.id, scopeId: 'SKU-A', value: 20, applied: true }])
      expect(JSON.stringify(ruled.calcStepsJson.steps[0])).toContain('人工预测规则')
      const listed = (await call(owner, 'GET', `/replenishment/recommendations?batchId=${withRule}`)).json.data.items[0]
      expect(listed.appliedOverride[0]).toMatchObject({ id: made.id, applied: true })
      expect(listed.suggestedShipDate).toBeTruthy()
      expect(typeof listed.shipInDays).toBe('number')

      // 修改、删除规则后，已生成的批次完全不变
      expect((await call(owner, 'PUT', `${ROUTE}/${made.id}`, { version: made.version, value: 40 })).status).toBe(200)
      expect(await frozen(withRule)).toEqual(ruled)
      expect((await call(owner, 'DELETE', `${ROUTE}/${made.id}`)).status).toBe(200)
      expect(await frozen(withRule)).toEqual(ruled)
      expect(await frozen(plain)).toEqual(base)
      const after = (await call(owner, 'GET', `/replenishment/recommendations?batchId=${withRule}`)).json.data.items[0]
      expect(after.appliedOverride[0]).toMatchObject({ id: made.id, value: 20 })

      // 规则删除后再重算，回到模型预测
      const back = await frozen(await recompute())
      expect(back.calcStepsJson.dailyDemand).toBe(10)
      expect(back.recommendedQty).toBe(base.recommendedQty)
    })

    it('SKU 规则优先于品类规则；同一天只用一条', async () => {
      const category = await created({ scopeType: 'CATEGORY', scopeId: '耳机', value: 30, to: dayOffset(200) })
      const onlyCategory = await frozen(await recompute())
      expect(onlyCategory.calcStepsJson.dailyDemand).toBe(30)
      const sku = await created({ value: 5, to: dayOffset(200) })
      const both = await frozen(await recompute())
      expect(both.calcStepsJson.dailyDemand).toBe(5)
      const applied = both.calcStepsJson.appliedOverride as Array<{ id: string; applied: boolean }>
      expect(applied.find(item => item.id === sku.id)?.applied).toBe(true)
      expect(applied.find(item => item.id === category.id)?.applied).toBe(false)
      await clearRules()
    })

    it('去年同期：取去年同一段日期的日均销量 × 系数；去年没有记录的规则不生效（不当 0）', async () => {
      const withData = await created({ mode: 'YOY_FACTOR', value: 2, from: dayOffset(1), to: dayOffset(10) })
      const one = await frozen(await recompute())
      expect(one.calcStepsJson.appliedOverride).toMatchObject([{ id: withData.id, rate: 12, days: 10, applied: true }])
      await clearRules()

      const noData = await created({ mode: 'YOY_FACTOR', value: 2, from: dayOffset(20), to: dayOffset(30) })
      const two = await frozen(await recompute())
      expect(two.calcStepsJson.dailyDemand).toBe(10)
      expect(two.calcStepsJson.appliedOverride).toMatchObject([{ id: noData.id, rate: null, applied: false }])
      expect(two.calcStepsJson.appliedOverride[0].note).toContain('去年同期')
      await clearRules()
    })

    it('列表筛选：本周需发货与已逾期按建议发货日（没有发货日取下单日）', async () => {
      const batch = await recompute()
      const all = (await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}`)).json.data
      expect(all.items).toHaveLength(1)
      const shipInDays = all.items[0].shipInDays as number
      const week = (await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&due=WEEK`)).json.data.total
      const overdue = (await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&due=OVERDUE`)).json.data.total
      expect(week).toBe(shipInDays >= 0 && shipInDays <= 6 ? 1 : 0)
      expect(overdue).toBe(shipInDays < 0 ? 1 : 0)
      expect((await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&due=NOPE`)).status).toBe(422)
      expect((await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&sort=shipDate`)).status).toBe(200)
      // 把这条建议的发货日改到 3 天前：已逾期；改到明天：本周
      await h.client.query(`UPDATE "ReplenishmentRecommendation" SET "shipDate" = $2 WHERE "batchId" = $1`, [batch, dayOffset(-3)])
      expect((await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&due=OVERDUE`)).json.data.total).toBe(1)
      expect((await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&due=WEEK`)).json.data.total).toBe(0)
      await h.client.query(`UPDATE "ReplenishmentRecommendation" SET "shipDate" = $2 WHERE "batchId" = $1`, [batch, dayOffset(1)])
      expect((await call(owner, 'GET', `/replenishment/recommendations?batchId=${batch}&due=WEEK`)).json.data.total).toBe(1)
    })

    it('“计入必断货量”是策略的一部分：默认关闭；开关随策略版本保存', async () => {
      const policies = (await call(owner, 'GET', '/replenishment/policies')).json.data
      expect(policies.tenantCurrent.includeUnavoidableShortage).toBe(true)
      const saved = await call(owner, 'PUT', '/replenishment/policies', {
        ...POLICY,
        expectedVersionNo: policies.tenantCurrent.versionNo,
        includeUnavoidableShortage: false,
        changeReason: '关闭必断货量',
      })
      expect(saved.status, JSON.stringify(saved.json)).toBe(200)
      expect(saved.json.data).toMatchObject({ versionNo: 2, includeUnavoidableShortage: false })
      const off = await frozen(await recompute())
      expect(off.calcStepsJson.unavoidableIncluded).toBe(false)
      expect(off.calcStepsJson.unavoidableShortage).toBeGreaterThan(0)
    })
  })

  it('迁移：旧策略升级后开关默认关闭；回滚删表删列；再升级闭环成功', async () => {
    await h.db.createDatabase('forecast_override_mig')
    const client = await h.db.connect('forecast_override_mig')
    try {
      await applyMigrations(client, { before: TARGET })
      const ids = await seedTenant(client, 'mig')
      await insertRow(client, 'ReplenishmentPolicy', {
        id: 'pol-old',
        tenantId: ids.tenantId,
        level: 'TENANT',
        levelRef: 'ALL',
        versionNo: 1,
        leadTimeDays: 30,
        safetyDays: 7,
        coverageDays: 60,
        redundancyMultiplier: 1.5,
        agingFromDays: 181,
      })
      await applyMigrations(client, { only: TARGET })
      expect((await client.query(`SELECT "includeUnavoidableShortage" AS v FROM "ReplenishmentPolicy" WHERE id = 'pol-old'`)).rows[0]).toEqual({ v: false })
      await client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
      expect((await client.query(`SELECT to_regclass('"ForecastOverride"') IS NOT NULL AS found`)).rows[0].found).toBe(false)
      expect((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ReplenishmentPolicy' AND column_name = 'includeUnavoidableShortage'`)).rows[0].n).toBe(
        0,
      )
      await applyMigrations(client, { only: TARGET })
      expect((await client.query(`SELECT to_regclass('"ForecastOverride"') IS NOT NULL AS found`)).rows[0].found).toBe(true)
    } finally {
      await client.end()
    }
  })
})
