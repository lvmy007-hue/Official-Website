import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 企业设置（P5-10）接口：权限先于参数、读取形状、三种修改的校验与审计。真实库行为见 testing/enterprise-settings.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
const saved = { ...process.env }
afterEach(async () => {
  await harness?.close()
  harness = undefined
  process.env = { ...saved }
})

const updatedAt = new Date('2026-10-20T08:00:00.000Z')

function prismaFor(permissions: string[], over: { settings?: Array<Record<string, unknown>>; tenant?: Record<string, unknown> } = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenant: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ name: '示例企业', slug: 'demo', mode: 'LIVE', timezone: 'America/Los_Angeles', localTimezone: 'Asia/Shanghai', defaultCurrency: 'USD', updatedAt, ...over.tenant }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    tenantSetting: {
      findMany: vi.fn().mockResolvedValue(over.settings ?? []),
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { key: string } }) => (over.settings ?? []).find(row => row.key === where.key) ?? null),
      create: vi.fn().mockResolvedValue({ version: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    alertRule: { count: vi.fn().mockResolvedValueOnce(28).mockResolvedValueOnce(25) },
    alertRuleVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    platformSupportAccess: { count: vi.fn().mockResolvedValue(0) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  }
  prisma.membership.findMany = vi.fn().mockResolvedValue([{ userId: 'user-9', user: { displayName: '张三', email: 'z@example.com' } }])
  return prisma
}

const reason = '与财务确认后调整'

describe('GET /settings', () => {
  it('没有 settings.read 返回 403；有则返回五块内容，只读成员 canWrite 为 false', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('GET', '/settings')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['settings.read']))
    const res = await harness.call('GET', '/settings')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.canWrite).toBe(false)
    expect(data.basic).toMatchObject({ name: '示例企业', dataTimezone: 'America/Los_Angeles', localTimezone: 'Asia/Shanghai', defaultCurrency: 'USD', version: updatedAt.getTime() })
    expect(data.retention.items.map((item: { key: string; days: number }) => [item.key, item.days])).toEqual([
      ['rawReportDays', 400],
      ['exportFileDays', 7],
      ['customerInfoDays', 30],
    ])
    expect(data.retention).toMatchObject({ version: 0, updatedAt: null, updatedByName: null, auditLog: { value: '不自动清理，只增不删' } })
    expect(data.refresh.items).toHaveLength(19)
    expect(data.refresh).toMatchObject({
      version: 0,
      pausedCount: 0,
      items: expect.arrayContaining([expect.objectContaining({ key: 'FBA_ORDERS', valueText: '每 6 小时（系统内置）', override: null })]),
    })
    expect(data.risk).toEqual({ total: 28, enabled: 25, lastChange: null })
    expect(data.internal).toMatchObject({ state: 'OFF', supportGrantsActive: 0 })
  })

  it('读取已保存的设置：策略还原、最近修改人显示名；库里的坏值按默认处理', async () => {
    const settings = [
      { key: 'retention.policy', valueJson: { rawReportDays: 90, exportFileDays: 14, customerInfoDays: 7 }, version: 3, updatedAt, updatedBy: 'user-9' },
      { key: 'refresh.policy', valueJson: { FBA_ORDERS: { mode: 'EVERY', minutes: 720 }, FBA_FINANCE: { mode: 'PAUSED' }, NOPE: { mode: 'PAUSED' } }, version: 2, updatedAt, updatedBy: 'gone' },
    ]
    harness = await createTestApp(prismaFor(['settings.read', 'settings.write'], { settings }))
    const data = (await harness.call('GET', '/settings')).json.data
    expect(data.canWrite).toBe(true)
    expect(data.retention).toMatchObject({ version: 3, updatedByName: '张三' })
    expect(data.retention.items.map((item: { days: number }) => item.days)).toEqual([90, 14, 7])
    expect(data.refresh).toMatchObject({ version: 2, pausedCount: 1, updatedByName: '已离开的成员' })
    expect(data.refresh.items.find((item: { key: string }) => item.key === 'FBA_ORDERS')).toMatchObject({ valueText: '每 12 小时（已放慢）', override: { mode: 'EVERY', minutes: 720 } })
    await harness.close()
    harness = await createTestApp(prismaFor(['settings.read'], { settings: [{ ...settings[0], valueJson: { rawReportDays: 'x' } }] }))
    expect((await harness.call('GET', '/settings')).json.data.retention.items.map((item: { days: number }) => item.days)).toEqual([400, 7, 30])
  })

  it('内部访问模式：关闭、对本企业开启、对别的企业开启（不透露是谁）、配置不合法', async () => {
    const state = async (env: Record<string, string>) => {
      Object.assign(process.env, { INTERNAL_DIRECT_ACCESS: undefined, INTERNAL_ACCESS_TENANT_ID: undefined, INTERNAL_ACCESS_ALLOWED_CIDRS: undefined, ...env })
      for (const key of Object.keys(process.env)) if (process.env[key] === undefined) delete process.env[key]
      harness = await createTestApp(prismaFor(['settings.read']))
      const data = (await harness.call('GET', '/settings')).json.data.internal
      await harness.close()
      harness = undefined
      return data
    }
    const on = { INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8,192.168.0.0/16' }
    expect(await state({})).toMatchObject({ state: 'OFF', roleId: null })
    expect(await state({ ...on, INTERNAL_ACCESS_TENANT_ID: 'tenant-1' })).toEqual({
      state: 'ON_THIS_TENANT',
      roleId: 'preset-readonly',
      allowedRangeCount: 2,
      gatewayHeaderRequired: false,
      supportGrantsActive: 0,
      supportGrantsInUse: 0,
    })
    const other = await state({ ...on, INTERNAL_ACCESS_TENANT_ID: 'tenant-other' })
    expect(other).toMatchObject({ state: 'ON_OTHER_TENANT', roleId: null, allowedRangeCount: null })
    expect(JSON.stringify(other)).not.toContain('tenant-other')
    expect((await state({ INTERNAL_DIRECT_ACCESS: 'true' })).state).toBe('MISCONFIGURED')
  })

  it('最近一次规则修改来自版本号大于 1 的规则版本', async () => {
    const prisma = prismaFor(['settings.read'])
    prisma.alertRuleVersion.findFirst.mockResolvedValue({ versionNo: 3, createdAt: updatedAt, rule: { name: '库存断货预警' } })
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/settings')).json.data.risk.lastChange).toEqual({ ruleName: '库存断货预警', versionNo: 3, changedAt: updatedAt.toISOString() })
    expect(prisma.alertRuleVersion.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', versionNo: { gt: 1 } })
  })
})

