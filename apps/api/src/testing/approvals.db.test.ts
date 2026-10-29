import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 审批收件箱（P6-27，真实数据库 + 完整应用）：
// 迁移升级（表、行级隔离、约束、同对象至多一条待处理）与回滚闭环；
// 财务口径与业务口径提交时登记、收件箱里审批或驳回或撤回并回写原模块、原页面审批也回写；发起人不能审批自己的；再次验证身份；
// 关账审批回写；只看得到与自己有关的单据；跨企业隔离。

type Member = { userId: string; token: string }
const TARGET = '20261225010000_approval_requests'

describe('审批记录迁移（P6-27）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('approval_migrate')
    client = await db.connect('approval_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async () => ((await client.query(`SELECT to_regclass('"ApprovalRequest"') IS NOT NULL AS found`)).rows[0] as { found: boolean }).found

  it('升级建表（行级隔离）；约束拒绝非法取值；同对象同类型至多一条待处理；回滚闭环可再升级', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-ap', slug: 't-ap', name: '租户' })
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
    expect((await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ApprovalRequest'`)).rows[0]).toEqual({ relrowsecurity: true })
    expect((await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ApprovalRequest' AND qual LIKE '%nova_current_tenant%'`)).rowCount).toBe(1)

    const base = { tenantId: tenant.id, type: 'FINANCE_POLICY', objectType: 'FinancePolicyVersion', title: '标题', requesterId: 'u-1' }
    const row = (id: string, over: Record<string, unknown> = {}) => insertRow(client, 'ApprovalRequest', { id, objectId: 'o-1', ...base, ...over })
    expect(await row('a-1')).toMatchObject({ status: 'PENDING', version: 1, approverIds: [], ccIds: [] })
    await expect(row('a-dup')).rejects.toMatchObject({ code: '23505' })
    // 已处理的不占用“待处理唯一”：同一对象可以再提一次
    await client.query(`UPDATE "ApprovalRequest" SET status = 'REJECTED', "decidedBy" = 'u-2', "decidedAt" = now() WHERE id = 'a-1'`)
    expect(await row('a-2')).toMatchObject({ status: 'PENDING' })
    await expect(row('a-type', { objectId: 'o-2', type: 'OTHER' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('a-status', { objectId: 'o-3', status: 'DONE', decidedAt: new Date() })).rejects.toMatchObject({ code: '23514' })
    await expect(row('a-nodecided', { objectId: 'o-4', status: 'APPROVED' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('a-early', { objectId: 'o-5', decidedAt: new Date() })).rejects.toMatchObject({ code: '23514' })
    await expect(row('a-title', { objectId: 'o-6', title: '' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('a-ver', { objectId: 'o-7', version: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(row('a-fk', { objectId: 'o-8', tenantId: 'no-such' })).rejects.toMatchObject({ code: '23503' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
  })
})

describe('审批收件箱（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let otherTenantId: string
  let maker: Member
  let checker: Member
  let reader: Member
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const dayText = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset)).toISOString().slice(0, 10)
  const stepUp = (member: Member, tenant = tenantId) =>
    insertRow(h.client, 'StepUpVerification', {
      id: `su-${Math.random().toString(36).slice(2)}`,
      tenantId: tenant,
      userId: member.userId,
      action: 'finance.policy',
      method: 'PASSWORD',
      expiresAt: new Date(Date.now() + 600_000),
    })
  const inbox = async (member: Member, query = '') => {
    const res = await h.call(member.token, 'GET', `/approvals${query}`, {})
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as {
      items: Array<{ id: string; type: string; status: string; canDecide: boolean; isRequester: boolean; version: number; summary: unknown[]; detailPath: string | null }>
      counts: Record<string, number>
      state: string
    }
  }
  const approvalOf = async (objectId: string) =>
    (
      await rows<{ id: string; status: string; decidedBy: string | null; comment: string | null; approverIds: string[]; version: number; type: string }>(
        `SELECT * FROM "ApprovalRequest" WHERE "tenantId" = $1 AND "objectId" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
        [tenantId, objectId],
      )
    )[0]
  const decide = (member: Member, id: string, version: number, decision: 'APPROVED' | 'REJECTED', comment = '') =>
    h.call(member.token, 'POST', `/approvals/${id}/decision`, { body: { decision, comment, version } })

  const submitPolicy = async (member: Member, method: string) => {
    await stepUp(member)
    const detail = await h.call(member.token, 'GET', '/settings/finance-policy', {})
    const res = await h.call(member.token, 'PUT', '/settings/finance-policy', {
      body: {
        version: detail.json.data.latestVersionNo,
        effectiveFrom: dayText(-3),
        revenueRecognition: 'ORDERED',
        inventoryCostMethod: method,
        adsAllocationMode: 'BY_SALES',
        storeFeeAllocation: 'BY_SALES',
        reason: `改用 ${method} 核算存货`,
      },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const versionNo = res.json.data.versionNo as number
    const policy = (await rows<{ id: string }>(`SELECT id FROM "FinancePolicyVersion" WHERE "tenantId" = $1 AND "versionNo" = $2`, [tenantId, versionNo]))[0]!
    return { versionNo, id: policy.id }
  }
  const policyStatus = async (id: string) => (await rows<{ status: string }>(`SELECT status FROM "FinancePolicyVersion" WHERE id = $1`, [id]))[0]?.status

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'approvals', db })
    const a = await h.createTenant('ap-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    const b = await h.createTenant('ap-b')
    otherTenantId = b.tenantId
    const perms = ['settings.read', 'finance.read', 'finance.policy.write', 'settings.business.write', 'finance.period.close']
    maker = await h.createMember(tenantId, 'ap-maker', perms)
    checker = await h.createMember(tenantId, 'ap-checker', perms)
    reader = await h.createMember(tenantId, 'ap-reader', ['settings.read'])
    other = await h.createMember(otherTenantId, 'ap-other', ['*'])
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('没有任何审批：四个信箱都是空的，说明原因而不是 0 当成有数据', async () => {
    const empty = await inbox(maker)
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [], counts: { todoPending: 0, sentPending: 0, ccPending: 0 } })
    expect((await h.call(maker.token, 'GET', '/approvals?box=BAD', {})).status).toBe(422)
    expect((await h.call('bad-token', 'GET', '/approvals', {})).status).toBe(401)
  })

  it('财务口径：提交时登记（审批人是有权限的其他成员）；只有相关的人看得到；收件箱里审批后原模块生效并回写', async () => {
    const policy = await submitPolicy(maker, 'MONTH_AVG')
    const registered = await approvalOf(policy.id)
    expect(registered).toMatchObject({ type: 'FINANCE_POLICY', status: 'PENDING', decidedBy: null })
    expect(registered.approverIds).toEqual([checker.userId])

    const todo = await inbox(checker)
    expect(todo.items).toHaveLength(1)
    expect(todo.items[0]).toMatchObject({ type: 'FINANCE_POLICY', status: 'PENDING', canDecide: true, isRequester: false, detailPath: '/app/settings' })
    expect(todo.items[0]!.summary.length).toBeGreaterThanOrEqual(2)
    expect(todo.counts).toMatchObject({ todoPending: 1, sentPending: 0 })
    expect((await inbox(maker)).items).toHaveLength(0)
    const sent = await inbox(maker, '?box=SENT')
    expect(sent.items[0]).toMatchObject({ isRequester: true, canDecide: true })
    expect(sent.counts).toMatchObject({ todoPending: 0, sentPending: 1 })
    // 无关的成员什么都看不到，也不能处理
    for (const box of ['TODO', 'SENT', 'CC', 'DONE']) expect((await inbox(reader, `?box=${box}`)).items).toHaveLength(0)
    const id = todo.items[0]!.id
    expect((await decide(reader, id, 1, 'APPROVED')).status).toBe(404)

    // 发起人不能审批自己的；没有再次验证身份不能审批；版本过期 409
    await stepUp(maker)
    expect((await decide(maker, id, 1, 'APPROVED')).status).toBe(409)
    expect((await decide(checker, id, 1, 'APPROVED')).status).toBe(403)
    await stepUp(checker)
    expect((await decide(checker, id, 99, 'APPROVED')).status).toBe(409)
    expect((await decide(checker, id, 1, 'REJECTED', '')).status).toBe(422)

    const done = await decide(checker, id, 1, 'APPROVED', '同意')
    expect(done.status, JSON.stringify(done.json)).toBe(200)
    expect(done.json.data).toMatchObject({ id, status: 'APPROVED' })
    expect(await policyStatus(policy.id)).toBe('ACTIVE')
    expect(await approvalOf(policy.id)).toMatchObject({ status: 'APPROVED', decidedBy: checker.userId, comment: '同意' })
    expect((await inbox(checker)).items).toHaveLength(0)
    expect((await inbox(checker, '?state=DONE')).items).toHaveLength(1)
    expect((await inbox(checker, '?box=DONE&state=DONE')).items).toHaveLength(1)
    expect((await inbox(maker, '?box=SENT&state=DONE')).items[0]).toMatchObject({ status: 'APPROVED', canDecide: false })
    // 处理过的不能再处理
    await stepUp(checker)
    expect((await decide(checker, id, 2, 'APPROVED')).status).toBe(409)
    // 收件箱里的审批同样写了审计
    const audits = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'FINANCE_POLICY_APPROVED' AND "result" = 'SUCCEEDED'`, [tenantId])
    expect(audits).toHaveLength(1)
  })

  it('撤回与驳回：发起人在收件箱撤回记为已撤回；别人驳回记为已驳回；从原页面审批同样回写', async () => {
    const second = await submitPolicy(maker, 'FIFO')
    const secondRow = await approvalOf(second.id)
    await stepUp(maker)
    const withdrawn = await decide(maker, secondRow.id, secondRow.version, 'REJECTED', '改主意了，不需要')
    expect(withdrawn.status, JSON.stringify(withdrawn.json)).toBe(200)
    expect(withdrawn.json.data).toMatchObject({ status: 'CANCELLED' })
    expect(await policyStatus(second.id)).toBe('REJECTED')
    expect(await approvalOf(second.id)).toMatchObject({ status: 'CANCELLED', decidedBy: maker.userId })

    const third = await submitPolicy(maker, 'FIFO')
    const thirdRow = await approvalOf(third.id)
    await stepUp(checker)
    const rejected = await decide(checker, thirdRow.id, thirdRow.version, 'REJECTED', '口径不合适')
    expect(rejected.json.data).toMatchObject({ status: 'REJECTED' })
    expect(await policyStatus(third.id)).toBe('REJECTED')

    // 原页面审批（不经过收件箱）也要回写
    const fourth = await submitPolicy(maker, 'FIFO')
    await stepUp(checker)
    const original = await h.call(checker.token, 'POST', `/settings/finance-policy/${fourth.versionNo}/approve`, {
      body: { version: (await rows<{ version: number }>(`SELECT version FROM "FinancePolicyVersion" WHERE id = $1`, [fourth.id]))[0]!.version, decision: 'REJECTED', comment: '在原页面驳回' },
    })
    expect(original.status, JSON.stringify(original.json)).toBe(201)
    expect(await approvalOf(fourth.id)).toMatchObject({ status: 'REJECTED', decidedBy: checker.userId, comment: '在原页面驳回' })
  })

  it('业务口径：提交登记为“利润公式与业务口径变更”，收件箱审批后生成生效版本', async () => {
    await stepUp(maker)
    const sent = await h.call(maker.token, 'PUT', '/settings/business-rules/weekStart', { body: { version: 0, value: { day: 'SUN' }, reason: '按周日开始统计' } })
    expect(sent.status, JSON.stringify(sent.json)).toBe(200)
    const version = (await rows<{ id: string }>(`SELECT id FROM "MetricVersion" WHERE "tenantId" = $1 AND kind = 'BUSINESS_RULES' AND status = 'PENDING_APPROVAL'`, [tenantId]))[0]!
    const request = await approvalOf(version.id)
    expect(request).toMatchObject({ type: 'PROFIT_FORMULA', status: 'PENDING' })
    const item = (await inbox(checker)).items[0]!
    expect(item).toMatchObject({ type: 'PROFIT_FORMULA', canDecide: true, detailPath: '/app/settings/business-rules' })
    await stepUp(checker)
    expect((await decide(checker, item.id, item.version, 'APPROVED')).status).toBe(200)
    expect((await rows<{ status: string }>(`SELECT status FROM "MetricVersion" WHERE id = $1`, [version.id]))[0]!.status).toBe('ACTIVE')
    expect(await approvalOf(version.id)).toMatchObject({ status: 'APPROVED', decidedBy: checker.userId })
  })

  it('关账：检查通过后的审批在收件箱里处理，回写关账期间；发起检查的人不能处理', async () => {
    await insertRow(h.client, 'AccountingPeriod', {
      id: 'period-ap',
      tenantId,
      sellerAccountId: sellerId,
      periodStart: '2025-03-01',
      periodEnd: '2025-03-31',
      status: 'CLOSING',
      checkedBy: maker.userId,
      createdBy: maker.userId,
    })
    await insertRow(h.client, 'ApprovalRequest', {
      id: 'req-period',
      tenantId,
      type: 'PERIOD_CLOSE',
      objectType: 'AccountingPeriod',
      objectId: 'period-ap',
      title: '美国店 2025-03 关账审批',
      requesterId: maker.userId,
      approverIds: [checker.userId],
      summary: JSON.stringify([{ label: '期间', value: '2025-03-01 至 2025-03-31' }]),
    })
    const mine = await inbox(maker, '?box=SENT')
    expect(mine.items[0]).toMatchObject({ type: 'PERIOD_CLOSE', canDecide: false, detailPath: '/app/finance/periods/period-ap' })
    expect((await decide(maker, 'req-period', 1, 'REJECTED', '想撤回一下')).status).toBe(409)
    const res = await decide(checker, 'req-period', 1, 'APPROVED', '核对无误')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(await rows(`SELECT "approvalDecision", "approvedBy" FROM "AccountingPeriod" WHERE id = 'period-ap'`)).toEqual([{ approvalDecision: 'APPROVED', approvedBy: checker.userId }])
    expect(await approvalOf('period-ap')).toMatchObject({ status: 'APPROVED', decidedBy: checker.userId })
  })

  it('尚未接入的类型：能看到但处理时说明原因；跨企业完全隔离', async () => {
    await insertRow(h.client, 'ApprovalRequest', {
      id: 'req-bulk',
      tenantId,
      type: 'BULK_PRICE',
      objectType: 'PriceWriteRun',
      objectId: 'run-1',
      title: '批量改价 12 个 SKU',
      requesterId: maker.userId,
      approverIds: [checker.userId],
    })
    const item = (await inbox(checker)).items.find(entry => entry.id === 'req-bulk')!
    expect(item).toMatchObject({ type: 'BULK_PRICE', canDecide: true, detailPath: null })
    expect((await decide(checker, 'req-bulk', 1, 'APPROVED')).status).toBe(409)
    expect(await approvalOf('run-1')).toMatchObject({ status: 'PENDING' })

    // 其他企业的成员（即使是全权限）看不到、也处理不了
    expect((await inbox(other)).items).toHaveLength(0)
    for (const box of ['SENT', 'CC', 'DONE']) expect((await inbox(other, `?box=${box}&state=DONE`)).items).toHaveLength(0)
    expect((await decide(other, 'req-bulk', 1, 'APPROVED')).status).toBe(404)
    expect((await rows(`SELECT 1 FROM "ApprovalRequest" WHERE "tenantId" = $1`, [otherTenantId])).length).toBe(0)
  })
})
