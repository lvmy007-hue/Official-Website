import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 企业设置（P5-10，真实数据库 + 完整应用 + worker 的读取代码）：
// 总览默认值与权限；基本信息修改（审计、版本冲突、数据口径时区与币种不可改）；数据保留与刷新策略（企业设置项的版本、审计、worker 读到同样的值）；
// 风险规则摘要；平台支持访问授权计数；企业隔离。

type Member = { userId: string; token: string }
const reason = '与财务和运营确认后调整'
const MINUTE = 60_000

describe('企业设置（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let otherTenantId: string
  let owner: Member
  let reader: Member
  let nobody: Member
  let other: Member
  let loadRetention: (db: unknown, tenantId: string) => Promise<Record<string, number> | null>
  let loadRefresh: (db: unknown, tenantId: string) => Promise<Record<string, unknown>>
  let allowed: (db: unknown, policy: Record<string, unknown>, connectionId: string, type: string, now?: Date) => Promise<boolean>

  const get = (member: Member) => h.call(member.token, 'GET', '/settings')
  const patch = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'PATCH', '/settings', { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const audits = (action: string, tid = tenantId) =>
    rows<{ resourceId: string; reason: string; beforeJson: any; afterJson: any }>(
      `SELECT "resourceId", reason, "beforeJson", "afterJson" FROM "AuditEvent" WHERE "tenantId" = $1 AND action = $2 AND "result" = 'SUCCEEDED' ORDER BY "occurredAt", id`,
      [tid, action],
    )
  const basicOf = async (member: Member = owner) => (await get(member)).json.data.basic

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'enterprise_settings' })
    const a = await h.createTenant('es-a')
    tenantId = a.tenantId
    const b = await h.createTenant('es-b')
    otherTenantId = b.tenantId
    owner = await h.createMember(tenantId, 'es-owner', ['settings.read', 'settings.write'])
    reader = await h.createMember(tenantId, 'es-reader', ['settings.read'])
    nobody = await h.createMember(tenantId, 'es-nobody', [])
    other = await h.createMember(otherTenantId, 'es-other', ['*'])

    base = new PrismaClient({ datasourceUrl: h.db.urlFor('enterprise_settings', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const policy = await import(/* @vite-ignore */ String('../../../worker/src/platform/tenant-policy'))
    loadRetention = policy.loadRetentionPolicy
    loadRefresh = policy.loadRefreshPolicy
    allowed = (await import(/* @vite-ignore */ String('../../../worker/src/listeners/schedule-jobs'))).refreshAllowed
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('没有 settings.read 是 403；只读成员看得到但 canWrite 为 false，也不能修改（403）', async () => {
    expect((await get(nobody)).status).toBe(403)
    expect((await patch(nobody, { section: 'retention' })).status).toBe(403)
    const view = await get(reader)
    expect(view.status).toBe(200)
    expect(view.json.data.canWrite).toBe(false)
    expect((await patch(reader, { section: 'basic', name: '新的企业名称', version: 0, reason })).status).toBe(403)
  })

  it('还没有保存过：数据保留与刷新策略都是系统默认，版本 0，没有“最近修改”；风险规则还没有；内部访问模式关闭', async () => {
    const data = (await get(owner)).json.data
    expect(data.canWrite).toBe(true)
    expect(data.basic).toMatchObject({ slug: 'tenant-es-a', dataTimezone: 'America/Los_Angeles', defaultCurrency: 'USD' })
    expect(data.retention).toMatchObject({ version: 0, updatedAt: null, updatedByName: null })
    expect(data.retention.items.map((item: { key: string; days: number; isDefault: boolean }) => [item.key, item.days, item.isDefault])).toEqual([
      ['rawReportDays', 400, true],
      ['exportFileDays', 7, true],
      ['customerInfoDays', 30, true],
    ])
    expect(data.refresh).toMatchObject({ version: 0, pausedCount: 0 })
    expect(data.refresh.items.every((item: { override: unknown }) => item.override === null)).toBe(true)
    expect(data.risk).toEqual({ total: 0, enabled: 0, lastChange: null })
    expect(data.internal).toMatchObject({ state: 'OFF', supportGrantsActive: 0, supportGrantsInUse: 0 })
    expect(await runWithTenant(tenantId, () => loadRetention(tenantDb, tenantId))).toBeNull() // 没有设置过：worker 沿用部署默认
    expect(await runWithTenant(tenantId, () => loadRefresh(tenantDb, tenantId))).toEqual({})
  })

  it('基本信息：改名称与本地时区，写审计（前后值与原因）；数据口径时区与币种改不动；版本过期 409；没变化 422；登录身份里的企业名同步变化', async () => {
    const before = await basicOf()
    const res = await patch(owner, { section: 'basic', name: '新的企业名称有限公司', localTimezone: 'Asia/Tokyo', version: before.version, reason, timezone: 'Asia/Tokyo', defaultCurrency: 'CNY' })
    expect(res.status).toBe(200)
    expect(res.json.data.section).toBe('basic')
    const after = await basicOf()
    expect(after).toMatchObject({ name: '新的企业名称有限公司', localTimezone: 'Asia/Tokyo', dataTimezone: 'America/Los_Angeles', defaultCurrency: 'USD' })
    expect(after.version).toBe(res.json.data.version)
    expect(after.version).toBeGreaterThan(before.version)
    expect((await audits('TENANT_PROFILE_UPDATED'))[0]).toMatchObject({
      resourceId: tenantId,
      reason,
      beforeJson: { name: '租户es-a', localTimezone: 'Asia/Shanghai' },
      afterJson: { name: '新的企业名称有限公司', localTimezone: 'Asia/Tokyo' },
    })
    expect((await h.call(owner.token, 'GET', '/auth/me')).json.data.tenant.name).toBe('新的企业名称有限公司')

    const stale = await patch(owner, { section: 'basic', name: '另一个名称有限公司', version: before.version, reason })
    expect(stale.status).toBe(409)
    expect((await basicOf()).name).toBe('新的企业名称有限公司')
    expect((await patch(owner, { section: 'basic', name: '新的企业名称有限公司', version: after.version, reason })).status).toBe(422)
    expect((await patch(owner, { section: 'basic', name: '甲', version: after.version, reason })).status).toBe(422)
    expect((await audits('TENANT_PROFILE_UPDATED')).length).toBe(1)
  })

  it('数据保留：首次保存要求版本 0，之后逐版本推进；审计带前后值；worker 读到同样的值；越界与缺项 422；版本过期 409', async () => {
    const values = { rawReportDays: 90, exportFileDays: 14, customerInfoDays: 7 }
    expect((await patch(owner, { section: 'retention', values, version: 5, reason })).status).toBe(409) // 还没有记录，却带了非 0 版本
    const first = await patch(owner, { section: 'retention', values, version: 0, reason })
    expect(first.status).toBe(200)
    expect(first.json.data).toEqual({ section: 'retention', version: 1 })
    const view = (await get(owner)).json.data.retention
    expect(view).toMatchObject({ version: 1, updatedByName: expect.any(String) })
    expect(view.items.map((item: { days: number }) => item.days)).toEqual([90, 14, 7])
    expect(await runWithTenant(tenantId, () => loadRetention(tenantDb, tenantId))).toEqual(values)

    const next = { ...values, rawReportDays: 120 }
    expect((await patch(owner, { section: 'retention', values: next, version: 0, reason })).status).toBe(409)
    expect((await patch(owner, { section: 'retention', values: next, version: 1, reason })).json.data.version).toBe(2)
    expect((await patch(owner, { section: 'retention', values: next, version: 2, reason })).status).toBe(422) // 没变化
    expect((await patch(owner, { section: 'retention', values: { ...values, customerInfoDays: 31 }, version: 2, reason })).status).toBe(422)
    expect((await patch(owner, { section: 'retention', values: { rawReportDays: 90 }, version: 2, reason })).status).toBe(422)
    const log = await audits('TENANT_SETTING_UPDATED')
    expect(log.map(row => row.resourceId)).toEqual(['retention.policy', 'retention.policy'])
    expect(log[1]).toMatchObject({ reason, beforeJson: { value: values }, afterJson: { value: next } })
  })

  it('刷新策略：暂停与放慢；恢复默认删掉对应项；worker 按策略放行；放慢只比内置更长；全部恢复后回到默认', async () => {
    const slow = { FBA_ORDERS: { mode: 'EVERY', minutes: 720 } }
    const res = await patch(owner, { section: 'refresh', changes: { ...slow, CATALOG_SYNC: { mode: 'PAUSED' } }, version: 0, reason })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ section: 'refresh', version: 1 })
    const view = (await get(owner)).json.data.refresh
    expect(view).toMatchObject({ version: 1, pausedCount: 1 })
    expect(view.items.find((item: { key: string }) => item.key === 'FBA_ORDERS')).toMatchObject({ valueText: '每 12 小时（已放慢）' })
    expect(view.items.find((item: { key: string }) => item.key === 'CATALOG_SYNC')).toMatchObject({ valueText: '已暂停定时同步' })

    const policy = await runWithTenant(tenantId, () => loadRefresh(tenantDb, tenantId))
    expect(policy).toEqual({ ...slow, CATALOG_SYNC: { mode: 'PAUSED' } })
    await runWithTenant(tenantId, async () => {
      expect(await allowed(tenantDb, policy, 'no-connection', 'CATALOG_SYNC')).toBe(false)
      expect(await allowed(tenantDb, policy, 'no-connection', 'FBA_ORDERS')).toBe(true) // 这个连接从没排过定时同步
      expect(await allowed(tenantDb, policy, 'no-connection', 'FBA_FINANCE')).toBe(true) // 没有设置的数据域
    })

    expect((await patch(owner, { section: 'refresh', changes: { FBA_INVENTORY: { mode: 'EVERY', minutes: 30 } }, version: 1, reason })).status).toBe(422)
    expect((await patch(owner, { section: 'refresh', changes: { FBA_ORDERS: { mode: 'EVERY', minutes: 720 } }, version: 1, reason })).status).toBe(422) // 没变化
    expect((await patch(owner, { section: 'refresh', changes: { FBA_ORDERS: { mode: 'DEFAULT' } }, version: 0, reason })).status).toBe(409)
    const restore = await patch(owner, { section: 'refresh', changes: { FBA_ORDERS: { mode: 'DEFAULT' }, CATALOG_SYNC: { mode: 'DEFAULT' } }, version: 1, reason })
    expect(restore.json.data.version).toBe(2)
    expect((await get(owner)).json.data.refresh).toMatchObject({ pausedCount: 0, items: expect.arrayContaining([expect.objectContaining({ key: 'CATALOG_SYNC', override: null })]) })
    expect(await runWithTenant(tenantId, () => loadRefresh(tenantDb, tenantId))).toEqual({})
  })

  it('放慢的判断用真实任务表：刚排过的数据域跳过，排得够久之前的放行', async () => {
    const connection = await insertRow(h.client, 'PlatformConnection', { id: 'es-conn', tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED' })
    const job = (id: string, minutesAgo: number, requestId = 'schedule') =>
      insertRow(h.client, 'SyncJob', {
        id,
        tenantId,
        connectionId: connection.id,
        type: 'FBA_ORDERS',
        status: 'SUCCEEDED',
        requestId,
        createdAt: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
      })
    const policy = { FBA_ORDERS: { mode: 'EVERY', minutes: 720 } }
    await runWithTenant(tenantId, async () => {
      await job('es-job-manual', 5, 'manual-request') // 手动同步不算定时
      expect(await allowed(tenantDb, policy, connection.id, 'FBA_ORDERS')).toBe(true)
    })
    await job('es-job-1', 360)
    await runWithTenant(tenantId, async () => expect(await allowed(tenantDb, policy, connection.id, 'FBA_ORDERS')).toBe(false)) // 6 小时前排过，不够 12 小时
    await h.client.query(`UPDATE "SyncJob" SET "createdAt" = $1 WHERE id = 'es-job-1'`, [new Date(Date.now() - 13 * 60 * MINUTE).toISOString()])
    await runWithTenant(tenantId, async () => expect(await allowed(tenantDb, policy, connection.id, 'FBA_ORDERS')).toBe(true))
  })

  it('风险规则摘要：规则总数、启用数，最近一次修改只认版本号大于 1 的记录；支持访问授权计数只含未撤销未过期的', async () => {
    const rule = (id: string, enabled: boolean) => insertRow(h.client, 'AlertRule', { id, tenantId, code: id, domain: 'ADS', name: `规则 ${id}`, conditionJson: '{}', scopeJson: '{}', enabled })
    await rule('es-r1', true)
    await rule('es-r2', true)
    await rule('es-r3', false)
    const version = (id: string, ruleId: string, versionNo: number, minutesAgo: number) =>
      insertRow(h.client, 'AlertRuleVersion', {
        id,
        tenantId,
        ruleId,
        versionNo,
        conditionJson: '{}',
        changedBy: 'u',
        changeReason: '调整阈值',
        createdAt: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
      })
    await version('es-v1', 'es-r1', 1, 1) // 预置版本不算修改
    expect((await get(owner)).json.data.risk).toEqual({ total: 3, enabled: 2, lastChange: null })
    await version('es-v2', 'es-r2', 2, 30)
    await version('es-v3', 'es-r1', 2, 10)
    const risk = (await get(owner)).json.data.risk
    expect(risk).toMatchObject({ total: 3, enabled: 2, lastChange: { ruleName: '规则 es-r1', versionNo: 2 } })

    const grant = (id: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'PlatformSupportAccess', {
        id,
        tenantId,
        grantedByUserId: owner.userId,
        reason: '协助排查',
        startsAt: new Date(Date.now() - 3600_000).toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        ...over,
      })
    await grant('es-g1', {})
    await grant('es-g2', { claimedAt: new Date().toISOString() })
    await grant('es-g3', { revokedAt: new Date().toISOString() })
    await grant('es-g4', { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    expect((await get(owner)).json.data.internal).toMatchObject({ supportGrantsActive: 2, supportGrantsInUse: 1 })
  })

  it('企业隔离：别的企业看不到这里保存的设置，也改不到；别的企业的修改只写自己的审计', async () => {
    const data = (await get(other)).json.data
    expect(data.basic.slug).toBe('tenant-es-b')
    expect(data.retention).toMatchObject({ version: 0 })
    expect(data.retention.items.map((item: { days: number }) => item.days)).toEqual([400, 7, 30])
    expect(data.risk.total).toBe(0)
    expect(data.internal).toMatchObject({ supportGrantsActive: 0 })
    const own = await patch(other, { section: 'retention', values: { rawReportDays: 365, exportFileDays: 7, customerInfoDays: 30 }, version: 0, reason })
    expect(own.json.data).toEqual({ section: 'retention', version: 1 }) // 自己的第一版，与上面企业无关
    expect((await get(owner)).json.data.retention.items.map((item: { days: number }) => item.days)).toEqual([120, 14, 7])
    expect((await audits('TENANT_SETTING_UPDATED', otherTenantId)).length).toBe(1)
    expect(await runWithTenant(otherTenantId, () => loadRetention(tenantDb, otherTenantId))).toMatchObject({ rawReportDays: 365 })
    await expect(runWithTenant(otherTenantId, () => loadRetention(tenantDb, tenantId))).rejects.toThrow('查询条件指定了其他租户') // 租户客户端不许读别的企业的行
  })
})