describe('PATCH /settings：权限与校验', () => {
  it('没有 settings.write 返回 403（先于参数校验）；缺原因 422；不认识的页签 422', async () => {
    harness = await createTestApp(prismaFor(['settings.read']))
    expect((await harness.call('PATCH', '/settings', { body: { section: 'nope' } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['settings.write']))
    const patch = (body: unknown) => harness!.call('PATCH', '/settings', { body })
    expect((await patch({ section: 'basic', name: '新企业名称', version: updatedAt.getTime() })).status).toBe(422)
    expect((await patch({ section: 'nope', version: 0, reason })).status).toBe(422)
    expect((await patch({ section: 'retention', values: { rawReportDays: 1, exportFileDays: 7, customerInfoDays: 30 }, version: 0, reason })).status).toBe(422)
    expect((await patch({ section: 'retention', values: { rawReportDays: 90, exportFileDays: 7, customerInfoDays: 60 }, version: 0, reason })).status).toBe(422)
    expect((await patch({ section: 'refresh', changes: { FBA_ORDERS: { mode: 'EVERY', minutes: 60 } }, version: 0, reason })).status).toBe(422)
    expect((await patch({ section: 'refresh', changes: { NOPE: { mode: 'PAUSED' } }, version: 0, reason })).status).toBe(422)
  })
})

describe('PATCH /settings：基本信息', () => {
  it('修改名称与本地时区：按版本条件更新企业记录，写审计（前后值与原因），返回新版本', async () => {
    const prisma = prismaFor(['settings.write'])
    prisma.tenant.findUniqueOrThrow.mockResolvedValueOnce({ name: '示例企业', localTimezone: 'Asia/Shanghai', updatedAt }).mockResolvedValueOnce({ updatedAt: new Date('2026-10-25T09:00:00.000Z') })
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/settings', { body: { section: 'basic', name: '新企业名称', localTimezone: 'Asia/Tokyo', version: updatedAt.getTime(), reason } })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ section: 'basic', version: new Date('2026-10-25T09:00:00.000Z').getTime() })
    expect(prisma.tenant.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'tenant-1', updatedAt }, data: { name: '新企业名称', localTimezone: 'Asia/Tokyo' } })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'TENANT_PROFILE_UPDATED', resourceType: 'Tenant', resourceId: 'tenant-1', reason })
  })

  it('没有任何变化 422；版本过期 409；数据口径时区与显示币种不接受修改', async () => {
    const prisma = prismaFor(['settings.write'])
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ name: '示例企业', localTimezone: 'Asia/Shanghai', updatedAt })
    harness = await createTestApp(prisma)
    const patch = (body: Record<string, unknown>) => harness!.call('PATCH', '/settings', { body: { section: 'basic', version: updatedAt.getTime(), reason, ...body } })
    expect((await patch({ name: '示例企业' })).status).toBe(422)
    prisma.tenant.updateMany.mockResolvedValue({ count: 0 })
    const conflict = await patch({ name: '新企业名称' })
    expect(conflict.status).toBe(409)
    expect(prisma.auditEvent.create).not.toHaveBeenCalled()
    prisma.tenant.updateMany.mockClear()
    await patch({ name: '新企业名称', timezone: 'Asia/Tokyo', defaultCurrency: 'CNY' })
    expect(prisma.tenant.updateMany.mock.calls[0][0].data).toEqual({ name: '新企业名称', localTimezone: 'Asia/Shanghai' })
  })
})

