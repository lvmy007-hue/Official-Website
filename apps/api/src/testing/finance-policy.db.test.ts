import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 财务口径设置（P2b-15，真实数据库 + 完整应用）：
// 迁移升级（表、行级隔离、约束）与回滚闭环；
// 提交（再次验证）→ 待审批 → 另一位成员审批生效（存货计价同步写入企业设置、替换旧版本）→ 撤回与驳回 → 关账期间拒绝 → 乐观锁；权限先于参数、跨企业隔离。

type Member = { userId: string; token: string }
const TARGET = '20261108010000_finance_policy'

describe('财务口径迁移（P2b-15）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('policy_migrate')
    client = await db.connect('policy_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async () => ((await client.query(`SELECT to_regclass('"FinancePolicyVersion"') IS NOT NULL AS found`)).rows[0] as { found: boolean }).found

  it('升级建表（行级隔离）；约束拒绝非法取值与重复版本号；回滚闭环可再升级', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-fp', slug: 't-fp', name: '租户' })
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
    expect((await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'FinancePolicyVersion'`)).rows[0]).toEqual({ relrowsecurity: true })
    expect((await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'FinancePolicyVersion' AND qual LIKE '%nova_current_tenant%'`)).rowCount).toBe(1)

    const base = {
      tenantId: tenant.id,
      effectiveFrom: '2026-01-01',
      revenueRecognition: 'ORDERED',
      inventoryCostMethod: 'FIFO',
      adsAllocationMode: 'BY_SALES',
      storeFeeAllocation: 'BY_SALES',
      reason: '初始',
      createdBy: 'u',
    }
    const row = (id: string, over: Record<string, unknown> = {}) => insertRow(client, 'FinancePolicyVersion', { id, versionNo: 1, ...base, ...over })
    expect(await row('v-1')).toMatchObject({ status: 'PENDING', version: 1, fxRateRule: 'SALE_DAY' })
    await expect(row('v-dup')).rejects.toMatchObject({ code: '23505' })
    await expect(row('v-status', { versionNo: 2, status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('v-method', { versionNo: 3, inventoryCostMethod: 'LIFO' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('v-basis', { versionNo: 4, revenueRecognition: 'PAID' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('v-fx', { versionNo: 5, fxRateRule: 'TODAY' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('v-no', { versionNo: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(row('v-fk', { versionNo: 6, tenantId: 'no-such' })).rejects.toMatchObject({ code: '23503' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
  })
})

describe('财务口径设置（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let maker: Member
  let checker: Member
  let reader: Member
  let newcomer: Member
  let other: Member
  let otherTenantId: string

  const get = (member: Member, path = '/settings/finance-policy') => h.call(member.token, 'GET', path, {})
  const send = (member: Member, method: string, path: string, body?: Record<string, unknown>) => h.call(member.token, method, path, { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const dayText = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset)).toISOString().slice(0, 10)
  const stepUp = (member: Member) =>
    insertRow(h.client, 'StepUpVerification', {
      id: `su-${Math.random().toString(36).slice(2)}`,
      tenantId: member === other ? otherTenantId : tenantId,
      userId: member.userId,
      action: 'finance.policy',
      method: 'PASSWORD',
      expiresAt: new Date(Date.now() + 600_000),
    })
  const detail = async (member: Member = maker) => (await get(member)).json.data
  const submit = async (member: Member, over: Record<string, unknown> = {}) => {
    await stepUp(member)
    return send(member, 'PUT', '/settings/finance-policy', {
      version: (await detail(member)).latestVersionNo,
      effectiveFrom: dayText(-3),
      revenueRecognition: 'ORDERED',
      inventoryCostMethod: 'MONTH_AVG',
      adsAllocationMode: 'BY_SALES',
      storeFeeAllocation: 'BY_SALES',
      reason: '改用月末加权平均核算存货',
      ...over,
    })
  }
  const decide = async (member: Member, versionNo: number, body: Record<string, unknown>) => {
    await stepUp(member)
    const row = (await rows<{ version: number }>(`SELECT version FROM "FinancePolicyVersion" WHERE "tenantId" = $1 AND "versionNo" = $2`, [tenantId, versionNo]))[0]
    return send(member, 'POST', `/settings/finance-policy/${versionNo}/approve`, { version: row?.version ?? 1, ...body })
  }
  const setting = async () =>
    (
      await rows<{ valueJson: unknown; version: number }>(`SELECT "valueJson", version FROM "TenantSetting" WHERE "tenantId" = $1 AND key = 'finance.inventoryCosting' AND "sellerAccountId" IS NULL`, [
        tenantId,
      ])
    )[0]
  const statusOf = async (versionNo: number) =>
    (await rows<{ status: string }>(`SELECT status FROM "FinancePolicyVersion" WHERE "tenantId" = $1 AND "versionNo" = $2`, [tenantId, versionNo]))[0]?.status
  const audits = async () =>
    (await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND action LIKE 'FINANCE_POLICY_%' AND "result" = 'SUCCEEDED' ORDER BY "createdAt", id`, [tenantId])).map(
      row => row.action,
    )

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'finance_policy', db })
    const a = await h.createTenant('fp-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    const b = await h.createTenant('fp-b')
    otherTenantId = b.tenantId
    maker = await h.createMember(tenantId, 'fp-maker', ['settings.read', 'finance.policy.write'])
    checker = await h.createMember(tenantId, 'fp-checker', ['settings.read', 'finance.policy.write'])
    reader = await h.createMember(tenantId, 'fp-reader', ['settings.read'])
    newcomer = await h.createMember(tenantId, 'fp-newcomer', ['settings.read', 'finance.policy.write'])
    other = await h.createMember(b.tenantId, 'fp-other', ['*'])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('还没有版本：用默认口径，存货计价沿用企业设置里早先写入的值；只读成员看得到但不能提交，提示原因', async () => {
    const empty = await detail()
    expect(empty).toMatchObject({
      current: {
        source: 'DEFAULT',
        versionNo: 0,
        effectiveFrom: null,
        inventoryMethodValid: true,
        values: { revenueRecognition: 'ORDERED', inventoryCostMethod: 'FIFO', adsAllocationMode: 'BY_SALES' },
      },
      pending: null,
      history: [],
      latestVersionNo: 0,
      actions: { submit: { allowed: true }, approve: { allowed: false }, reject: { allowed: false } },
    })
    expect(empty.fields.map((item: { key: string; consumer: string; editable: boolean }) => `${item.key}:${item.consumer}:${item.editable}`)).toEqual([
      'revenueRecognition:RECORDED:true',
      'inventoryCostMethod:WIRED:true',
      'fxRateRule:WIRED:false',
      'adsAllocationMode:WIRED:true',
      'storeFeeAllocation:WIRED:true',
    ])
    const view = await detail(reader)
    expect(view.actions.submit).toMatchObject({ allowed: false, reason: expect.stringContaining('finance.policy.write') })

    await h.client.query(
      `INSERT INTO "TenantSetting" (id, "tenantId", key, "valueJson", scope, "updatedBy", "updatedAt") VALUES ('ts-fp', $1, 'finance.inventoryCosting', '"MOVING_AVG"', 'TENANT', 'u', now())`,
      [tenantId],
    )
    expect((await detail()).current).toMatchObject({ source: 'DEFAULT', inventoryMethodValid: true, values: { inventoryCostMethod: 'MOVING_AVG' } })
    await h.client.query(`UPDATE "TenantSetting" SET "valueJson" = '"WEIRD"' WHERE id = 'ts-fp'`)
    expect((await detail()).current).toMatchObject({ inventoryMethodValid: false, values: { inventoryCostMethod: 'FIFO' } })
    await h.client.query(`DELETE FROM "TenantSetting" WHERE id = 'ts-fp'`)
  })

  it('权限先于参数：没有权限的人拿 403，不会先看到 422；提交要再次验证身份；参数与生效日不合法 422', async () => {
    const denied = await send(reader, 'PUT', '/settings/finance-policy', { garbage: true })
    expect(denied.status).toBe(403)
    const noStep = await send(maker, 'PUT', '/settings/finance-policy', { version: 0 })
    expect(noStep.status).toBe(403)
    expect(noStep.json.error.code).toBe('STEP_UP_REQUIRED')

    const badBody = await submit(maker, { inventoryCostMethod: 'LIFO' })
    expect(badBody.status).toBe(422)
    const future = await submit(maker, { effectiveFrom: dayText(1) })
    expect(future.status).toBe(422)
    expect(future.json.error.fieldErrors?.effectiveFrom ?? JSON.stringify(future.json)).toBeTruthy()
    const tooOld = await submit(maker, { effectiveFrom: dayText(-400) })
    expect(tooOld.status).toBe(422)
    const noReason = await submit(maker, { reason: '' })
    expect(noReason.status).toBe(422)
    expect(await rows(`SELECT 1 FROM "FinancePolicyVersion" WHERE "tenantId" = $1`, [tenantId])).toHaveLength(0)
  })

  it('提交 → 待审批（不生效，企业设置不变）→ 不能再提交 → 发起人不能审批自己的 → 另一位审批后生效并写入企业设置', async () => {
    const res = await submit(maker)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ versionNo: 1, status: 'PENDING', version: 1 })
    expect(await setting()).toBeUndefined()
    const pendingView = await detail()
    expect(pendingView).toMatchObject({
      pending: { versionNo: 1, status: 'PENDING', inventoryCostMethod: 'MONTH_AVG', createdByName: expect.any(String) },
      latestVersionNo: 1,
      current: { source: 'DEFAULT' },
    })
    expect(pendingView.actions).toMatchObject({ submit: { allowed: false }, approve: { allowed: false, reason: expect.stringContaining('发起人') }, reject: { allowed: true } })
    expect((await detail(checker)).actions).toMatchObject({ approve: { allowed: true }, reject: { allowed: true } })
    expect(pendingView.pending.mine).toBe(true)
    expect((await detail(checker)).pending.mine).toBe(false)

    const again = await submit(maker, { inventoryCostMethod: 'FIFO' })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('DATA_CONDITION_FAILED')
    const self = await decide(maker, 1, { decision: 'APPROVED' })
    expect(self.status).toBe(409)
    expect(await statusOf(1)).toBe('PENDING')
    const missing = await decide(checker, 99, { decision: 'APPROVED' })
    expect(missing.status).toBe(404)

    const noStep = await send(newcomer, 'POST', '/settings/finance-policy/1/approve', { version: 1, decision: 'APPROVED' })
    expect(noStep.status).toBe(403)
    expect(noStep.json.error.code).toBe('STEP_UP_REQUIRED')
    const approved = await decide(checker, 1, { decision: 'APPROVED', comment: '同意改用月末加权' })
    expect(approved.status, JSON.stringify(approved.json)).toBe(201)
    expect(approved.json.data).toMatchObject({ versionNo: 1, status: 'ACTIVE' })
    expect(await statusOf(1)).toBe('ACTIVE')
    expect(await setting()).toMatchObject({ valueJson: 'MONTH_AVG' })

    const active = await detail()
    expect(active).toMatchObject({ pending: null, current: { source: 'VERSION', versionNo: 1, effectiveFrom: dayText(-3), values: { inventoryCostMethod: 'MONTH_AVG' } } })
    expect(active.history[0]).toMatchObject({ versionNo: 1, status: 'ACTIVE', decidedByName: expect.any(String), decisionComment: '同意改用月末加权', withdrawn: false })
    expect(await audits()).toEqual(['FINANCE_POLICY_SUBMITTED', 'FINANCE_POLICY_APPROVED'])
    const [audit] = await rows<{ detailJson: { summary: string[]; settingSynced: string } }>(
      `SELECT detail AS "detailJson" FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'FINANCE_POLICY_APPROVED' AND "result" = 'SUCCEEDED'`,
      [tenantId],
    )
    expect(audit?.detailJson.summary).toEqual(['存货计价方法：先进先出 → 月末加权平均'])
    expect(audit?.detailJson.settingSynced).toBe('finance.inventoryCosting')
  })

  it('与当前生效口径完全相同 422；版本号过期 409；发起人可以撤回，别人驳回要写原因；撤回与驳回都不改企业设置', async () => {
    const same = await submit(maker)
    expect(same.status).toBe(422)

    await stepUp(maker)
    const stale = await send(maker, 'PUT', '/settings/finance-policy', {
      version: 0,
      effectiveFrom: dayText(-1),
      revenueRecognition: 'SHIPPED',
      inventoryCostMethod: 'MONTH_AVG',
      adsAllocationMode: 'BY_UNITS',
      storeFeeAllocation: 'BY_SALES',
      reason: '用旧的版本号提交',
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('CONFLICT')

    const second = await submit(maker, { revenueRecognition: 'SHIPPED', adsAllocationMode: 'BY_UNITS' })
    expect(second.status, JSON.stringify(second.json)).toBe(200)
    expect(second.json.data.versionNo).toBe(2)
    const noReason = await decide(maker, 2, { decision: 'REJECTED' })
    expect(noReason.status).toBe(422)
    const withdrawn = await decide(maker, 2, { decision: 'REJECTED', comment: '写错了，重新提交' })
    expect(withdrawn.status, JSON.stringify(withdrawn.json)).toBe(201)
    expect(withdrawn.json.data.message).toContain('撤回')
    expect(await statusOf(2)).toBe('REJECTED')

    const third = await submit(maker, { revenueRecognition: 'SETTLED', inventoryCostMethod: 'FIFO' })
    expect(third.json.data.versionNo).toBe(3)
    const rejected = await decide(checker, 3, { decision: 'REJECTED', comment: '先别改计价方法' })
    expect(rejected.status).toBe(201)
    expect(rejected.json.data.message).toContain('驳回')
    expect(await setting()).toMatchObject({ valueJson: 'MONTH_AVG' })

    const view = await detail()
    expect(view.current.versionNo).toBe(1)
    expect(view.history.map((item: { versionNo: number; status: string; withdrawn: boolean }) => `${item.versionNo}:${item.status}:${item.withdrawn}`)).toEqual([
      '3:REJECTED:false',
      '2:REJECTED:true',
      '1:ACTIVE:false',
    ])
    const done = await decide(checker, 3, { decision: 'APPROVED' })
    expect(done.status).toBe(409)
  })

  it('再次批准新版本：旧版本变已替换，只留一个生效版本，企业设置跟着变', async () => {
    const res = await submit(maker, { inventoryCostMethod: 'FIFO', revenueRecognition: 'SETTLED', storeFeeAllocation: 'BY_UNITS', reason: '改回先进先出，收入按结算释放确认' })
    expect(res.json.data.versionNo).toBe(4)
    const ok = await decide(checker, 4, { decision: 'APPROVED' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)
    expect(await statusOf(1)).toBe('REPLACED')
    expect(await statusOf(4)).toBe('ACTIVE')
    expect((await rows(`SELECT 1 FROM "FinancePolicyVersion" WHERE "tenantId" = $1 AND status = 'ACTIVE'`, [tenantId])).length).toBe(1)
    expect((await rows<{ replacedAt: Date | null }>(`SELECT "replacedAt" FROM "FinancePolicyVersion" WHERE "tenantId" = $1 AND "versionNo" = 1`, [tenantId]))[0]?.replacedAt).toBeTruthy()
    expect(await setting()).toMatchObject({ valueJson: 'FIFO' })
    expect((await detail()).current).toMatchObject({
      versionNo: 4,
      values: { revenueRecognition: 'SETTLED', inventoryCostMethod: 'FIFO', storeFeeAllocation: 'BY_UNITS', adsAllocationMode: 'BY_SALES' },
    })
  })

  it('已关账与关账中的期间：生效日落在里面提交被拒绝；提交后该期间被关账则不能审批、只能驳回；期间之外的日期不受影响', async () => {
    const period = (id: string, status: string, start: string, end: string) =>
      insertRow(h.client, 'AccountingPeriod', { id, tenantId, sellerAccountId: sellerId, periodStart: start, periodEnd: end, status, closeCount: 1, createdBy: 'u' })
    await period('ap-closed', 'CLOSED', dayText(-30), dayText(-20))
    const blocked = await submit(maker, { effectiveFrom: dayText(-25), inventoryCostMethod: 'MOVING_AVG' })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('DATA_CONDITION_FAILED')
    expect(blocked.json.error.message).toContain('已关账')
    expect((await detail()).frozenPeriodCount).toBe(1)

    const fine = await submit(maker, { effectiveFrom: dayText(-5), inventoryCostMethod: 'MOVING_AVG' })
    expect(fine.status, JSON.stringify(fine.json)).toBe(200)
    const versionNo = fine.json.data.versionNo as number
    await period('ap-closing', 'CLOSING', dayText(-10), dayText(0))
    const approve = await decide(checker, versionNo, { decision: 'APPROVED' })
    expect(approve.status).toBe(409)
    expect(approve.json.error.message).toContain('关账中')
    expect(await statusOf(versionNo)).toBe('PENDING')
    expect(await setting()).toMatchObject({ valueJson: 'FIFO' })
    const reject = await decide(checker, versionNo, { decision: 'REJECTED', comment: '期间已关账，重新提交' })
    expect(reject.status).toBe(201)
  })

  it('企业之间隔离：别家看不到版本也审批不了；各自的口径互不影响', async () => {
    const mine = await get(other)
    expect(mine.json.data).toMatchObject({ current: { source: 'DEFAULT' }, pending: null, history: [], latestVersionNo: 0 })
    await stepUp(other)
    const cross = await send(other, 'POST', '/settings/finance-policy/4/approve', { version: 1, decision: 'APPROVED' })
    expect(cross.status).toBe(404)
    expect(await statusOf(4)).toBe('ACTIVE')
  })
})
