import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickEffectiveRate, resolveRateOn, type FxRow } from '@nova/api-contracts'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const today = new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const row = (over: Record<string, unknown>) => ({
  id: 'fx-1',
  rate: '7.10000000',
  source: 'FRANKFURTER_BLENDED',
  isFallback: false,
  isManualOverride: false,
  lockedByPeriodId: null,
  createdAt: new Date(),
  overrideReason: null,
  overriddenBy: null,
  quoteCurrency: 'CNY',
  rateDate: new Date(`${today}T00:00:00Z`),
  ...over,
})

function prismaFor(permissions: string[], over: Record<string, unknown> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ version: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    fxRate: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'fx-new', ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, ...data })),
      delete: vi.fn().mockResolvedValue({}),
    },
    fxSourceConfig: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    membership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    stepUpVerification: { findFirst: vi.fn().mockResolvedValue({ id: 'su-1' }), create: vi.fn() },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...over,
  }
  return prisma
}

const override = { kind: 'override', quoteCurrency: 'CNY', rateDate: today, rate: 7.2345, reason: '财务口径调整' }

describe('汇率读取', () => {
  it('需要 settings.read；没有任何汇率时如实返回空曲线与“尚未获取”的来源状态，不造数据', async () => {
    harness = await createTestApp(prismaFor(['settings.read']))
    const res = await harness.call('GET', '/settings/fx')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ baseCurrency: 'USD', currencies: ['CNY'], quote: 'CNY', curve: [], overrides: [] })
    expect(res.json.data.latest).toEqual([{ currency: 'CNY', rateDate: null, rate: null, source: null, isFallback: false, isManualOverride: false }])
    expect(res.json.data.sources.map((item: { role: string; provider: string; lastStatus: unknown }) => [item.role, item.provider, item.lastStatus])).toEqual([
      ['PRIMARY', 'FRANKFURTER_BLENDED', null],
      ['BACKUP', 'FRANKFURTER_ECB', null],
    ])
    await harness.close()
    harness = await createTestApp(prismaFor(['orders.read']))
    expect((await harness.call('GET', '/settings/fx')).status).toBe(403)
  })

  it('同一天有手工覆盖与获取值时，曲线与最新值取手工覆盖；曲线标出回退与覆盖', async () => {
    const rows = [row({ id: 'a', rate: '7.10000000' }), row({ id: 'b', source: 'MANUAL', rate: '7.25000000', isManualOverride: true, overrideReason: '口径', overriddenBy: 'user-1' })]
    harness = await createTestApp(prismaFor(['settings.read'], { fxRate: { findMany: vi.fn().mockResolvedValue(rows) } }))
    const res = await harness.call('GET', '/settings/fx?days=30')
    expect(res.json.data.curve).toEqual([{ date: today, rate: 7.25, source: 'MANUAL', isFallback: false, isManualOverride: true }])
    expect(res.json.data.latest[0]).toMatchObject({ currency: 'CNY', rate: 7.25, source: 'MANUAL', isManualOverride: true })
    expect(res.json.data.overrides[0]).toMatchObject({ id: 'a', rate: 7.1, locked: false })
  })

  it('选择了未加入的币种返回 422；天数超出范围返回 422', async () => {
    harness = await createTestApp(prismaFor(['settings.read']))
    expect((await harness.call('GET', '/settings/fx?quote=EUR')).status).toBe(422)
    expect((await harness.call('GET', '/settings/fx?days=3')).status).toBe(422)
    expect((await harness.call('GET', '/settings/fx?days=999')).status).toBe(422)
  })
})