describe('PATCH /settings：数据保留与刷新策略', () => {
  const values = { rawReportDays: 90, exportFileDays: 14, customerInfoDays: 7 }

  it('数据保留：首次保存要求版本 0；写入企业设置项并记审计；与当前相同 422；版本不一致 409', async () => {
    const prisma = prismaFor(['settings.write'])
    harness = await createTestApp(prisma)
    const patch = (body: Record<string, unknown>) => harness!.call('PATCH', '/settings', { body: { section: 'retention', values, version: 0, reason, ...body } })
    const res = await patch({})
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ section: 'retention', version: 1 })
    expect(prisma.tenantSetting.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', key: 'retention.policy', valueJson: values, updatedBy: 'user-1' })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'TENANT_SETTING_UPDATED', resourceId: 'retention.policy', reason })
    expect((await patch({ values: { rawReportDays: 400, exportFileDays: 7, customerInfoDays: 30 } })).status).toBe(422) // 与默认值相同
    prisma.tenantSetting.findFirst.mockImplementation(async () => ({ id: 's1', version: 3, valueJson: values }))
    expect((await patch({ version: 3 })).status).toBe(422) // 与已保存的相同
    prisma.tenantSetting.updateMany.mockResolvedValue({ count: 0 })
    const conflict = await patch({ values: { ...values, rawReportDays: 120 }, version: 2 })
    expect(conflict.status).toBe(409)
  })

  it('刷新策略：暂停与放慢合并进现有记录，恢复默认删除对应项；全部恢复后记录里只剩空对象', async () => {
    const prisma = prismaFor(['settings.write'], {
      settings: [{ id: 's2', key: 'refresh.policy', valueJson: { FBA_FINANCE: { mode: 'PAUSED' }, TAX_SYNC: { mode: 'EVERY', minutes: 2880 } }, version: 4 }],
    })
    harness = await createTestApp(prisma)
    const patch = (changes: unknown, version = 4) => harness!.call('PATCH', '/settings', { body: { section: 'refresh', changes, version, reason } })
    const res = await patch({ FBA_ORDERS: { mode: 'EVERY', minutes: 720 }, FBA_FINANCE: { mode: 'DEFAULT' }, CATALOG_SYNC: { mode: 'PAUSED' } })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ section: 'refresh', version: 5 })
    expect(prisma.tenantSetting.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 's2', version: 4 },
      data: { valueJson: { TAX_SYNC: { mode: 'EVERY', minutes: 2880 }, FBA_ORDERS: { mode: 'EVERY', minutes: 720 }, CATALOG_SYNC: { mode: 'PAUSED' } } },
    })
    expect((await patch({ FBA_FINANCE: { mode: 'PAUSED' } })).status).toBe(422) // 已经是暂停
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'TENANT_SETTING_UPDATED', resourceId: 'refresh.policy' })
  })
})
