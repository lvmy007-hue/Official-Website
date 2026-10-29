import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 期间关账（P2b-13，真实数据库 + 完整应用）：
// 迁移升级（两张表、约束、行级隔离）与回滚闭环；
// 创建 → 完整性检查 → 审批（不能自己审批）→ 再次验证身份后锁定（快照、汇率锁定）→ 重新开账（解锁、差异报告）→ 再次锁定（修订 2 与差异）；
// 汇率是企业级的：另一个店铺的已关账期间重叠时，重新开账不能把它的汇率放开；跨企业与数据范围隔离。

type Member = { userId: string; token: string }
const TARGET = '20261106010000_period_close'

describe('期间关账迁移（P2b-13）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('period_migrate')
    client = await db.connect('period_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0] as { found: boolean }).found

  it('升级建两张表（行级隔离）；约束拒绝非法取值与重复；回滚闭环可再升级', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-pc', slug: 't-pc', name: '租户' })
    const legal = await insertRow(client, 'LegalEntity', { id: 'le-pc', tenantId: tenant.id })
    const seller = await insertRow(client, 'SellerAccount', { id: 's-pc', tenantId: tenant.id, legalEntityId: legal.id })
    expect(await exists('AccountingPeriod')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of ['AccountingPeriod', 'PeriodSnapshot']) {
      expect(await exists(table)).toBe(true)
      expect((await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [table])).rows[0]).toEqual({ relrowsecurity: true })
      expect((await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND qual LIKE '%nova_current_tenant%'`, [table])).rowCount).toBe(1)
    }

    const base = { tenantId: tenant.id, sellerAccountId: seller.id, createdBy: 'u' }
    const period = (id: string, over: Record<string, unknown> = {}) => insertRow(client, 'AccountingPeriod', { id, ...base, periodStart: '2025-03-01', periodEnd: '2025-03-31', ...over })
    expect(await period('p-1')).toMatchObject({ status: 'OPEN', version: 1, closeCount: 0, checklistJson: {} })
    await expect(period('p-dup')).rejects.toMatchObject({ code: '23505' })
    await expect(period('p-status', { periodStart: '2025-04-01', periodEnd: '2025-04-30', status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(period('p-range', { periodStart: '2025-05-31', periodEnd: '2025-05-01' })).rejects.toMatchObject({ code: '23514' })
    await expect(period('p-ver', { periodStart: '2025-06-01', periodEnd: '2025-06-30', version: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(period('p-dec', { periodStart: '2025-07-01', periodEnd: '2025-07-31', approvalDecision: 'MAYBE' })).rejects.toMatchObject({ code: '23514' })
    await expect(period('p-fk', { sellerAccountId: 'no-such', periodStart: '2025-08-01', periodEnd: '2025-08-31' })).rejects.toMatchObject({ code: '23503' })

    const snap = (id: string, revision: number) =>
      insertRow(client, 'PeriodSnapshot', { id, tenantId: tenant.id, periodId: 'p-1', revision, profitSnapshotJson: '{}', fxSnapshotJson: '{}', costVersionSnapshotJson: '{}', lockedBy: 'u' })
    expect(await snap('sn-1', 1)).toMatchObject({ revision: 1, diffJson: null })
    await expect(snap('sn-dup', 1)).rejects.toMatchObject({ code: '23505' })
    await expect(snap('sn-zero', 0)).rejects.toMatchObject({ code: '23514' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists('AccountingPeriod')).toBe(false)
    expect(await exists('PeriodSnapshot')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists('AccountingPeriod')).toBe(true)
  })
})

describe('期间关账（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let secondSellerId: string
  let closer: Member
  let approver: Member
  let admin: Member
  let scoped: Member
  let other: Member
  let periodId: string

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const post = (member: Member, path: string, body: Record<string, unknown> = {}) => h.call(member.token, 'POST', path, { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const stepUp = (member: Member, action: string) =>
    insertRow(h.client, 'StepUpVerification', {
      id: `su-${Math.random().toString(36).slice(2)}`,
      tenantId,
      userId: member.userId,
      action,
      method: 'PASSWORD',
      expiresAt: new Date(Date.now() + 600_000),
    })
  const detail = async (member: Member = closer) => {
    const res = await get(member, `/finance/periods/${periodId}`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data
  }
  const version = async () => (await rows<{ version: number }>(`SELECT version FROM "AccountingPeriod" WHERE id = $1`, [periodId]))[0]!.version
  const lockedCount = async (by: string) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FxRate" WHERE "tenantId" = $1 AND "lockedByPeriodId" = $2`, [tenantId, by]))[0]!.n
  const checkAndClose = async () => {
    const checked = await post(closer, `/finance/periods/${periodId}/check`)
    expect(checked.json.data, JSON.stringify(checked.json)).toMatchObject({ passed: true, status: 'CLOSING' })
    // P6-27：检查通过时登记到审批收件箱（审批人是另一位有关账权限的成员），审批后回写
    const request = () =>
      rows<{ status: string; approverIds: string[]; requesterId: string }>(
        `SELECT status, "approverIds", "requesterId" FROM "ApprovalRequest" WHERE "tenantId" = $1 AND type = 'PERIOD_CLOSE' AND "objectId" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
        [tenantId, periodId],
      )
    expect(await request()).toEqual([{ status: 'PENDING', approverIds: expect.arrayContaining([approver.userId]), requesterId: closer.userId }])
    const approved = await post(approver, `/finance/periods/${periodId}/approve`, { version: await version(), decision: 'APPROVED', comment: '核对无误' })
    expect(approved.status, JSON.stringify(approved.json)).toBe(201)
    expect(await request()).toMatchObject([{ status: 'APPROVED' }])
    await stepUp(closer, 'finance.period.close')
    return post(closer, `/finance/periods/${periodId}/close`, { version: await version() })
  }

  const profit = (id: string, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'ProfitDaily', {
      id,
      tenantId,
      sellerAccountId: sellerId,
      profitDate: '2025-03-10',
      sku: 'SKU-A',
      asin: 'B0A',
      basis: 'ORDERED',
      costing: 'FIFO',
      units: 10,
      costedUnits: 10,
      revenue: 1000,
      productCost: 300,
      profit: 400,
      metricVersion: 'profit-v1',
      ...over,
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'periods', db })
    const a = await h.createTenant('pc-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-pc-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-PC-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('pc-b')
    const perms = ['finance.read', 'finance.period.close', 'field.profit', 'field.cost']
    closer = await h.createMember(tenantId, 'pc-close', perms)
    approver = await h.createMember(tenantId, 'pc-approve', perms)
    admin = await h.createMember(tenantId, 'pc-admin', ['*'])
    scoped = await h.createMember(tenantId, 'pc-scoped', perms, { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(b.tenantId, 'pc-other', ['*'])

    // 种子：2025 年 3 月的美国主店——同步完整、结算已到、成本覆盖、汇率齐全、广告已分摊、没有对账异常
    for (const sourceKey of ['orders.api', 'finance.transactions']) {
      await insertRow(h.client, 'DataFreshness', {
        id: `df-${sourceKey}`,
        tenantId,
        sellerAccountId: sellerId,
        sourceKey,
        lastAttemptAt: '2025-04-05T00:00:00Z',
        lastSuccessAt: '2025-04-05T00:00:00Z',
        dataThrough: '2025-04-05T00:00:00Z',
        status: 'NORMAL',
      })
    }
    await insertRow(h.client, 'FbaSettlement', {
      id: 'st-pc',
      tenantId,
      sellerAccountId: sellerId,
      externalSettlementId: 'ST-PC',
      settlementStartDate: '2025-03-19T00:00:00Z',
      settlementEndDate: '2025-04-02T00:00:00Z',
      txnCount: 10,
      sourceUpdatedAt: '2025-04-03T00:00:00Z',
    })
    for (const basis of ['ORDERED', 'SHIPPED', 'SETTLED']) {
      await profit(`pd-a-${basis}`, { basis, costCurrency: 'CNY', ...(basis === 'ORDERED' ? { adsSpendAllocated: 5 } : {}) })
      await profit(`pd-b-${basis}`, { basis, sku: 'SKU-B', asin: 'B0B', units: 5, costedUnits: 5, revenue: 200, productCost: 60, profit: 50 })
      await profit(`pd-s-${basis}`, { basis, sku: '__STORE__', asin: null, units: 0, costedUnits: 0, revenue: 0, productCost: null, feeStorage: 20, profit: -20, adsUnallocated: 0 })
    }
    for (let day = 1; day <= 31; day += 1) {
      const date = `2025-03-${String(day).padStart(2, '0')}`
      await insertRow(h.client, 'FxRate', { id: `fx-${date}`, tenantId, quoteCurrency: 'CNY', rateDate: date, rate: 7.1, source: 'ECB' })
    }
    await insertRow(h.client, 'FxRate', { id: 'fx-2025-04-02', tenantId, quoteCurrency: 'CNY', rateDate: '2025-04-02', rate: 7.2, source: 'ECB' })
    for (const [id, versionNo, from, cost] of [
      ['cv-1', 1, '2025-01-01', 20],
      ['cv-2', 2, '2025-03-15', 22],
      ['cv-3', 3, '2025-05-01', 25],
    ] as const) {
      await insertRow(h.client, 'CostVersion', { id, tenantId, sku: 'SKU-A', versionNo, effectiveFrom: from, currency: 'CNY', unitProductCost: cost, source: 'MANUAL', status: 'ACTIVE' })
    }
  })
  afterAll(async () => {
    await h?.close()
  })

  it('创建期间：一个店铺一个月份；重复 409；还没结束 422；数据范围外 403；没有权限 403', async () => {
    const created = await post(closer, '/finance/periods', { sellerAccountId: sellerId, month: '2025-03' })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    periodId = created.json.data.id
    expect(await rows(`SELECT "periodStart"::text AS s, "periodEnd"::text AS e, status, "createdBy" FROM "AccountingPeriod" WHERE id = $1`, [periodId])).toEqual([
      { s: '2025-03-01', e: '2025-03-31', status: 'OPEN', createdBy: closer.userId },
    ])
    expect((await post(closer, '/finance/periods', { sellerAccountId: sellerId, month: '2025-03' })).status).toBe(409)
    expect((await post(closer, '/finance/periods', { sellerAccountId: sellerId, month: new Date().toISOString().slice(0, 7) })).status).toBe(422)
    expect((await post(scoped, '/finance/periods', { sellerAccountId: sellerId, month: '2025-02' })).status).toBe(403)
    const reader = await h.createMember(tenantId, 'pc-reader', ['finance.read'])
    expect((await post(reader, '/finance/periods', { sellerAccountId: sellerId, month: '2025-02' })).status).toBe(403)
    const list = await get(closer, '/finance/periods')
    expect(list.json.data).toMatchObject({ total: 1, canCreate: true, summary: { OPEN: 1 } })
    expect(list.json.data.stores.map((item: { id: string }) => item.id).sort()).toEqual([sellerId, secondSellerId].sort())
  })

  it('完整性检查：六项真实数据全部通过，进入关账中；实时预览按口径给出销售额与净利润', async () => {
    const res = await post(closer, `/finance/periods/${periodId}/check`)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ passed: true, status: 'CLOSING' })
    expect(res.json.data.checklist.items.map((item: { key: string; state: string }) => [item.key, item.state])).toEqual([
      ['SYNC_COMPLETE', 'PASS'],
      ['SETTLEMENTS_ARRIVED', 'PASS'],
      ['COST_COVERAGE', 'PASS'],
      ['FX_COMPLETE', 'PASS'],
      ['ADS_ALLOCATED', 'PASS'],
      ['RECON_EXCEPTIONS', 'PASS'],
    ])
    const data = await detail()
    expect(data.period).toMatchObject({ status: 'CLOSING', checkedBy: expect.any(String) })
    expect(data.preview).toMatchObject({ state: 'OK', source: 'LIVE' })
    const ordered = data.preview.bases.find((item: { basis: string }) => item.basis === 'ORDERED')
    expect(ordered).toMatchObject({ units: 15, costedUnits: 15, rows: 3, netProfit: 430 })
    expect(ordered.items.find((item: { key: string }) => item.key === 'REVENUE').value).toBe(1200)
    expect(data.actions.approve).toMatchObject({ allowed: false })
    expect(data.actions.approve.reason).toContain('不能审批')
  })

  it('审批：发起检查的人不能审批；另一位有权限的成员可以；没有再次验证不能锁定', async () => {
    const own = await post(closer, `/finance/periods/${periodId}/approve`, { version: await version(), decision: 'APPROVED' })
    expect(own.status).toBe(409)
    const done = await post(approver, `/finance/periods/${periodId}/approve`, { version: await version(), decision: 'APPROVED', comment: '核对无误' })
    expect(done.status, JSON.stringify(done.json)).toBe(201)
    const row = (await rows<{ approvalDecision: string; approvedBy: string; status: string }>(`SELECT "approvalDecision", "approvedBy", status FROM "AccountingPeriod" WHERE id = $1`, [periodId]))[0]!
    expect(row).toEqual({ approvalDecision: 'APPROVED', approvedBy: approver.userId, status: 'CLOSING' })
    const noStepUp = await post(closer, `/finance/periods/${periodId}/close`, { version: await version() })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(await rows(`SELECT 1 FROM "PeriodSnapshot"`)).toHaveLength(0)
  })

  it('锁定：写入修订 1 快照（利润、汇率、成本版本），期间内的汇率被锁定且数据库拒绝修改，期间外不受影响', async () => {
    await stepUp(closer, 'finance.period.close')
    const res = await post(closer, `/finance/periods/${periodId}/close`, { version: await version() })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ status: 'CLOSED', revision: 1, fxLocked: 31 })
    const [snapshot] = await rows<{ revision: number; profit: any; fx: any; costs: any; diff: unknown; lockedBy: string }>(
      `SELECT revision, "profitSnapshotJson" AS profit, "fxSnapshotJson" AS fx, "costVersionSnapshotJson" AS costs, "diffJson" AS diff, "lockedBy" FROM "PeriodSnapshot" WHERE "periodId" = $1`,
      [periodId],
    )
    expect(snapshot).toMatchObject({ revision: 1, diff: null, lockedBy: closer.userId })
    expect(snapshot!.profit.bases.ORDERED.totals).toMatchObject({ revenue: 1200, profit: 430, rows: 3, incompleteRows: 0, units: 15 })
    expect(snapshot!.profit.bases.ORDERED.skus.map((item: { sku: string; revenue: number }) => [item.sku, item.revenue])).toEqual([
      ['SKU-A', 1000],
      ['SKU-B', 200],
    ])
    expect(snapshot!.fx.rates).toHaveLength(31)
    // 成本版本：3 月 1 日起仍有效的版本 1、3 月 15 日生效的版本 2；5 月才生效的版本 3 不在期间内
    expect(snapshot!.costs.versions.map((item: { versionNo: number }) => item.versionNo)).toEqual([1, 2])
    expect(await lockedCount(periodId)).toBe(31)
    expect(await rows(`SELECT 1 FROM "FxRate" WHERE id = 'fx-2025-04-02' AND "lockedByPeriodId" IS NULL`)).toHaveLength(1)
    await expect(h.client.query(`UPDATE "FxRate" SET rate = 9 WHERE id = 'fx-2025-03-10'`)).rejects.toMatchObject({ code: '23514' })
    await expect(h.client.query(`DELETE FROM "FxRate" WHERE id = 'fx-2025-03-10'`)).rejects.toMatchObject({ code: '23514' })
    const actions = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND "resourceId" = $2 ORDER BY "createdAt"`, [tenantId, periodId])
    expect(actions.map(item => item.action)).toEqual(expect.arrayContaining(['PERIOD_CREATED', 'PERIOD_CHECKED', 'PERIOD_APPROVED', 'PERIOD_CLOSED']))
    const data = await detail()
    expect(data).toMatchObject({ period: { status: 'CLOSED', closeCount: 1 }, preview: { source: 'SNAPSHOT', costVersions: 2, fx: { rates: 31 } }, diff: null })
    expect(data.snapshots).toMatchObject([{ revision: 1, fxRates: 31, costVersions: 2, hasDiff: false }])
  })

  it('已关账：不能再检查；成员没有重新开账权限不能重新开账；锁定后改利润日表不影响已锁定的预览', async () => {
    expect((await post(closer, `/finance/periods/${periodId}/check`)).status).toBe(409)
    expect((await post(closer, `/finance/periods/${periodId}/reopen`, { version: await version(), reason: '补录费用' })).status).toBe(403)
    await h.client.query(`UPDATE "ProfitDaily" SET revenue = 1300 WHERE id = 'pd-a-ORDERED'`)
    const ordered = (await detail()).preview.bases.find((item: { basis: string }) => item.basis === 'ORDERED')
    expect(ordered.items.find((item: { key: string }) => item.key === 'REVENUE').value).toBe(1200)
  })

  it('另一个店铺同月已关账时，重新开账解除本期间的汇率锁定后，把重叠期间的汇率锁回去；差异报告实时对比上一份快照', async () => {
    const second = await insertRow(h.client, 'AccountingPeriod', {
      id: 'period-pc-2',
      tenantId,
      sellerAccountId: secondSellerId,
      periodStart: '2025-03-01',
      periodEnd: '2025-03-31',
      status: 'CLOSED',
      closeCount: 1,
      createdBy: 'u',
    })
    await stepUp(admin, 'finance.period.reopen')
    const reason = '补录一笔漏掉的仓储费'
    const res = await post(admin, `/finance/periods/${periodId}/reopen`, { version: await version(), reason })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ status: 'REOPENED' })
    expect(await lockedCount(periodId)).toBe(0)
    expect(await lockedCount(second.id)).toBe(31)
    const row = (
      await rows<{ reopenReason: string; reopenedBy: string; checkedBy: string | null; checklistJson: unknown }>(
        `SELECT "reopenReason", "reopenedBy", "checkedBy", "checklistJson" FROM "AccountingPeriod" WHERE id = $1`,
        [periodId],
      )
    )[0]!
    expect(row).toEqual({ reopenReason: reason, reopenedBy: admin.userId, checkedBy: null, checklistJson: {} })
    expect(
      (await rows<{ detail: any; reason: string }>(`SELECT detail, reason FROM "AuditEvent" WHERE "resourceId" = $1 AND action = 'PERIOD_REOPENED' AND "result" = 'SUCCEEDED'`, [periodId]))[0],
    ).toMatchObject({
      reason,
      detail: { fxUnlocked: 31, fxRelocked: 31 },
    })

    const data = await detail()
    expect(data.diff).toMatchObject({ against: 'LIVE', baseRevision: 1, hasChanges: true })
    const ordered = data.diff.bases.find((item: { basis: string }) => item.basis === 'ORDERED')
    expect(ordered.items.find((item: { key: string }) => item.key === 'REVENUE')).toMatchObject({ before: 1200, after: 1500, delta: 300 })
    expect(ordered.skus[0]).toMatchObject({ sku: 'SKU-A', kind: 'CHANGED' })
    expect(data.actions.check.allowed).toBe(true)
  })

  it('重新开账后再次锁定：修订 2，与上一份快照的差异随快照保存；汇率仍被另一个店铺的关账锁着', async () => {
    const res = await checkAndClose()
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ status: 'CLOSED', revision: 2, fxLocked: 0 })
    const snapshots = await rows<{ revision: number; diff: any }>(`SELECT revision, "diffJson" AS diff FROM "PeriodSnapshot" WHERE "periodId" = $1 ORDER BY revision`, [periodId])
    expect(snapshots.map(item => item.revision)).toEqual([1, 2])
    expect(snapshots[0]!.diff).toBeNull()
    expect(snapshots[1]!.diff.hasChanges).toBe(true)
    expect(snapshots[1]!.diff.bases[0].items.find((item: { key: string }) => item.key === 'REVENUE')).toMatchObject({ before: 1200, after: 1500 })
    const data = await detail()
    expect(data.period).toMatchObject({ status: 'CLOSED', closeCount: 2 })
    expect(data.diff).toMatchObject({ against: 'PREVIOUS_REVISION', baseRevision: 1, compareRevision: 2, hasChanges: true })
    expect(data.snapshots.map((item: { revision: number }) => item.revision)).toEqual([2, 1])
    expect(data.preview.bases.find((item: { basis: string }) => item.basis === 'ORDERED').items.find((item: { key: string }) => item.key === 'REVENUE').value).toBe(1500)
    expect(await lockedCount('period-pc-2')).toBe(31)
  })

  it('跨企业与数据范围隔离：别的企业看不到也动不了；只授权欧洲店的成员看不到美国店的期间', async () => {
    expect((await get(other, '/finance/periods')).json.data).toMatchObject({ total: 0, items: [] })
    expect((await get(other, `/finance/periods/${periodId}`)).status).toBe(404)
    expect((await post(other, `/finance/periods/${periodId}/check`)).status).toBe(404)
    expect((await get(scoped, `/finance/periods/${periodId}`)).status).toBe(404)
    const list = (await get(scoped, '/finance/periods')).json.data
    expect(list.items.map((item: { id: string }) => item.id)).toEqual(['period-pc-2'])
    expect((await post(scoped, `/finance/periods/${periodId}/check`)).status).toBe(404)
    expect(await rows(`SELECT 1 FROM "AccountingPeriod" WHERE "tenantId" <> $1`, [tenantId])).toHaveLength(0)
  })
})