describe('手工覆盖汇率', () => {
  it('新增覆盖：需要 settings.fx.write 与再次验证；审计含原因、覆盖前后的值', async () => {
    const prisma = prismaFor(['settings.fx.write'], { fxRate: undefined })
    prisma.fxRate = { ...prismaFor([]).fxRate, findMany: vi.fn().mockResolvedValue([row({ id: 'a', rate: '7.10000000' })]) }
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/settings/fx', { body: override })
    expect(res.status).toBe(200)
    expect(prisma.fxRate.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 'tenant-1',
      baseCurrency: 'USD',
      quoteCurrency: 'CNY',
      source: 'MANUAL',
      rate: '7.23450000',
      isManualOverride: true,
      overriddenBy: 'user-1',
      overrideReason: '财务口径调整',
    })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'FX_RATE_OVERRIDDEN',
      reason: '财务口径调整',
      beforeJson: { rate: 7.1 },
      afterJson: { rate: 7.2345, source: 'MANUAL' },
    })
  })

  it('没有再次验证返回 403；没有权限返回 403；参数不合法返回 422；都不写库', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    prisma.stepUpVerification.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    const noStepUp = await harness.call('POST', '/settings/fx', { body: override })
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.json.error.code).toBe('STEP_UP_REQUIRED')
    prisma.stepUpVerification.findFirst.mockResolvedValue({ id: 'su-1' })
    for (const bad of [
      { ...override, rate: -1 },
      { ...override, reason: '' },
      { ...override, quoteCurrency: 'USD' },
      { ...override, rateDate: '2026-13-40' },
    ]) {
      expect((await harness.call('POST', '/settings/fx', { body: bad })).status).toBe(422)
    }
    expect(prisma.fxRate.create).not.toHaveBeenCalled()
    await harness.close()
    harness = await createTestApp(prismaFor(['settings.read']))
    expect((await harness.call('POST', '/settings/fx', { body: override })).status).toBe(403)
  })

  it('日期不能晚于今天、不能早于 730 天前、币种必须已加入；已被关账锁定的日期不能覆盖', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    harness = await createTestApp(prisma)
    const future = await harness.call('POST', '/settings/fx', { body: { ...override, rateDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) } })
    expect(future.status).toBe(422)
    expect((await harness.call('POST', '/settings/fx', { body: { ...override, rateDate: daysAgo(800) } })).status).toBe(422)
    expect((await harness.call('POST', '/settings/fx', { body: { ...override, quoteCurrency: 'EUR' } })).status).toBe(422)
    prisma.fxRate.findMany.mockResolvedValue([row({ lockedByPeriodId: 'period-1' })])
    const locked = await harness.call('POST', '/settings/fx', { body: override })
    expect(locked.status).toBe(409)
    expect(locked.json.error.message).toContain('锁定')
    expect(prisma.fxRate.create).not.toHaveBeenCalled()
  })

  it('已有手工覆盖时更新同一条，不重复创建', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    prisma.fxRate.findMany.mockResolvedValue([row({ id: 'manual-1', source: 'MANUAL', isManualOverride: true, rate: '7.00000000' })])
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/settings/fx', { body: override })).status).toBe(200)
    expect(prisma.fxRate.update).toHaveBeenCalledTimes(1)
    expect(prisma.fxRate.create).not.toHaveBeenCalled()
  })

  it('撤销覆盖：只能撤销手工覆盖；已锁定的不能撤销', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    prisma.fxRate.findFirst.mockResolvedValue(row({ id: 'manual-1', source: 'MANUAL', isManualOverride: true }))
    harness = await createTestApp(prisma)
    expect((await harness.call('DELETE', '/settings/fx/overrides/manual-1')).status).toBe(200)
    expect(prisma.fxRate.delete).toHaveBeenCalledWith({ where: { id: 'manual-1' } })
    prisma.fxRate.findFirst.mockResolvedValue(row({ id: 'manual-2', isManualOverride: true, lockedByPeriodId: 'p1' }))
    expect((await harness.call('DELETE', '/settings/fx/overrides/manual-2')).status).toBe(409)
    prisma.fxRate.findFirst.mockResolvedValue(null)
    expect((await harness.call('DELETE', '/settings/fx/overrides/none')).status).toBe(404)
  })
})

