import { describe, expect, it, vi } from 'vitest'
import { FX_PROVIDERS } from '@nova/api-contracts'
import { fetchFxForAllTenants, fetchFxForTenant, parseQuote, quoteUrl, type FxFetchDb } from './fx-fetch'

const NOW = new Date('2026-10-22T08:00:00Z')
const PRIMARY = FX_PROVIDERS.FRANKFURTER_BLENDED.template
const urlOf = (template: string, quote: string) => quoteUrl(template, quote, '2026-10-22')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function makeDb(over: { rates?: Array<Record<string, any>>; configs?: Array<Record<string, any>>; extra?: unknown; members?: Array<Record<string, any>> } = {}) {
  const rates = over.rates ?? []
  const configs = over.configs ?? []
  const notifications: Array<Record<string, any>> = []
  const db = {
    fxRate: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          rates.find(row => row.tenantId === where.tenantId && row.quoteCurrency === where.quoteCurrency && row.source === where.source && row.rateDate.getTime() === where.rateDate.getTime()) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => void rates.push({ id: `r${rates.length}`, ...data })),
      update: vi.fn(
        async ({ where, data }: any) =>
          void Object.assign(
            rates.find(row => row.id === where.id)!,
            data,
          ),
      ),
    },
    fxSourceConfig: {
      findMany: vi.fn(async () => configs),
      findFirst: vi.fn(async ({ where }: any) => configs.find(row => row.role === where.role) ?? null),
      update: vi.fn(
        async ({ where, data }: any) =>
          void Object.assign(
            configs.find(row => row.id === where.id)!,
            data,
          ),
      ),
      create: vi.fn(async ({ data }: any) => void configs.push({ id: `c${configs.length}`, consecutiveFailures: 0, ...data })),
    },
    tenantSetting: { findFirst: vi.fn(async () => (over.extra === undefined ? null : { valueJson: over.extra })) },
    membership: { findMany: vi.fn(async () => over.members ?? [{ userId: 'owner', role: { permissions: ['*'], system: true, version: 2, fieldPermissions: [] } }]) },
    notification: { createMany: vi.fn(async ({ data }: any) => (notifications.push(...data), { count: data.length })) },
  }
  return { db: db as unknown as FxFetchDb, rates, configs, notifications }
}

describe('汇率响应解析', () => {
  it('新版与旧版格式都接受，数值保留 8 位小数', () => {
    expect(parseQuote({ date: '2026-10-22', base: 'USD', quote: 'CNY', rate: 7.123456789 }, 'CNY')).toEqual({ rate: 7.12345679, date: '2026-10-22' })
    expect(parseQuote({ date: '2026-10-22', rates: { CNY: 7.1 } }, 'CNY')).toEqual({ rate: 7.1, date: '2026-10-22' })
  })

  it('缺失、非数字、非正数、过大、日期格式不对都拒绝', () => {
    for (const body of [
      null,
      'x',
      {},
      { date: '2026-10-22' },
      { date: '2026-10-22', rate: '7.1' },
      { date: '2026-10-22', rate: 0 },
      { date: '2026-10-22', rate: -1 },
      { date: '2026-10-22', rate: Number.NaN },
      { date: '2026-10-22', rate: 2_000_000 },
      { date: '10/22', rate: 7 },
      { rate: 7 },
    ]) {
      expect(parseQuote(body, 'CNY')).toBeNull()
    }
  })
})

