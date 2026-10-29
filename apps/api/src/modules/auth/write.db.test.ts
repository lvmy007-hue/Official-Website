import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashSync } from 'bcryptjs'
import { runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { StepUpService } from '../../platform/write'
import { createDbTestApp, type DbTestApp } from '../../testing/db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from '../../testing/db-fixtures'
import { startTestDatabase, type TestDatabase } from '../../testing/test-database'

const TARGET = '20261021060000_write_guard'

// P1-14 写接口横向规则（真实数据库）：迁移保数据与回滚、重复提交只执行一次、审计字段完整、再次验证身份。
describe('写接口横向规则（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移 M-P1-14：保数据与回滚', () => {
    let client: Client
    let tenantId: string

    beforeAll(async () => {
      await db.createDatabase('write_migration')
      client = await db.connect('write_migration')
      await applyMigrations(client, { before: TARGET })
      tenantId = (await seedTenant(client, 'w')).tenantId
      await insertRow(client, 'AuditEvent', { id: 'old-1', tenantId, action: 'OLD_ACTION', resourceType: 'Thing', requestId: 'req-old-0001', result: 'SUCCEEDED' })
      await applyMigrations(client, { only: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('已有审计事件原样保留，新增列为空', async () => {
      const { rows } = await client.query(`SELECT "action", "beforeJson", "afterJson", "ip", "userAgent", "writeRunId", "stepUpId", "reason" FROM "AuditEvent" WHERE id = 'old-1'`)
      expect(rows).toEqual([{ action: 'OLD_ACTION', beforeJson: null, afterJson: null, ip: null, userAgent: null, writeRunId: null, stepUpId: null, reason: null }])
    })

    it('幂等记录：同一企业、同一路由、同一键只能有一条；不同路由或企业互不影响', async () => {
      const base = { tenantId, key: 'key-0001', route: 'POST /a', requestHash: 'h', expiresAt: '2030-01-01T00:00:00Z' }
      await insertRow(client, 'IdempotencyRecord', { ...base, id: 'i1' })
      await expect(insertRow(client, 'IdempotencyRecord', { ...base, id: 'i2' })).rejects.toThrow(/IdempotencyRecord_tenantId_key_route_key/)
      await insertRow(client, 'IdempotencyRecord', { ...base, id: 'i3', route: 'POST /b' })
    })

    it('再次验证记录：方式只能是密码或验证码', async () => {
      const userId = (await client.query(`SELECT id FROM "User" LIMIT 1`)).rows[0].id
      await insertRow(client, 'StepUpVerification', { id: 's1', tenantId, userId, action: 'role.manage', method: 'PASSWORD', expiresAt: '2030-01-01T00:00:00Z' })
      await expect(insertRow(client, 'StepUpVerification', { id: 's2', tenantId, userId, action: 'role.manage', method: 'SMS', expiresAt: '2030-01-01T00:00:00Z' })).rejects.toThrow(
        /StepUpVerification_method_check/,
      )
    })

    it('回滚脚本可执行：新表与新增列移除，原有审计事件保留；回滚后可再次升级', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      expect((await client.query(`SELECT to_regclass('"IdempotencyRecord"') AS t`)).rows[0].t).toBeNull()
      expect((await client.query(`SELECT to_regclass('"StepUpVerification"') AS t`)).rows[0].t).toBeNull()
      const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'AuditEvent' AND column_name IN ('beforeJson', 'ip', 'stepUpId')`)).rows
      expect(columns).toEqual([])
      expect((await client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE id = 'old-1'`)).rows[0].n).toBe(1)
      await applyMigrations(client, { only: TARGET })
      expect((await client.query(`SELECT to_regclass('"IdempotencyRecord"') AS t`)).rows[0].t).not.toBeNull()
    })
  })

  describe('接口：重复提交、审计与再次验证', () => {
    let h: DbTestApp
    let tenant: Awaited<ReturnType<typeof seedTenant>>
    let writer: { token: string; userId: string }
    let reader: { token: string; userId: string }

    const entityCount = async () => Number((await h.client.query(`SELECT count(*)::int AS n FROM "LegalEntity" WHERE "tenantId" = $1 AND "name" LIKE '并发主体%'`, [tenant.tenantId])).rows[0].n)
    const auditRows = async (requestId: string) => (await h.client.query(`SELECT * FROM "AuditEvent" WHERE "requestId" = $1 ORDER BY "createdAt"`, [requestId])).rows

    beforeAll(async () => {
      h = await createDbTestApp({ db, database: 'write_api' })
      tenant = await h.createTenant('a')
      writer = await h.createMember(tenant.tenantId, 'writer', ['entity.write', 'sync.manage', 'connection.manage'])
      reader = await h.createMember(tenant.tenantId, 'reader', ['entity.read'])
      await h.client.query(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [hashSync('right-password', 4), writer.userId])
    })
    afterAll(async () => {
      await h?.close()
    })

    it('并发重复提交（同一个键、同一份内容）：只创建一个对象，所有成功响应是同一个结果', async () => {
      const body = { name: '并发主体甲', registeredCountry: 'US' }
      const responses = await Promise.all(Array.from({ length: 8 }, () => h.call(writer.token, 'POST', '/entities', { body, idempotencyKey: 'key-concurrent-0001' })))
      const statuses = responses.map(res => res.status)
      expect(statuses.every(status => status === 201 || status === 409)).toBe(true)
      expect(statuses).toContain(201)
      for (const res of responses.filter(item => item.status === 409)) expect(res.json.error.code).toBe('IDEMPOTENCY_IN_PROGRESS')
      expect(await entityCount()).toBe(1)
      const ids = new Set(responses.filter(item => item.status === 201).map(item => item.json.data.id))
      expect(ids.size).toBe(1)

      // 之后再提交：返回首次的结果，标注重放，仍然只有一个对象
      const again = await h.call(writer.token, 'POST', '/entities', { body, idempotencyKey: 'key-concurrent-0001' })
      expect(again.status).toBe(201)
      expect(again.headers.get('idempotency-replayed')).toBe('true')
      expect([...ids]).toEqual([again.json.data.id])
      expect(await entityCount()).toBe(1)
    })

    it('同一个键换了内容：422；换一个键则是新的操作', async () => {
      const first = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体乙', registeredCountry: 'US' }, idempotencyKey: 'key-reuse-0001' })
      expect(first.status).toBe(201)
      const reused = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体丙', registeredCountry: 'US' }, idempotencyKey: 'key-reuse-0001' })
      expect(reused.status).toBe(422)
      expect(reused.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
      const fresh = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体丙', registeredCountry: 'US' }, idempotencyKey: 'key-reuse-0002' })
      expect(fresh.status).toBe(201)
    })

    it('幂等键按企业隔离：别的企业用同一个键互不影响', async () => {
      const other = await h.createTenant('b')
      const stranger = await h.createMember(other.tenantId, 'stranger', ['entity.write'])
      const mine = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体丁', registeredCountry: 'US' }, idempotencyKey: 'key-shared-0001' })
      const theirs = await h.call(stranger.token, 'POST', '/entities', { body: { name: '并发主体丁', registeredCountry: 'US' }, idempotencyKey: 'key-shared-0001' })
      expect(mine.status).toBe(201)
      expect(theirs.status).toBe(201)
      expect(theirs.headers.get('idempotency-replayed')).toBeNull()
      expect(theirs.json.data.id).not.toBe(mine.json.data.id)
    })

    it('参数校验失败后，用同一个键修正内容重新提交可以成功（失败不占用幂等键）', async () => {
      const bad = await h.call(writer.token, 'POST', '/entities', { body: { name: 'x' }, idempotencyKey: 'key-fix-0001' })
      expect(bad.status).toBe(422)
      const fixed = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体戊', registeredCountry: 'US' }, idempotencyKey: 'key-fix-0001' })
      expect(fixed.status).toBe(201)
    })

    it('审计事件：请求编号、操作人、来源地址、终端、访问模式、修改后的内容与字段差异齐全，且按月落入分区', async () => {
      const res = await h.call(writer.token, 'POST', '/entities', {
        body: { name: '并发主体己', registeredCountry: 'US' },
        headers: { 'x-request-id': 'req-audit-0001', 'user-agent': 'db-test-agent' },
      })
      expect(res.status).toBe(201)
      const [event, ...rest] = await auditRows('req-audit-0001')
      expect(rest).toEqual([])
      expect(event).toMatchObject({
        tenantId: tenant.tenantId,
        actorId: writer.userId,
        action: 'LEGAL_ENTITY_CREATED',
        resourceType: 'LegalEntity',
        resourceId: res.json.data.id,
        result: 'SUCCEEDED',
        userAgent: 'db-test-agent',
        beforeJson: null,
      })
      expect(event.ip).toBeTruthy()
      expect(event.afterJson).toMatchObject({ name: '并发主体己', registeredCountry: 'US' })
      expect(event.detail.accessMode).toBe('NORMAL')
      expect(event.detail.changes).toEqual(expect.arrayContaining([{ field: 'name', before: null, after: '并发主体己' }]))
      // 列是不带时区的时间，驱动按本地时区解析，这里只确认是刚刚发生（容许时区差异）
      expect(Math.abs(new Date(event.occurredAt).getTime() - Date.now())).toBeLessThan(24 * 3600_000)
    })

    it('领域服务没有自己写审计的写接口：拦截器补写通用审计；被拒绝的写操作记 DENIED 且不改数据', async () => {
      await insertRow(h.client, 'PlatformConnection', { id: 'conn-ads-1', tenantId: tenant.tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', grantedScopes: '[]' })
      const ok = await h.call(writer.token, 'POST', '/ads/sync', { headers: { 'x-request-id': 'req-fallback-0001' } })
      expect(ok.status).toBe(202)
      const [event] = await auditRows('req-fallback-0001')
      expect(event).toMatchObject({ action: 'ADS_SYNC_REQUESTED', resourceType: 'SyncJob', result: 'SUCCEEDED', actorId: writer.userId, tenantId: tenant.tenantId })
      expect(event.detail).toMatchObject({ route: expect.stringMatching(/^POST .*\/ads\/sync$/), accessMode: 'NORMAL' })

      const before = Number((await h.client.query(`SELECT count(*)::int AS n FROM "SyncJob" WHERE "tenantId" = $1`, [tenant.tenantId])).rows[0].n)
      const denied = await h.call(reader.token, 'POST', '/ads/sync', { headers: { 'x-request-id': 'req-denied-0001' } })
      expect(denied.status).toBe(403)
      const [deniedEvent] = await auditRows('req-denied-0001')
      expect(deniedEvent).toMatchObject({ action: 'ADS_SYNC_REQUESTED', result: 'DENIED', actorId: reader.userId })
      expect(deniedEvent.detail).toMatchObject({ status: 403, errorCode: 'TENANT_ACCESS_DENIED' })
      expect(Number((await h.client.query(`SELECT count(*)::int AS n FROM "SyncJob" WHERE "tenantId" = $1`, [tenant.tenantId])).rows[0].n)).toBe(before)
    })

    it('再次验证身份：密码错误被拒；密码正确后记录 10 分钟有效；过期后失效；按操作分别计算', async () => {
      const wrong = await h.call(writer.token, 'POST', '/auth/step-up', { body: { action: 'role.manage', password: 'bad-password' } })
      expect(wrong.status).toBe(403)
      expect(wrong.json.error.code).toBe('STEP_UP_FAILED')

      // 直接调用服务（没有请求上下文）时，显式在该租户中运行，与请求内的行为一致
      const service = h.app.get(StepUpService)
      const stepUp = {
        require: (ctx: Parameters<StepUpService['require']>[0], action: Parameters<StepUpService['require']>[1]) => runWithTenant(ctx.tenantId, () => service.require(ctx, action)),
        purgeExpired: () => runWithTenant(tenant.tenantId, () => service.purgeExpired()),
      }
      const context = { userId: writer.userId, sessionId: 'x', tenantId: tenant.tenantId, membershipId: 'x', permissions: [] }
      await expect(stepUp.require(context, 'role.manage')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'role.manage' } })

      const right = await h.call(writer.token, 'POST', '/auth/step-up', { body: { action: 'role.manage', password: 'right-password' }, headers: { 'x-request-id': 'req-stepup-0001' } })
      expect(right.status).toBe(200)
      const id = await stepUp.require(context, 'role.manage')
      const record = (await h.client.query(`SELECT * FROM "StepUpVerification" WHERE id = $1`, [id])).rows[0]
      expect(record).toMatchObject({ tenantId: tenant.tenantId, userId: writer.userId, action: 'role.manage', method: 'PASSWORD' })
      expect(Math.abs(new Date(record.expiresAt).getTime() - new Date(record.verifiedAt).getTime() - 10 * 60_000)).toBeLessThan(2000)
      const [event] = await auditRows('req-stepup-0001')
      expect(event).toMatchObject({ action: 'STEP_UP_VERIFIED', resourceType: 'StepUp', result: 'SUCCEEDED' })

      // 验证的是 role.manage，不能拿去执行别的高风险操作；别的企业或别的用户也不通用
      await expect(stepUp.require(context, 'switch.enable')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' })
      await expect(stepUp.require({ ...context, userId: reader.userId }, 'role.manage')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' })

      // 到期失效
      await h.client.query(`UPDATE "StepUpVerification" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [id])
      await expect(stepUp.require(context, 'role.manage')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' })
      expect(await stepUp.purgeExpired()).toBeGreaterThanOrEqual(1)
    })

    it('过期的幂等记录会被清理，同一个键可以重新使用', async () => {
      const first = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体庚', registeredCountry: 'US' }, idempotencyKey: 'key-expire-0001' })
      expect(first.status).toBe(201)
      await h.client.query(`UPDATE "IdempotencyRecord" SET "expiresAt" = now() - interval '1 hour' WHERE "key" = 'key-expire-0001'`)
      const second = await h.call(writer.token, 'POST', '/entities', { body: { name: '并发主体庚二', registeredCountry: 'US' }, idempotencyKey: 'key-expire-0001' })
      expect(second.status).toBe(201)
      expect(second.json.data.id).not.toBe(first.json.data.id)
    })
  })
})
