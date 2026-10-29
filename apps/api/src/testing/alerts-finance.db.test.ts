import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 财务与售后预警（P2b-16，真实数据库）：结算差异、费用多收、赔付机会即将到期、异常退货率从业务表到预警实例、待办的整条链路；
// 重复评估不重复建、业务状态变化后自动恢复、两个企业互不可见。评估代码在后台任务进程里，这里按路径动态加载。

type Ids = Awaited<ReturnType<typeof seedTenant>>
type Evaluate = (deps: Record<string, unknown>) => Promise<{ tenants: number; created: number }>
const DAY = 86_400_000
const dayOffset = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString()
const NEW_CODES = ['FIN_SETTLEMENT_DISCREPANCY', 'FIN_FEE_OVERCHARGE', 'FIN_REIMBURSEMENT_DEADLINE', 'RET_RATE_ABNORMAL']

describe('财务与售后预警（P2b-16，真实数据库）', () => {
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
  const instances = (tenantId: string) =>
    rows<{ code: string; entityType: string; entityId: string; status: string; triggerCount: number; evidenceJson: Record<string, any> }>(
      `SELECT r."code", i."entityType", i."entityId", i."status", i."triggerCount", i."evidenceJson" FROM "AlertInstance" i JOIN "AlertRule" r ON r."id" = i."ruleId" WHERE i."tenantId" = $1 ORDER BY r."code", i."entityId"`,
      [tenantId],
    )
  const open = async (tenantId: string) =>
    (await instances(tenantId))
      .filter(item => ['NEW', 'ACKED'].includes(item.status))
      .map(item => item.code)
      .sort()

  const owner = async (ids: Ids) => {
    await insertRow(admin, 'Role', { id: `role-${ids.tenantId}`, tenantId: ids.tenantId, name: '所有者', permissions: JSON.stringify(['*']), resourceScope: '{}', version: 1 })
    await insertRow(admin, 'Membership', { id: `ms-${ids.tenantId}`, tenantId: ids.tenantId, userId: ids.userId, roleId: `role-${ids.tenantId}` })
  }
  const settlement = async (ids: Ids, key: string, status: string, diff: number, rangeEndDays: number) => {
    const st = await insertRow(admin, 'FbaSettlement', {
      id: `st-${key}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      externalSettlementId: key.toUpperCase(),
      sourceUpdatedAt: iso(-1),
    })
    const rec = await insertRow(admin, 'Reconciliation', {
      id: `rc-${key}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      scopeKind: 'SETTLEMENT',
      settlementId: st.id,
      rangeStart: dayOffset(rangeEndDays - 14),
      rangeEnd: dayOffset(rangeEndDays),
      officialAmount: 1000,
      systemAmount: 1000 - diff,
      diffAmount: diff,
      status,
      computedAt: iso(-1),
    })
    return rec.id as string
  }
  const audit = (ids: Ids, subject: string, kind: string, status: string, overcharge: number, date: string) =>
    insertRow(admin, 'FeeAudit', {
      id: `fa-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      feeKind: kind,
      subjectKey: subject,
      sku: kind === 'INBOUND_PLACEMENT' ? null : subject,
      snapshotDate: date,
      currency: 'USD',
      expectedAmount: 10,
      actualAmount: 10 + overcharge,
      diffAmount: overcharge,
      overchargeAmount: overcharge,
      occurrences: overcharge > 0 ? 1 : 0,
      checkedCount: 1,
      status,
    })
  const opportunity = (ids: Ids, key: string, status: string, deadline: string | null, extra: Record<string, unknown> = {}) =>
    insertRow(admin, 'ReimbursementOpportunity', {
      id: `ro-${key}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      ruleCode: 'INBOUND_DISCREPANCY',
      dedupKey: key,
      evidenceRefsJson: '[]',
      status,
      deadlineAt: deadline,
      sku: key,
      qty: 3,
      ...extra,
    })
  const returned = (ids: Ids, asin: string, quantity: number, daysAgo: number, reason: string) =>
    insertRow(admin, 'FbaReturnCase', {
      id: `rt-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      amazonOrderId: `111-${seq}`,
      asin,
      sellerSku: `SKU-${asin}`,
      quantity,
      reason,
      returnDate: iso(-daysAgo),
      sourceUpdatedAt: iso(-1),
    })
  const sold = (ids: Ids, asin: string, units: number, daysAgo: number) =>
    insertRow(admin, 'AsinDailySummary', { id: `ads-${++seq}`, tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, asin, summaryDate: dayOffset(-daysAgo), units, metricVersion: 'p2b-16' })

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alertsp2b16')
    db.migrate('alertsp2b16')
    admin = await db.connect('alertsp2b16')
    a = await seedTenant(admin, 'af-a')
    b = await seedTenant(admin, 'af-b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('alertsp2b16', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    evaluateAll = (await import(/* @vite-ignore */ String('../../../worker/src/platform/alert-evaluate'))).evaluateAllTenants
    provision = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/provision'))).ensureDefaultRules
    createEvaluators = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/register'))).createAlertEvaluators
    await owner(a)
    await owner(b)

    // 租户 A：结算差异——有差异且大、已对平、差额不到 1 美元、结算周期太久远
    const bigDiff = await settlement(a, 'big', 'DISCREPANCY', 12.34, -10)
    await settlement(a, 'ok', 'MATCHED', 0, -10)
    await settlement(a, 'tiny', 'DISCREPANCY', 0.3, -10)
    await settlement(a, 'old', 'DISCREPANCY', 50, -200)
    for (const ref of ['o1', 'o2'])
      await insertRow(admin, 'ReconciliationException', {
        id: `re-${ref}`,
        tenantId: a.tenantId,
        reconciliationId: bigDiff,
        kind: 'API_ONLY',
        category: 'TIMING',
        refKey: ref,
        amount: 6,
        absAmount: 6,
      })
    // 费用多收：最新核查日里配送费 4 + 3 = 7（达到默认阈值 5）、佣金只有 2、仓储费已转赔付机会；更早一天的核查不算
    await audit(a, 'SKU-1', 'FULFILLMENT', 'SUSPECTED', 4, dayOffset(-1))
    await audit(a, 'SKU-2', 'FULFILLMENT', 'SUSPECTED', 3, dayOffset(-1))
    await audit(a, 'SKU-3', 'COMMISSION', 'SUSPECTED', 2, dayOffset(-1))
    await audit(a, 'SKU-4', 'STORAGE', 'APPEALED', 50, dayOffset(-1))
    await audit(a, 'SKU-5', 'FULFILLMENT', 'SUSPECTED', 100, dayOffset(-3))
    // 赔付机会：10 天后到期的待处理、60 天后到期、已生成案件、已过期未处理、没有期限
    await opportunity(a, 'SOON', 'PENDING', dayOffset(10), { estimatedAmount: 45.5, currency: 'USD' })
    await opportunity(a, 'LATER', 'PENDING', dayOffset(60))
    await opportunity(a, 'CASED', 'CASE_CREATED', dayOffset(5))
    await opportunity(a, 'PAST', 'PENDING', dayOffset(-2))
    await opportunity(a, 'NODUE', 'PENDING', null)
    // 退货率：B0A 退 10 件 ÷ 卖 50 件 = 20%；B0B 退 9 件 ÷ 卖 900 件 = 1%；B0C 退 2 件（样本不够）
    await returned(a, 'B0A', 6, 3, 'DEFECTIVE')
    await returned(a, 'B0A', 4, 5, 'NO_REASON_GIVEN')
    await returned(a, 'B0B', 9, 4, 'DEFECTIVE')
    await returned(a, 'B0C', 2, 4, 'DEFECTIVE')
    await sold(a, 'B0A', 20, 2)
    await sold(a, 'B0A', 30, 6)
    await sold(a, 'B0B', 900, 3)
    await sold(a, 'B0C', 500, 3)

    // 租户 B：自己的一条即将到期赔付机会
    await opportunity(b, 'B-SOON', 'PENDING', dayOffset(3))
  }, 180_000)

  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('第一轮：四类预警各命中应命中的对象，不该命中的（已对平、零头、太久远、已转机会、不到阈值、无期限、样本不够）都不命中；企业互不可见', async () => {
    const result = await run()
    expect(result.tenants).toBe(2)
    expect(await open(a.tenantId)).toEqual([...NEW_CODES].sort())
    expect(await open(b.tenantId)).toEqual(['FIN_REIMBURSEMENT_DEADLINE'])
    expect(result.created).toBe(5)
    const list = await instances(a.tenantId)
    const of = (code: string) => list.filter(item => item.code === code)
    expect(of('FIN_SETTLEMENT_DISCREPANCY')).toHaveLength(1)
    expect(of('FIN_SETTLEMENT_DISCREPANCY')[0]).toMatchObject({ entityType: 'SETTLEMENT', entityId: 'st-big' })
    expect(of('FIN_SETTLEMENT_DISCREPANCY')[0].evidenceJson).toMatchObject({ settlementId: 'BIG', diffAmount: 12.34, openExceptions: 2 })
    expect(of('FIN_FEE_OVERCHARGE')).toHaveLength(1)
    expect(of('FIN_FEE_OVERCHARGE')[0].evidenceJson).toMatchObject({ feeKind: 'FULFILLMENT', overchargeTotal: 7, itemCount: 2, currency: 'USD' })
    expect(of('FIN_REIMBURSEMENT_DEADLINE')).toHaveLength(1)
    expect(of('FIN_REIMBURSEMENT_DEADLINE')[0]).toMatchObject({ entityType: 'REIMBURSEMENT_OPPORTUNITY', entityId: 'ro-SOON' })
    expect(of('FIN_REIMBURSEMENT_DEADLINE')[0].evidenceJson).toMatchObject({ daysLeft: 10, estimatedAmount: 45.5 })
    expect(of('RET_RATE_ABNORMAL')).toHaveLength(1)
    expect(of('RET_RATE_ABNORMAL')[0].evidenceJson).toMatchObject({ asin: 'B0A', returnedUnits: 10, soldUnits: 50, rate: 0.2, topReason: { code: 'DEFECTIVE', units: 6 } })
  })

  it('每个预警都生成待办：财务类带影响金额，没有估算依据的不写；售后类不写影响金额；新增预置规则每个企业都有', async () => {
    const works = await rows<{ ruleCode: string; kind: string; severity: string; entityType: string; impactMin: string | null; currency: string; ownerId: string }>(
      `SELECT "ruleCode", "kind", "severity", "entityType", "impactMin", "currency", "ownerId" FROM "WorkItem" WHERE "tenantId" = $1 ORDER BY "ruleCode"`,
      [a.tenantId],
    )
    expect(works.map(work => work.ruleCode)).toEqual([...NEW_CODES].sort())
    const byRule = Object.fromEntries(works.map(work => [work.ruleCode, work]))
    expect(byRule.FIN_SETTLEMENT_DISCREPANCY).toMatchObject({ kind: 'FINANCE', severity: 'WARNING', impactMin: '12.340000', currency: 'USD', ownerId: a.userId })
    expect(byRule.FIN_FEE_OVERCHARGE).toMatchObject({ kind: 'FINANCE', impactMin: '7.000000' })
    expect(byRule.FIN_REIMBURSEMENT_DEADLINE.impactMin).toBe('45.500000')
    expect(byRule.RET_RATE_ABNORMAL).toMatchObject({ kind: 'AFTER_SALES', impactMin: null })
    for (const tenantId of [a.tenantId, b.tenantId]) {
      const codes = await rows<{ code: string }>(`SELECT "code" FROM "AlertRule" WHERE "tenantId" = $1 AND "code" = ANY($2)`, [tenantId, NEW_CODES])
      expect(codes).toHaveLength(NEW_CODES.length)
    }
  })

  it('第二轮数据没变：不新建预警与待办，只刷新命中次数', async () => {
    const result = await run()
    expect(result.created).toBe(0)
    expect((await instances(a.tenantId)).every(item => item.triggerCount === 2)).toBe(true)
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(4)
  })

  it('业务状态变化后自动恢复：重新对平、费用转成赔付机会、机会生成案件、退货率回落；待办留给人确认；租户 B 不受影响', async () => {
    await admin.query(`UPDATE "Reconciliation" SET "status" = 'MATCHED', "diffAmount" = 0 WHERE "id" = 'rc-big'`)
    await admin.query(`UPDATE "FeeAudit" SET "status" = 'APPEALED' WHERE "tenantId" = $1 AND "feeKind" = 'FULFILLMENT'`, [a.tenantId])
    await admin.query(`UPDATE "ReimbursementOpportunity" SET "status" = 'CASE_CREATED' WHERE "id" = 'ro-SOON'`)
    await sold(a, 'B0A', 400, 1)
    await run()
    expect(await open(a.tenantId)).toEqual([])
    expect((await instances(a.tenantId)).every(item => item.status === 'AUTO_CLOSED')).toBe(true)
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1 AND "status" = 'PENDING'`, [a.tenantId])).toHaveLength(4)
    expect(await open(b.tenantId)).toEqual(['FIN_REIMBURSEMENT_DEADLINE'])
  })

  it('冷却期内再次命中不重复建待办；规则范围改到别的店铺后命中消失，企业改过的规则不被预置覆盖；后台账号不在租户上下文里读不到预警', async () => {
    await admin.query(`UPDATE "ReimbursementOpportunity" SET "status" = 'PENDING' WHERE "id" = 'ro-SOON'`)
    await run()
    expect(await open(a.tenantId)).toEqual([])
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(4)
    await admin.query(`UPDATE "AlertRule" SET "scopeJson" = $2 WHERE "tenantId" = $1 AND "code" = 'FIN_REIMBURSEMENT_DEADLINE'`, [a.tenantId, JSON.stringify({ sellerAccountIds: ['other-store'] })])
    await run()
    expect(await open(a.tenantId)).toEqual([])
    const rule = await rows<{ scopeJson: Record<string, unknown> }>(`SELECT "scopeJson" FROM "AlertRule" WHERE "tenantId" = $1 AND "code" = 'FIN_REIMBURSEMENT_DEADLINE'`, [a.tenantId])
    expect(rule[0].scopeJson).toEqual({ sellerAccountIds: ['other-store'] })
    expect(await base.alertInstance.count()).toBe(0)
  })
})
