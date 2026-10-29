import { FX_BASE_CURRENCY, FX_DEFAULT_CURRENCIES, FX_PROVIDERS, fxTemplateProblem, type FxProvider, type FxRole } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { notifyHolders } from './notify'

// 汇率每日获取（P1-28-2）：按企业配置的主源、备源，为人民币与附加币种获取当天汇率并保存。
// - 来源地址每次都重新校验（https、主机白名单、含 {base}/{quote}），不信任库里的历史值；不跟随跳转，响应限 64KB、10 秒超时；
// - 主源失败才用备源；两个来源都失败的币种不写任何数据（不编造汇率），已有的历史汇率照常按“向前沿用最多 10 天”规则使用；
// - 牌价日期早于今天（周末、节假日）时记为“沿用”（isFallback）并保存牌价日期；已被关账锁定的行不修改；
// - 主源连续失败 3 次及以上且本次所有币种都失败：通知有预警管理权限的成员（同一天只通知一次）。

const RESPONSE_LIMIT_BYTES = 64 * 1024
const TIMEOUT_MS = 10_000
export const FX_ALERT_AFTER_FAILURES = 3
const dateText = (value: Date) => value.toISOString().slice(0, 10)
const CURRENCY = /^[A-Z]{3}$/

export type FxFetchDb = Pick<PrismaClient, 'fxRate' | 'fxSourceConfig' | 'tenantSetting' | 'notification' | 'membership'>
export interface Quote {
  rate: number
  date: string
}
export type QuoteResult = { ok: true; quote: Quote } | { ok: false; code: string }
export type QuoteCache = Map<string, Promise<QuoteResult>>

export interface FxFetchDeps {
  db: FxFetchDb
  fetchImpl?: typeof fetch
  now?: () => Date
  /** 同一轮里多个企业共用同一来源地址的响应（同一地址同一币种只请求一次） */
  cache?: QuoteCache
}

/** 解析来源响应：新版 { date, rate } 与旧版 { date, rates: { CNY } } 都接受；数值必须是有限正数。 */
export function parseQuote(body: unknown, quote: string): Quote | null {
  if (!body || typeof body !== 'object') return null
  const record = body as { date?: unknown; rate?: unknown; rates?: Record<string, unknown> }
  const rate = typeof record.rate === 'number' ? record.rate : record.rates && typeof record.rates === 'object' ? record.rates[quote] : undefined
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) return null
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return null
  return { rate: Number(rate.toFixed(8)), date: record.date }
}

async function request(fetchImpl: typeof fetch, url: string, quote: string): Promise<QuoteResult> {
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, code: (error as { name?: string }).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' }
  }
  if (!response.ok) return { ok: false, code: `HTTP_${response.status}` }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > RESPONSE_LIMIT_BYTES) return { ok: false, code: 'RESPONSE_TOO_LARGE' }
  const text = await response.text().catch(() => '')
  if (text.length > RESPONSE_LIMIT_BYTES) return { ok: false, code: 'RESPONSE_TOO_LARGE' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'RESPONSE_INVALID' }
  }
  const quoteResult = parseQuote(parsed, quote)
  return quoteResult ? { ok: true, quote: quoteResult } : { ok: false, code: 'RESPONSE_INVALID' }
}

export function quoteUrl(template: string, quote: string, today: string) {
  return template.replace('{base}', FX_BASE_CURRENCY).replace('{quote}', quote).replace('{date}', today)
}

function getQuote(deps: FxFetchDeps, template: string, quote: string, today: string): Promise<QuoteResult> {
  const problem = fxTemplateProblem(template)
  if (problem) return Promise.resolve({ ok: false, code: 'SOURCE_URL_INVALID' })
  const url = quoteUrl(template, quote, today)
  const cached = deps.cache?.get(url)
  if (cached) return cached
  const pending = request(deps.fetchImpl ?? fetch, url, quote)
  deps.cache?.set(url, pending)
  return pending
}

interface SourceChoice {
  role: FxRole
  provider: FxProvider
  pathTemplate: string
}

async function loadSources(db: FxFetchDb, tenantId: string): Promise<SourceChoice[]> {
  const rows = await db.fxSourceConfig.findMany({ where: { tenantId, enabled: true }, take: 10 })
  const pick = (role: FxRole, fallback: FxProvider): SourceChoice => {
    const row = rows.find(item => item.role === role)
    const provider = (row && row.provider in FX_PROVIDERS ? row.provider : fallback) as FxProvider
    return { role, provider, pathTemplate: row?.pathTemplate ?? FX_PROVIDERS[provider].template }
  }
  return [pick('PRIMARY', 'FRANKFURTER_BLENDED'), pick('BACKUP', 'FRANKFURTER_ECB')]
}

async function loadCurrencies(db: FxFetchDb, tenantId: string): Promise<string[]> {
  const row = await db.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: 'fx.extraCurrencies' } })
  const extra = Array.isArray(row?.valueJson) ? row.valueJson.filter((item): item is string => typeof item === 'string' && CURRENCY.test(item) && item !== FX_BASE_CURRENCY) : []
  return [...new Set([...FX_DEFAULT_CURRENCIES, ...extra])]
}

export interface FxFetchResult {
  saved: number
  skippedLocked: number
  failedCurrencies: string[]
  /** 每个来源角色本次的结果；没有被尝试的角色不出现 */
  roles: Partial<Record<FxRole, { ok: boolean; errorCode: string | null }>>
}

