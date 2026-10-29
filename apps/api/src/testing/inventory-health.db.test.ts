import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 库存健康与库存详情（P2a-06，真实数据库）：规则版本只增不改与乐观冲突、行级安全、
// 风险等级由规则版本与订单销量在库里算出、详情的结构趋势与范围隔离、迁移升级与回滚。

type Ids = Awaited<ReturnType<DbTestApp['createTenant']>>
type Member = { userId: string; token: string }

const TARGET = '20261022170000_replenishment_policy'
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

const rule = (over: Record<string, unknown> = {}) => ({
  expectedVersionNo: 0,
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED', 'RECEIVING'],
  agingFromDays: 271,
  changeReason: '首次设置',
  ...over,
})

describe('库存健康（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let a: Ids
  let b: Ids
  let owner: Member
  let viewer: Member
  let ownerB: Member
  let seq = 0

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const get = async (member: Member, path: string) => {
    const res = await call(member, 'GET', path)
    expect(res.status, `${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'inventory_health', db })
    a = await h.createTenant('iha')
    b = await h.createTenant('ihb')
    owner = await h.createMember(a.tenantId, 'ih-owner', ['*'])
    viewer = await h.createMember(a.tenantId, 'ih-viewer', ['inventory.read'])
    ownerB = await h.createMember(b.tenantId, 'ih-owner-b', ['*'])
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" IN ($1, $2)`, [a.tenantId, b.tenantId])

    // 租户 A：可售 100、在途 30（处理中 10 + 已发货 20）；近 90 天每天卖 10 件
    await insertRow(h.client, 'FbaInventoryRecord', {
      id: 'fir-a',
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      marketplaceId: 'ATVPDKIKX0DER',
      sellerSku: 'SKU-A',
      asin: 'B0AAAAAAAA',
      fnsku: 'X0AAAAAAAA',
      fulfillableQuantity: 100,
      inboundWorkingQuantity: 10,
      inboundShippedQuantity: 20,
    })
    for (let day = 1; day <= 95; day += 1) {
      await insertRow(h.client, 'AsinDailySummary', {
        id: `ads-a-${day}`,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        summaryDate: dayOffset(-day),
        asin: 'B0AAAAAAAA',
        units: 10,
        metricVersion: 'p2a-01@1',
      })
    }
    // 租户 B：另一条库存与另一份规则，A 的任何接口都不能看到
    await insertRow(h.client, 'FbaInventoryRecord', {
      id: 'fir-b',
      tenantId: b.tenantId,
      sellerAccountId: b.sellerAccountId,
      marketplaceId: 'ATVPDKIKX0DER',
      sellerSku: 'SKU-B',
      asin: 'B0BBBBBBBB',
      fulfillableQuantity: 7,
    })
    // 库存日快照：同一天接口与亚马逊报告两个来源
    for (const [source, sellable] of [
      ['API', 90],
      ['AFN', 85],
    ] as const) {
      await insertRow(h.client, 'InventoryDailySnapshot', {
        id: `ids-${source}-${++seq}`,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        snapshotDate: dayOffset(-1),
        sku: 'SKU-A',
        fnsku: 'X0AAAAAAAA',
        sellable,
        source,
        sourceUpdatedAt: new Date().toISOString(),
      })
    }
  })

  afterAll(async () => {
    await h?.close()
    await db?.stop()
  })

  it('没有规则时：列表有库存但不判定风险；汇总的低库存卡片是“未接入”', async () => {
    const list = await get(owner, '/inventory')
    expect(list).toMatchObject({ total: 1, policyState: 'NOT_CONNECTED' })
    expect(list.items[0]).toMatchObject({ sku: 'SKU-A', assessment: { state: 'NOT_CONNECTED', risk: null } })
    expect(list.items[0].demand).toMatchObject({ source: 'ORDERS', mid: 10 })
    const summary = await get(owner, '/inventory/summary')
    expect(summary.cards.lowSkuCount).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(summary.cards.sellableTotal.value).toBe(100)
    expect((await get(owner, '/inventory/rules')).state).toBe('NOT_CONNECTED')
  })

  it('保存规则：版本 1 生效，风险由规则版本与订单销量算出；审计与时间线同事务写入', async () => {
    const saved = await call(owner, 'PUT', '/inventory/rules', rule())
    expect(saved.status, JSON.stringify(saved.json)).toBe(200)
    expect(saved.json.data).toMatchObject({ state: 'OK', current: { versionNo: 1, coverageDays: 60, inboundCounted: ['WORKING', 'SHIPPED', 'RECEIVING'] } })
    // 可售 100 + 计入在途 30 = 130，日销 10 → 可售天数 13 < 提前期 30
    const list = await get(owner, '/inventory')
    expect(list.items[0].assessment).toMatchObject({ risk: 'HIGH', daysOfCover: 13, policyVersion: 1 })
    expect((await get(owner, '/inventory?tab=low')).total).toBe(1)
    expect((await get(owner, '/inventory?tab=excess')).total).toBe(0)
    const audit = await h.client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = 'REPLENISHMENT_POLICY_VERSIONED'`, [a.tenantId])
    expect(audit.rows[0].n).toBe(1)
    const events = await h.client.query(`SELECT "entityId", "kind" FROM "EntityEvent" WHERE "tenantId" = $1 AND "entityType" = 'REPLENISHMENT_POLICY'`, [a.tenantId])
    expect(events.rows).toEqual([{ entityId: 'TENANT:ALL', kind: 'rule' }])
  })

  it('改规则只增版本：旧版本不变；提交的版本号落后返回 409；未来生效的版本不影响当前', async () => {
    const stale = await call(owner, 'PUT', '/inventory/rules', rule({ expectedVersionNo: 0, coverageDays: 90 }))
    expect(stale.status).toBe(409)
    const v2 = await call(owner, 'PUT', '/inventory/rules', rule({ expectedVersionNo: 1, leadTimeDays: 5, changeReason: '缩短提前期' }))
    expect(v2.status, JSON.stringify(v2.json)).toBe(200)
    expect(v2.json.data.current).toMatchObject({ versionNo: 2, leadTimeDays: 5 })
    expect(v2.json.data.history.map((item: { versionNo: number }) => item.versionNo)).toEqual([2, 1])
    const v1 = await h.client.query(`SELECT "leadTimeDays", "changeReason" FROM "ReplenishmentPolicy" WHERE "tenantId" = $1 AND "versionNo" = 1`, [a.tenantId])
    expect(v1.rows[0]).toEqual({ leadTimeDays: 30, changeReason: '首次设置' })
    // 提前期 5 天：覆盖 13 天 ≥ 5，但 < 5 + 安全库存 14 → 中风险
    expect((await get(owner, '/inventory')).items[0].assessment).toMatchObject({ risk: 'MEDIUM', policyVersion: 2 })
    const future = await call(owner, 'PUT', '/inventory/rules', rule({ expectedVersionNo: 2, leadTimeDays: 100, coverageDays: 300, effectiveFrom: dayOffset(10), changeReason: '十天后换季' }))
    expect(future.status, JSON.stringify(future.json)).toBe(200)
    expect(future.json.data.current.versionNo).toBe(2)
    expect(future.json.data.history[0]).toMatchObject({ versionNo: 3, effectiveFrom: dayOffset(10) })
    expect((await get(owner, '/inventory')).items[0].assessment.policyVersion).toBe(2)
    expect((await call(owner, 'PUT', '/inventory/rules', rule({ expectedVersionNo: 3, effectiveFrom: dayOffset(-1) }))).status).toBe(422)
  })

  it('权限：只有 inventory.read 的成员能看列表与规则，不能保存规则', async () => {
    expect((await get(viewer, '/inventory')).total).toBe(1)
    expect((await get(viewer, '/inventory/rules')).current.versionNo).toBe(2)
    expect((await call(viewer, 'PUT', '/inventory/rules', rule({ expectedVersionNo: 3 }))).status).toBe(403)
  })

  it('租户隔离：B 看不到 A 的库存与规则，A 的编号在 B 下 404；B 保存的规则从 1 开始', async () => {
    const listB = await get(ownerB, '/inventory')
    expect(listB.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-B'])
    expect(listB.policyState).toBe('NOT_CONNECTED')
    expect((await call(ownerB, 'GET', '/inventory/fir-a')).status).toBe(404)
    expect((await call(owner, 'GET', '/inventory/fir-b')).status).toBe(404)
    const saved = await call(ownerB, 'PUT', '/inventory/rules', rule())
    expect(saved.json.data.current.versionNo).toBe(1)
    expect((await get(owner, '/inventory/rules')).history).toHaveLength(3)
  })

  it('库存详情：概览带建议卡与规则版本；结构趋势同一天只取优先级最高的来源；其余页签按范围读取', async () => {
    const detail = await get(owner, '/inventory/fir-a')
    expect(detail.row).toMatchObject({ sku: 'SKU-A', assessment: { risk: 'MEDIUM' } })
    expect(detail.suggestions[0]).toMatchObject({ id: 'replenish' })
    const structure = await get(owner, '/inventory/fir-a/structure')
    expect(structure.points).toEqual([{ date: dayOffset(-1), source: 'API', sellable: 90, inbound: null, reserved: null, unsellable: null, researching: null }])
    const snapshots = await get(owner, `/inventory/fir-a/snapshots?a=${dayOffset(-1)}&b=${dayOffset(-2)}`)
    expect(snapshots.availableDates).toEqual([dayOffset(-1)])
    expect(snapshots.a).toMatchObject({ found: true, values: { sellable: 90, source: 'API' } })
    expect(snapshots.b).toMatchObject({ found: false })
    expect((await get(owner, '/inventory/fir-a/ledger')).state).toBe('NO_DATA')
    expect((await get(owner, '/inventory/fir-a/inbound')).counts).toMatchObject({ working: 10, shipped: 20, total: 30 })
    expect((await get(owner, '/inventory/fir-a/awd')).state).toBe('NOT_CONNECTED')
    // 补货页签由补货模块计算（P2a-07）：这条库存规则是 P2a-06 的旧版，没有服务水平与提前期拆分，如实返回“策略不完整”而不是套默认值
    expect((await get(owner, '/inventory/fir-a/replenishment')).ours).toMatchObject({ state: 'POLICY_INCOMPLETE' })
    expect((await get(owner, '/inventory/fir-a/age-fees')).state).toBe('NO_DATA')
    expect((await get(owner, '/inventory/fir-a/disposition')).amazon.state).toBe('NO_DATA')
    const forecast = await get(owner, '/inventory/fir-a/forecast')
    expect(forecast).toMatchObject({ state: 'OK', source: 'ORDERS' })
    expect(forecast.forecast).toHaveLength(30)
    expect(forecast.history.length).toBeGreaterThan(80)
  })
})

describe('规则表迁移与约束（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  it('升级建表并带 RLS；约束拒绝非法取值与重复版本；回滚后表消失，再升级闭环成功', async () => {
    await db.createDatabase('rp_migration')
    const client = await db.connect('rp_migration')
    try {
      await applyMigrations(client, { before: TARGET })
      const { rows: before } = await client.query(`SELECT to_regclass('"ReplenishmentPolicy"') IS NOT NULL AS found`)
      expect(before[0].found).toBe(false)
      await applyMigrations(client, { only: TARGET })
      const { rows: rls } = await client.query(`SELECT relrowsecurity AS forced FROM pg_class WHERE relname = 'ReplenishmentPolicy'`)
      expect(rls[0].forced).toBe(true)

      await insertRow(client, 'Tenant', { id: 't-rp', slug: 't-rp', name: '租户' })
      const base = { tenantId: 't-rp', versionNo: 1, leadTimeDays: 30, safetyDays: 14, coverageDays: 60, redundancyMultiplier: 1.5, effectiveFrom: '2026-10-01', changeReason: '测试', createdBy: 'u1' }
      const ok = await insertRow(client, 'ReplenishmentPolicy', { id: 'rp-1', ...base })
      expect(ok).toMatchObject({ level: 'TENANT', levelRef: 'ALL', agingFromDays: 271 })
      await expect(insertRow(client, 'ReplenishmentPolicy', { id: 'rp-dup', ...base })).rejects.toThrow()
      await expect(insertRow(client, 'ReplenishmentPolicy', { id: 'rp-bad1', ...base, versionNo: 2, coverageDays: 0 })).rejects.toThrow()
      await expect(insertRow(client, 'ReplenishmentPolicy', { id: 'rp-bad2', ...base, versionNo: 3, level: 'GLOBAL' })).rejects.toThrow()
      await expect(insertRow(client, 'ReplenishmentPolicy', { id: 'rp-bad3', ...base, versionNo: 4, agingFromDays: 200 })).rejects.toThrow()
      await expect(insertRow(client, 'ReplenishmentPolicy', { id: 'rp-bad4', ...base, versionNo: 5, inboundCounted: ['UNKNOWN'] })).rejects.toThrow()
      await expect(insertRow(client, 'ReplenishmentPolicy', { id: 'rp-bad5', ...base, versionNo: 0 })).rejects.toThrow()

      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      const { rows: gone } = await client.query(`SELECT to_regclass('"ReplenishmentPolicy"') IS NOT NULL AS found`)
      expect(gone[0].found).toBe(false)
      await applyMigrations(client, { only: TARGET })
      const { rows: again } = await client.query(`SELECT count(*)::int AS n FROM "ReplenishmentPolicy"`)
      expect(again[0].n).toBe(0)
    } finally {
      await client.end()
    }
  })
})
