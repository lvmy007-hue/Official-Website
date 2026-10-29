import type { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import type { SpApiV2 } from '../connectors/sp-api-v2'
import { fetchLegacyFinance } from '../importers/finance/legacy'
import { parseTransaction } from '../importers/finance/v2024-parse'
import { fetchLegacyOrders } from '../importers/orders/legacy'
import { parseOrder } from '../importers/orders/v2026-parse'
import { digestOf, type OrderDigest } from '../importers/orders/v2026-types'
import type { ImportContext, JsonObject } from '../types'
import { compareFinance } from './compare-finance'
import { compareOrders } from './compare-orders'
import { ensureChannelState, saveParityRun, shouldRunParity, type ParityDomain, type ParityScope, type SavedParity } from './store'

// 核对运行器：同一时间窗内旧接口、新接口各拉一遍（只读，不写业务表），比对后落核对记录。
// 旧接口不可用（被官方下线或调用失败）时记为“旧接口不可用”，不算通过也不算失败，不影响同步任务。

/** 核对时间窗：最近 7 天（旧接口要求结束时间早于请求时刻两分钟以上）。 */
export const PARITY_WINDOW_DAYS = 7
const asRecord = (value: unknown): JsonObject | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)
const records = (value: unknown) => (Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonObject => item !== null) : [])

const windowOf = (now: Date) => {
  const end = new Date(now.getTime() - 2 * 60 * 1000)
  return { start: new Date(end.getTime() - PARITY_WINDOW_DAYS * 86_400_000), end }
}

async function fetchNewOrderDigests(api: Pick<SpApiV2, 'searchOrders'>, after: string, before: string): Promise<OrderDigest[]> {
  const digests: OrderDigest[] = []
  let token: string | undefined
  do {
    // 核对只需要状态与合计，不取买家信息
    const response = await api.searchOrders({ createdAfter: after, createdBefore: before, paginationToken: token, includedData: ['FULFILLMENT', 'PROCEEDS', 'TAX'] })
    for (const raw of records(response.orders)) {
      const parsed = parseOrder(raw)
      if (!('skipped' in parsed)) digests.push(digestOf(parsed))
    }
    const next = asRecord(response.pagination)?.nextToken
    token = typeof next === 'string' && next.length > 0 ? next : undefined
  } while (token)
  return digests
}

async function fetchNewTransactions(api: Pick<SpApiV2, 'listTransactions'>, after: string, before: string) {
  const entries: Array<{ amazonOrderId?: string; amount: number; currency: string; postedAt: Date; deferred: boolean }> = []
  let token: string | undefined
  do {
    const response = await api.listTransactions({ postedAfter: after, postedBefore: before, nextToken: token })
    const root = asRecord(response.payload) ?? response
    for (const raw of records(root.transactions)) {
      const parsed = parseTransaction(raw)
      if (!('skipped' in parsed))
        entries.push({ amazonOrderId: parsed.amazonOrderId, amount: parsed.amount, currency: parsed.currency, postedAt: parsed.postedAt, deferred: parsed.status === 'DEFERRED' })
    }
    token = typeof root.nextToken === 'string' && root.nextToken.length > 0 ? root.nextToken : undefined
  } while (token)
  return entries
}

export type ParityOutcome = { ran: false } | ({ ran: true } & SavedParity)

async function guarded<T>(ctx: ImportContext, domain: ParityDomain, legacyFetch: () => Promise<T>): Promise<T | null> {
  try {
    return await legacyFetch()
  } catch (error) {
    ctx.logger.warn({ domain, error: error instanceof Error ? error.message : String(error) }, 'legacy interface unavailable for parity check')
    return null
  }
}

export async function runOrdersParity(
  ctx: ImportContext,
  scope: ParityScope,
  apis: { next: Pick<SpApiV2, 'searchOrders'>; legacy: Pick<AmazonSpApiClient, 'getOrders'>; marketplaceId: string },
  options: { now?: () => Date; syncJobId?: string } = {},
): Promise<ParityOutcome> {
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const state = await ensureChannelState(ctx.prisma, scope, 'ORDERS')
  if (!shouldRunParity(state, startedAt)) return { ran: false }
  const window = windowOf(startedAt)
  const range = { after: window.start.toISOString(), before: window.end.toISOString() }
  const legacy = await guarded(ctx, 'ORDERS', () => fetchLegacyOrders(apis.legacy, apis.marketplaceId, range))
  const next = legacy === null ? [] : await fetchNewOrderDigests(apis.next, range.after, range.before)
  const report = legacy === null ? null : compareOrders({ legacy, next, window })
  return { ran: true, ...(await saveParityRun(ctx.prisma, scope, 'ORDERS', { window, report, startedAt, now: now(), syncJobId: options.syncJobId })) }
}

export async function runFinanceParity(
  ctx: ImportContext,
  scope: ParityScope,
  apis: { next: Pick<SpApiV2, 'listTransactions'>; legacy: Pick<AmazonSpApiClient, 'getFinancialEvents'> },
  options: { now?: () => Date; syncJobId?: string } = {},
): Promise<ParityOutcome> {
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const state = await ensureChannelState(ctx.prisma, scope, 'FINANCE')
  if (!shouldRunParity(state, startedAt)) return { ran: false }
  const window = windowOf(startedAt)
  const range = { after: window.start.toISOString(), before: window.end.toISOString() }
  const legacy = await guarded(ctx, 'FINANCE', () => fetchLegacyFinance(apis.legacy, range))
  const fetchedAt = now()
  const next = legacy === null ? [] : await fetchNewTransactions(apis.next, range.after, range.before)
  const report = legacy === null ? null : compareFinance({ legacy, next, window, fetchedAt })
  return { ran: true, ...(await saveParityRun(ctx.prisma, scope, 'FINANCE', { window, report, startedAt, now: now(), syncJobId: options.syncJobId })) }
}