/** 获取一个企业的汇率（必须在该企业的租户上下文里调用）。 */
export async function fetchFxForTenant(deps: FxFetchDeps, tenantId: string): Promise<FxFetchResult> {
  const now = (deps.now ?? (() => new Date()))()
  const today = dateText(now)
  const [sources, currencies] = await Promise.all([loadSources(deps.db, tenantId), loadCurrencies(deps.db, tenantId)])
  const result: FxFetchResult = { saved: 0, skippedLocked: 0, failedCurrencies: [], roles: {} }
  const roleSuccess = new Map<FxRole, boolean>()
  const roleError = new Map<FxRole, string>()

  for (const currency of currencies) {
    let stored = false
    for (const source of sources) {
      const got = await getQuote(deps, source.pathTemplate, currency, today)
      if (!got.ok) {
        roleError.set(source.role, got.code)
        if (!roleSuccess.has(source.role)) roleSuccess.set(source.role, false)
        continue
      }
      roleSuccess.set(source.role, true)
      const fallback = got.quote.date < today
      const key = { tenantId, baseCurrency: FX_BASE_CURRENCY, quoteCurrency: currency, rateDate: new Date(`${today}T00:00:00Z`), source: source.provider }
      const existing = await deps.db.fxRate.findFirst({ where: key })
      if (existing?.lockedByPeriodId) {
        result.skippedLocked += 1
      } else {
        const data = { rate: got.quote.rate.toFixed(8), isFallback: fallback, sourceDate: new Date(`${got.quote.date}T00:00:00Z`), isManualOverride: false, fetchedAt: now }
        if (existing) await deps.db.fxRate.update({ where: { id: existing.id }, data })
        else await deps.db.fxRate.create({ data: { ...key, ...data } })
        result.saved += 1
      }
      stored = true
      break
    }
    if (!stored) result.failedCurrencies.push(currency)
  }

  for (const source of sources) {
    if (!roleSuccess.has(source.role)) continue // 备源没有被用到，状态不变
    const ok = roleSuccess.get(source.role) === true
    const errorCode = ok ? null : (roleError.get(source.role) ?? 'UNKNOWN')
    result.roles[source.role] = { ok, errorCode }
  }
  await recordSourceStatus(deps.db, tenantId, sources, result, now)
  await alertIfStuck(deps.db, tenantId, result, now)
  return result
}

async function recordSourceStatus(db: FxFetchDb, tenantId: string, sources: SourceChoice[], result: FxFetchResult, now: Date) {
  for (const source of sources) {
    const outcome = result.roles[source.role]
    if (!outcome) continue
    const row = await db.fxSourceConfig.findFirst({ where: { tenantId, role: source.role } })
    const data = outcome.ok
      ? { lastAttemptAt: now, lastSuccessAt: now, lastStatus: 'OK', lastErrorCode: null, consecutiveFailures: 0 }
      : { lastAttemptAt: now, lastStatus: 'FAILED', lastErrorCode: outcome.errorCode, consecutiveFailures: (row?.consecutiveFailures ?? 0) + 1 }
    if (row) await db.fxSourceConfig.update({ where: { id: row.id }, data })
    else await db.fxSourceConfig.create({ data: { tenantId, role: source.role, provider: source.provider, pathTemplate: source.pathTemplate, priority: source.role === 'PRIMARY' ? 1 : 2, ...data } })
  }
}

async function alertIfStuck(db: FxFetchDb, tenantId: string, result: FxFetchResult, now: Date) {
  const everyCurrencyFailed = result.saved === 0 && result.skippedLocked === 0 && result.failedCurrencies.length > 0
  if (!everyCurrencyFailed) return
  const primary = await db.fxSourceConfig.findFirst({ where: { tenantId, role: 'PRIMARY' } })
  if ((primary?.consecutiveFailures ?? 0) < FX_ALERT_AFTER_FAILURES) return
  await notifyHolders(db, tenantId, 'alerts.manage', {
    kind: 'ALERT_FX_FETCH_FAILED',
    title: '汇率获取失败',
    body: `汇率已连续 ${primary?.consecutiveFailures} 次获取失败，当前沿用历史汇率。请检查来源设置，或手工覆盖当天汇率`,
    link: '/app/settings/fx',
    severity: 'WARNING',
    dedupKey: `alert:FX_FETCH_FAILED:${tenantId}:${dateText(now)}`,
  })
}

export interface FxScanDeps {
  /** 系统连接：只用来列出企业 */
  systemDb: Pick<PrismaClient, 'tenant'>
  /** 租户连接：在各企业的上下文里读写 */
  db: FxFetchDb
  fetchImpl?: typeof fetch
  now?: () => Date
  logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }
}

/** 定时任务：对试用与正常状态的企业逐个获取；单个企业出错不影响其他企业；同一轮内相同来源地址只请求一次。 */
export async function fetchFxForAllTenants(deps: FxScanDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  const cache: QuoteCache = new Map()
  let saved = 0
  let failedTenants = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => fetchFxForTenant({ db: deps.db, fetchImpl: deps.fetchImpl, now: deps.now, cache }, tenant.id))
      saved += result.saved
    } catch (error) {
      failedTenants += 1
      deps.logger.warn({ event: 'fx_fetch_tenant_failed', error: error instanceof Error ? error.message : String(error) }, 'fx fetch failed for a tenant')
    }
  }
  deps.logger.info({ event: 'fx_fetched', tenants: tenants.length, saved, failedTenants }, 'fx rates fetched')
  return { tenants: tenants.length, saved, failedTenants }
}