describe('汇率来源与附加币种', () => {
  const sourceBody = { kind: 'source', primary: { provider: 'FRANKFURTER_ECB' }, backup: { provider: 'FRANKFURTER_BLENDED' }, reason: '改用央行通道为主' }

  it('选择来源：首次创建主源与备源；审计带前后；来源地址必须在白名单内', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/settings/fx', { body: sourceBody })
    expect(res.status).toBe(200)
    expect(prisma.fxSourceConfig.create.mock.calls.map((call: [{ data: { role: string; provider: string } }]) => [call[0].data.role, call[0].data.provider])).toEqual([
      ['PRIMARY', 'FRANKFURTER_ECB'],
      ['BACKUP', 'FRANKFURTER_BLENDED'],
    ])
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'FX_SOURCE_CHANGED', reason: '改用央行通道为主' })
    const bad = await harness.call('POST', '/settings/fx', { body: { ...sourceBody, primary: { provider: 'FRANKFURTER_ECB', pathTemplate: 'https://evil.example.com/{base}/{quote}' } } })
    expect(bad.status).toBe(422)
    expect(bad.json.error.fieldErrors.primary[0]).toContain('主机')
  })

  it('换了来源会清零失败计数；没换则保留', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    prisma.fxSourceConfig.findMany.mockResolvedValue([
      { id: 's1', role: 'PRIMARY', provider: 'FRANKFURTER_BLENDED', pathTemplate: 'https://api.frankfurter.dev/v2/rate/{base}/{quote}' },
      { id: 's2', role: 'BACKUP', provider: 'FRANKFURTER_ECB', pathTemplate: 'https://api.frankfurter.dev/v2/providers/ecb/rate/{base}/{quote}' },
    ])
    harness = await createTestApp(prisma)
    const same = await harness.call('POST', '/settings/fx', { body: { kind: 'source', primary: { provider: 'FRANKFURTER_BLENDED' }, backup: { provider: 'FRANKFURTER_ECB' }, reason: '重新确认来源' } })
    expect(same.status).toBe(200)
    expect(prisma.fxSourceConfig.update.mock.calls[0][0].data).not.toHaveProperty('consecutiveFailures')
    prisma.fxSourceConfig.update.mockClear()
    await harness.call('POST', '/settings/fx', { body: sourceBody })
    expect(prisma.fxSourceConfig.update.mock.calls[0][0].data).toMatchObject({ provider: 'FRANKFURTER_ECB', consecutiveFailures: 0, lastStatus: null })
  })

  it('附加币种：写入企业设置项，审计带前后；不合法币种返回 422', async () => {
    const prisma = prismaFor(['settings.fx.write'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/settings/fx/currencies', { body: { currencies: ['eur', 'GBP', 'EUR'], reason: '采购用到欧元与英镑' } })
    expect(res.status).toBe(200)
    expect(res.json.data.currencies).toEqual(['EUR', 'GBP'])
    expect(prisma.tenantSetting.create.mock.calls[0][0].data).toMatchObject({ key: 'fx.extraCurrencies', valueJson: ['EUR', 'GBP'] })
    expect((await harness.call('POST', '/settings/fx/currencies', { body: { currencies: ['USD'], reason: '不合法' } })).status).toBe(422)
  })

  it('立即获取：入队后台任务，返回 202', async () => {
    harness = await createTestApp(prismaFor(['settings.fx.write']))
    const res = await harness.call('POST', '/settings/fx/refresh')
    expect(res.status).toBe(202)
    expect(harness.queue.add).toHaveBeenCalledWith('notifications', expect.objectContaining({ tenantId: 'tenant-1', kind: 'fx-fetch' }), expect.stringContaining('fx-fetch:tenant-1:'))
  })
})

describe('汇率选取（纯函数）', () => {
  const r = (rateDate: string, over: Partial<FxRow> = {}): FxRow => ({ rateDate, rate: 7, source: 'FRANKFURTER_BLENDED', isFallback: false, isManualOverride: false, ...over })

  it('手工覆盖优先，其次是实际获取，最后才是回退值', () => {
    expect(pickEffectiveRate([r('2026-10-20', { isFallback: true, rate: 1 }), r('2026-10-20', { rate: 2 }), r('2026-10-20', { isManualOverride: true, rate: 3 })])?.rate).toBe(3)
    expect(pickEffectiveRate([r('2026-10-20', { isFallback: true, rate: 1 }), r('2026-10-20', { rate: 2 })])?.rate).toBe(2)
    expect(pickEffectiveRate([])).toBeUndefined()
  })

  it('当天缺失时向前沿用，最多 10 天；超出视为缺失', () => {
    const byDate = new Map([['2026-10-16', r('2026-10-16', { rate: 7.1 })]])
    expect(resolveRateOn('2026-10-16', byDate)).toMatchObject({ usedDate: '2026-10-16', carriedForward: false })
    expect(resolveRateOn('2026-10-19', byDate)).toMatchObject({ usedDate: '2026-10-16', carriedForward: true })
    expect(resolveRateOn('2026-10-26', byDate)).toMatchObject({ usedDate: '2026-10-16', carriedForward: true })
    expect(resolveRateOn('2026-10-27', byDate)).toBeNull()
    expect(resolveRateOn('2026-10-10', byDate)).toBeNull()
  })
})