describe('按企业获取汇率', () => {
  it('主源成功：保存当天汇率，记录来源与获取状态，不请求备源', async () => {
    const { db, rates, configs } = makeDb()
    const fetchImpl = vi.fn(async () => json({ date: '2026-10-22', rate: 7.1 }))
    const result = await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(result).toMatchObject({ saved: 1, failedCurrencies: [], roles: { PRIMARY: { ok: true, errorCode: null } } })
    expect(result.roles.BACKUP).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]).toEqual([urlOf(PRIMARY, 'CNY'), expect.objectContaining({ redirect: 'error' })])
    expect(rates[0]).toMatchObject({ tenantId: 't1', baseCurrency: 'USD', quoteCurrency: 'CNY', source: 'FRANKFURTER_BLENDED', rate: '7.10000000', isFallback: false, isManualOverride: false })
    expect(configs.find(item => item.role === 'PRIMARY')).toMatchObject({ lastStatus: 'OK', consecutiveFailures: 0, lastSuccessAt: NOW })
  })

  it('附加币种一并获取；设置里的非法值与美元被忽略', async () => {
    const { db, rates } = makeDb({ extra: ['EUR', 'usd', 'GBP', 'bad!', 5, 'USD'] })
    const fetchImpl = vi.fn(async (url: string) => json({ date: '2026-10-22', rate: url.includes('/EUR') ? 0.9 : url.includes('/GBP') ? 0.8 : 7.1 }))
    await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(rates.map(row => row.quoteCurrency).sort()).toEqual(['CNY', 'EUR', 'GBP'])
  })

  it('主源失败改用备源：汇率记在备源名下，主源状态记失败并累计，备源状态记成功', async () => {
    const { db, rates, configs } = makeDb({ configs: [{ id: 'c1', role: 'PRIMARY', provider: 'FRANKFURTER_BLENDED', pathTemplate: PRIMARY, consecutiveFailures: 1 }] })
    const fetchImpl = vi.fn(async (url: string) => (url === urlOf(PRIMARY, 'CNY') ? json({}, 503) : json({ date: '2026-10-22', rate: 7.2 })))
    const result = await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(result.roles).toEqual({ PRIMARY: { ok: false, errorCode: 'HTTP_503' }, BACKUP: { ok: true, errorCode: null } })
    expect(rates[0]).toMatchObject({ source: 'FRANKFURTER_ECB', rate: '7.20000000' })
    expect(configs.find(item => item.id === 'c1')).toMatchObject({ lastStatus: 'FAILED', lastErrorCode: 'HTTP_503', consecutiveFailures: 2 })
    expect(configs.find(item => item.role === 'BACKUP')).toMatchObject({ lastStatus: 'OK', provider: 'FRANKFURTER_ECB' })
  })

  it('牌价日期早于今天（周末与节假日）：记为沿用并保存牌价日期；同一天重复获取更新同一行', async () => {
    const { db, rates } = makeDb()
    const fetchImpl = vi.fn(async () => json({ date: '2026-10-20', rate: 7.3 }))
    await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(rates).toHaveLength(1)
    expect(rates[0]).toMatchObject({ isFallback: true })
    expect(rates[0].sourceDate.toISOString().slice(0, 10)).toBe('2026-10-20')
  })

  it('两个来源都失败：不写任何汇率（不编造），按网络错误、超时、返回内容异常分别记录错误码', async () => {
    const { db, rates, configs } = makeDb()
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === urlOf(PRIMARY, 'CNY')) throw timeout
      return new Response('<html>', { status: 200 })
    })
    const result = await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(rates).toHaveLength(0)
    expect(result).toMatchObject({ saved: 0, failedCurrencies: ['CNY'], roles: { PRIMARY: { ok: false, errorCode: 'TIMEOUT' }, BACKUP: { ok: false, errorCode: 'RESPONSE_INVALID' } } })
    expect(configs.map(item => item.consecutiveFailures)).toEqual([1, 1])
    const network = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    expect((await fetchFxForTenant({ db, fetchImpl: network as never, now: () => NOW }, 't1')).roles.PRIMARY?.errorCode).toBe('NETWORK_ERROR')
  })

  it('来源地址不合规（库里被改成别的主机或 http）：不发请求，记“来源地址无效”', async () => {
    const { db } = makeDb({ configs: [{ id: 'c1', role: 'PRIMARY', provider: 'FRANKFURTER_BLENDED', pathTemplate: 'https://evil.example.com/{base}/{quote}', consecutiveFailures: 0 }] })
    const fetchImpl = vi.fn(async (url: string) => (url.startsWith('https://evil') ? json({ date: '2026-10-22', rate: 1 }) : json({}, 500)))
    const result = await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(fetchImpl.mock.calls.every(call => !String(call[0]).includes('evil'))).toBe(true)
    expect(result.roles.PRIMARY?.errorCode).toBe('SOURCE_URL_INVALID')
  })

  it('响应过大直接拒绝', async () => {
    const { db } = makeDb()
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(70_000), { status: 200 }))
    const result = await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(result.roles.PRIMARY?.errorCode).toBe('RESPONSE_TOO_LARGE')
  })

  it('已被关账锁定的当天汇率不修改；手工覆盖行不受影响', async () => {
    const midnight = new Date('2026-10-22T00:00:00Z')
    const { db, rates } = makeDb({ rates: [{ id: 'r0', tenantId: 't1', quoteCurrency: 'CNY', source: 'FRANKFURTER_BLENDED', rateDate: midnight, rate: '7.00000000', lockedByPeriodId: 'p1' }] })
    const fetchImpl = vi.fn(async () => json({ date: '2026-10-22', rate: 7.9 }))
    const result = await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(result).toMatchObject({ saved: 0, skippedLocked: 1, failedCurrencies: [] })
    expect(rates[0].rate).toBe('7.00000000')
  })

  it('主源连续失败达到 3 次且全部币种失败：通知有预警管理权限的成员，同一天去重键相同', async () => {
    const config = { id: 'c1', role: 'PRIMARY', provider: 'FRANKFURTER_BLENDED', pathTemplate: PRIMARY, consecutiveFailures: 2 }
    const { db, notifications } = makeDb({ configs: [config] })
    const fetchImpl = vi.fn(async () => json({}, 500))
    await fetchFxForTenant({ db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ userId: 'owner', kind: 'ALERT_FX_FETCH_FAILED', link: '/app/settings/fx', dedupKey: 'alert:FX_FETCH_FAILED:t1:2026-10-22' })
    expect(notifications[0].body).toContain('连续 3 次')
  })

  it('失败次数不足 3 次，或部分币种成功时不通知', async () => {
    const few = makeDb()
    await fetchFxForTenant({ db: few.db, fetchImpl: (async () => json({}, 500)) as never, now: () => NOW }, 't1')
    expect(few.notifications).toHaveLength(0)
    const partial = makeDb({ extra: ['EUR'], configs: [{ id: 'c1', role: 'PRIMARY', provider: 'FRANKFURTER_BLENDED', pathTemplate: PRIMARY, consecutiveFailures: 5 }] })
    const fetchImpl = vi.fn(async (url: string) => (url.includes('/EUR') ? json({ date: '2026-10-22', rate: 0.9 }) : json({}, 500)))
    await fetchFxForTenant({ db: partial.db, fetchImpl: fetchImpl as never, now: () => NOW }, 't1')
    expect(partial.notifications).toHaveLength(0)
  })
})

describe('定时任务：逐企业获取', () => {
  it('同一来源地址同一轮只请求一次；单个企业出错不影响其他企业；只处理试用与正常的企业', async () => {
    const { db, rates } = makeDb()
    const findMany = vi.fn(async () => [{ id: 't1' }, { id: 't2' }, { id: 't3' }])
    let calls = 0
    const fetchImpl = vi.fn(async () => json({ date: '2026-10-22', rate: 7.1 }))
    const original = db.fxRate.findFirst
    ;(db.fxRate as { findFirst: unknown }).findFirst = vi.fn(async (args: unknown) => {
      calls += 1
      if (calls === 1) throw new Error('db hiccup')
      return (original as (a: unknown) => unknown)(args)
    })
    const logger = { info: vi.fn(), warn: vi.fn() }
    const result = await fetchFxForAllTenants({ systemDb: { tenant: { findMany } } as never, db, fetchImpl: fetchImpl as never, now: () => NOW, logger })
    expect(findMany.mock.calls[0][0].where).toEqual({ lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ tenants: 3, saved: 2, failedTenants: 1 })
    expect(rates).toHaveLength(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
