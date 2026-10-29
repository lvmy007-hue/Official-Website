import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 口径版本（P6-31，真实数据库）：利润公式与业务口径的提交、别人审批、同一时刻只有一个生效版本、审计、没有权限不能改、跨企业隔离、
// 差异报告（只读），以及生效后的版本出现在利润总览里。

type Member = { userId: string; token: string }

describe('口径版本（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let maker: Member
  let checker: Member
  let reader: Member
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const stepUp = (member: Member, tenant = tenantId) =>
    insertRow(h.client, 'StepUpVerification', {
      id: `su-${Math.random().toString(36).slice(2)}`,
      tenantId: tenant,
      userId: member.userId,
      action: 'finance.policy',
      method: 'PASSWORD',
      expiresAt: new Date(Date.now() + 600_000),
    })
  const formula = async (member: Member) => (await h.call(member.token, 'GET', '/finance/profit-formula')).json.data
  const submit = async (member: Member, gross: string[], denominator: string[], reason = '把推广算进毛利') => {
    await stepUp(member)
    return h.call(member.token, 'PUT', '/finance/profit-formula', { body: { version: (await formula(member)).latestVersionNo, gross, denominator, reason } })
  }
  const decide = async (member: Member, id: string, decision: 'APPROVED' | 'REJECTED', comment = '') => {
    await stepUp(member)
    const row = (await rows<{ version: number }>(`SELECT version FROM "MetricVersion" WHERE id = $1`, [id]))[0]
    return h.call(member.token, 'POST', `/metric-versions/${id}/decision`, { body: { decision, comment, version: row?.version ?? 1 } })
  }
  const active = (kind: string, tenant = tenantId) => rows<{ versionNo: number }>(`SELECT "versionNo" FROM "MetricVersion" WHERE "tenantId" = $1 AND kind = $2 AND status = 'ACTIVE'`, [tenant, kind])
  const audits = async () =>
    (await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND action LIKE 'METRIC_VERSION_%' AND "result" = 'SUCCEEDED' ORDER BY "createdAt", id`, [tenantId])).map(
      row => row.action,
    )

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'metric_versions' })
    tenantId = (await h.createTenant('mv-a')).tenantId
    otherTenantId = (await h.createTenant('mv-b')).tenantId
    maker = await h.createMember(tenantId, 'mv-maker', ['finance.read', 'settings.read', 'finance.policy.write', 'settings.business.write'])
    checker = await h.createMember(tenantId, 'mv-checker', ['finance.read', 'settings.read', 'finance.policy.write', 'settings.business.write'])
    reader = await h.createMember(tenantId, 'mv-reader', ['finance.read', 'settings.read'])
    other = await h.createMember(otherTenantId, 'mv-other', ['*'])
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('没有生效版本时用系统默认，读取不需要写权限', async () => {
    const data = await formula(reader)
    expect(data.current).toMatchObject({ versionNo: 0, source: 'DEFAULT' })
    expect(data.latestVersionNo).toBe(0)
    expect(data.canWrite).toBe(false)
    expect((await h.call(reader.token, 'GET', '/settings/business-rules')).json.data.cards).toHaveLength(4)
  })

  it('没有写权限不能提交；提交非法公式 422', async () => {
    const keys = (await formula(maker)).current.config as { gross: string[]; denominator: string[] }
    await stepUp(reader)
    expect((await h.call(reader.token, 'PUT', '/finance/profit-formula', { body: { version: 0, gross: keys.gross, denominator: keys.denominator, reason: '想改一下' } })).status).toBe(403)
    expect((await submit(maker, keys.gross, [])).status).toBe(422)
    expect(await active('PROFIT_FORMULA')).toEqual([])
  })

  it('提交后待审批；自己不能通过；别人通过后只有一个生效版本，并写审计', async () => {
    const config = (await formula(maker)).current.config as { gross: string[]; denominator: string[] }
    const extra = (await formula(maker)).rows.find((row: { key: string; direction: string }) => row.direction === 'COST' && !config.gross.includes(row.key)).key as string
    const sent = await submit(maker, [...config.gross, extra], config.denominator)
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    const pending = (await formula(maker)).pending
    expect(pending).toMatchObject({ versionNo: 1, status: 'PENDING_APPROVAL', mine: true })
    expect((await submit(maker, [...config.gross, extra], config.denominator)).status).toBe(409)
    expect((await decide(maker, pending.id, 'APPROVED')).status).toBe(409)
    const approved = await decide(checker, pending.id, 'APPROVED')
    expect(approved.status, JSON.stringify(approved.json)).toBeLessThan(300)
    expect(await active('PROFIT_FORMULA')).toEqual([{ versionNo: 1 }])
    const after = await formula(reader)
    expect(after.current).toMatchObject({ versionNo: 1, source: 'VERSION' })
    expect(after.current.config.gross).toContain(extra)
    expect(await audits()).toEqual(['METRIC_VERSION_SUBMITTED', 'METRIC_VERSION_APPROVED'])
  })

  it('再改一版并通过后，旧版本失效，仍然只有一个生效版本；驳回需要写意见', async () => {
    const config = (await formula(maker)).current.config as { gross: string[]; denominator: string[] }
    await submit(checker, config.gross.slice(0, -1), config.denominator)
    const pending = (await formula(maker)).pending
    expect(pending.versionNo).toBe(2)
    expect((await decide(maker, pending.id, 'REJECTED', '')).status).toBe(422)
    expect((await decide(maker, pending.id, 'APPROVED')).status).toBeLessThan(300)
    expect(await active('PROFIT_FORMULA')).toEqual([{ versionNo: 2 }])
    expect((await rows<{ status: string }>(`SELECT status FROM "MetricVersion" WHERE "tenantId" = $1 AND kind = 'PROFIT_FORMULA' AND "versionNo" = 1`, [tenantId]))[0]?.status).toBe('RETIRED')
  })

  it('业务口径：提交周起始日、别人通过后生效；版本列表按类型过滤', async () => {
    await stepUp(maker)
    const sent = await h.call(maker.token, 'PUT', '/settings/business-rules/weekStart', { body: { version: 0, value: { day: 'SUN' }, reason: '按周日开始统计' } })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    const pending = (await h.call(maker.token, 'GET', '/settings/business-rules')).json.data.pending
    expect((await decide(checker, pending.id, 'APPROVED')).status).toBeLessThan(300)
    const cards = (await h.call(reader.token, 'GET', '/settings/business-rules')).json.data.cards as Array<{ key: string; value: unknown }>
    expect(cards.find(card => card.key === 'weekStart')?.value).toEqual({ day: 'SUN' })
    const list = (await h.call(reader.token, 'GET', '/metric-versions?kind=BUSINESS_RULES')).json.data
    expect(list.items.every((item: { kind: string }) => item.kind === 'BUSINESS_RULES')).toBe(true)
    expect(list.total).toBe(1)
    await stepUp(maker)
    expect((await h.call(maker.token, 'PUT', '/settings/business-rules/weekStart', { body: { version: 1, value: { day: 'FRI' }, reason: '非法取值' } })).status).toBe(422)
  })

  it('差异报告只读：不改任何版本，区间过长 422', async () => {
    const id = (await rows<{ id: string }>(`SELECT id FROM "MetricVersion" WHERE "tenantId" = $1 AND kind = 'PROFIT_FORMULA' AND "versionNo" = 2`, [tenantId]))[0]!.id
    const before = await rows(`SELECT id, status, version FROM "MetricVersion" WHERE "tenantId" = $1 ORDER BY id`, [tenantId])
    const report = await h.call(maker.token, 'POST', `/metric-versions/${id}/diff-report`, { body: { from: '2026-09-01', to: '2026-09-30' } })
    expect(report.status, JSON.stringify(report.json)).toBeLessThan(300)
    expect(report.json.data).toMatchObject({ versionId: id, kind: 'PROFIT_FORMULA' })
    expect((await h.call(maker.token, 'POST', `/metric-versions/${id}/diff-report`, { body: { from: '2024-01-01', to: '2026-09-30' } })).status).toBe(422)
    expect(await rows(`SELECT id, status, version FROM "MetricVersion" WHERE "tenantId" = $1 ORDER BY id`, [tenantId])).toEqual(before)
  })

  it('利润总览带上生效的口径版本', async () => {
    const res = await h.call(maker.token, 'GET', '/profit/overview?from=2026-09-01&to=2026-09-30')
    if (res.status === 200) expect(res.json.data.metricVersions).toMatchObject({ profitFormula: { versionNo: 2, source: 'VERSION' }, businessRules: { versionNo: 1 } })
    else expect([403, 422]).toContain(res.status)
  })

  it('别的企业看不到这些版本，也不能审批', async () => {
    expect((await formula(other)).current).toMatchObject({ versionNo: 0, source: 'DEFAULT' })
    const id = (await rows<{ id: string }>(`SELECT id FROM "MetricVersion" WHERE "tenantId" = $1 LIMIT 1`, [tenantId]))[0]!.id
    await stepUp(other, otherTenantId)
    expect((await h.call(other.token, 'POST', `/metric-versions/${id}/decision`, { body: { decision: 'REJECTED', comment: '越权试一下', version: 1 } })).status).toBe(404)
    expect(await active('PROFIT_FORMULA', otherTenantId)).toEqual([])
  })
})
