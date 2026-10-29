import type { PrismaClient } from '@prisma/client'
import type { SpApiV2 } from '../../connectors/sp-api-v2'
import { BATCH_TX_TIMEOUT_MS } from '../../streaming/batch'
import type { ImportContext, JsonObject } from '../../types'
import { historyWindows } from '../shared'
import { parseTransaction, type ParsedTransaction } from './v2024-parse'
import { writeTransaction, type FinanceScope } from './v2024-write'

// 财务新版接口同步（importers.md S2）。
// - 首次：按入账时间每 179 天一段回补（接口要求起止相隔不超过 180 天）。
// - 增量：从上次成功时间前推 14 天重拉——交易状态会从“递延”变成“已释放”，只拉新交易会漏掉状态变化。
// - 递延核对：每次增量同步后单独拉一遍“当前仍为递延”的交易，库里标着递延但接口不再返回的，改为“递延后已释放”；
//   同时用这批交易汇总出当天的“递延余额”快照。官方没有通用的余额接口（见 CR-021），递延余额是唯一能从该接口准确得到的余额。

export const FINANCE_STATUS_REFRESH_DAYS = 14
const DAY = 86_400_000
const RELEASE_CHUNK = 500

export type FinanceSyncResult = { imported: number; skipped: number; pages: number; deferredReleased: number; balanceRows: number }

type FinanceApi = Pick<SpApiV2, 'listTransactions'>
type Query = { postedAfter: string; postedBefore?: string; transactionStatus?: 'DEFERRED' }
const asRecord = (value: unknown): JsonObject | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)

async function pull(ctx: ImportContext, api: FinanceApi, scope: FinanceScope, query: Query, result: FinanceSyncResult, onEach: (transaction: ParsedTransaction) => void) {
  let token: string | undefined
  do {
    const response = await api.listTransactions({ ...query, nextToken: token })
    const root = asRecord(response.payload) ?? response
    const raws = Array.isArray(root.transactions) ? root.transactions.map(asRecord).filter((item): item is JsonObject => item !== null) : []
    result.pages += 1
    const parsed = raws.map(parseTransaction)
    await ctx.prisma.$transaction(
      async tx => {
        const inner: ImportContext = { ...ctx, prisma: tx as unknown as PrismaClient }
        for (const transaction of parsed) {
          if ('skipped' in transaction) {
            result.skipped += 1
            continue
          }
          onEach(transaction)
          await writeTransaction(inner, scope, transaction)
          result.imported += 1
        }
      },
      { timeout: BATCH_TX_TIMEOUT_MS, maxWait: 10_000 },
    )
    token = typeof root.nextToken === 'string' && root.nextToken.length > 0 ? root.nextToken : undefined
  } while (token)
}

/** 当天（UTC）日期，用于余额快照的日期键。 */
export const utcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

async function refreshDeferred(ctx: ImportContext, api: FinanceApi, scope: FinanceScope, now: Date, result: FinanceSyncResult) {
  const { prisma } = ctx
  const before = new Date(now.getTime() - 2 * 60 * 1000)
  const from = new Date(before.getTime() - 179 * DAY)
  const stillDeferred = new Set<string>()
  const balances = new Map<string, { currency: string; accountType: string; amount: number }>()
  await pull(ctx, api, scope, { postedAfter: from.toISOString(), postedBefore: before.toISOString(), transactionStatus: 'DEFERRED' }, result, transaction => {
    stillDeferred.add(transaction.transactionId)
    const key = `${transaction.currency}|${transaction.accountType}`
    const entry = balances.get(key) ?? { currency: transaction.currency, accountType: transaction.accountType, amount: 0 }
    entry.amount += transaction.amount
    balances.set(key, entry)
  })

  const rows = await prisma.fbaFinancialTransaction.findMany({
    where: { sellerAccountId: scope.sellerAccountId, transactionStatus: 'DEFERRED', postedAt: { gte: from } },
    select: { externalTransactionId: true },
  })
  const released = rows.map(row => row.externalTransactionId).filter(id => !stillDeferred.has(id))
  for (let index = 0; index < released.length; index += RELEASE_CHUNK) {
    const chunk = released.slice(index, index + RELEASE_CHUNK)
    await prisma.fbaFinancialTransaction.updateMany({
      where: { sellerAccountId: scope.sellerAccountId, externalTransactionId: { in: chunk }, postedAt: { gte: from } },
      data: { transactionStatus: 'DEFERRED_RELEASED' },
    })
    // P2b-05：费用事件带着来源交易的状态，同步改成“递延后已释放”（费用事件的来源编号就是交易编号）
    await prisma.fbaFeeEvent.updateMany({
      where: { sellerAccountId: scope.sellerAccountId, sourceRecordId: { in: chunk }, transactionStatus: 'DEFERRED', postedAt: { gte: from } },
      data: { transactionStatus: 'DEFERRED_RELEASED' },
    })
  }
  result.deferredReleased = released.length

  // 当天没有任何递延交易也要写一行 0：余额曲线需要“确实为 0”与“没有数据”区分开
  const entries = balances.size > 0 ? [...balances.values()] : [{ currency: 'USD', accountType: '', amount: 0 }]
  const snapshotDate = utcDay(now)
  for (const entry of entries) {
    await prisma.accountBalanceSnapshot.upsert({
      where: {
        sellerAccountId_snapshotDate_currency_balanceType_accountType: {
          sellerAccountId: scope.sellerAccountId,
          snapshotDate,
          currency: entry.currency,
          balanceType: 'DEFERRED',
          accountType: entry.accountType,
        },
      },
      create: {
        tenantId: scope.tenantId,
        sellerAccountId: scope.sellerAccountId,
        snapshotDate,
        balanceType: 'DEFERRED',
        accountType: entry.accountType,
        currency: entry.currency,
        amount: entry.amount,
        sourceUpdatedAt: now,
        sourceRecordId: `deferred:${snapshotDate.toISOString().slice(0, 10)}`,
      },
      update: { amount: entry.amount, sourceUpdatedAt: now },
    })
    result.balanceRows += 1
  }
}

export async function syncFinanceV2024(
  ctx: ImportContext,
  api: FinanceApi,
  scope: FinanceScope,
  options: { since?: Date | null; window?: { after: string; before: string }; onTransaction?: (transaction: ParsedTransaction) => void; now?: () => Date } = {},
): Promise<FinanceSyncResult> {
  const now = (options.now ?? (() => new Date()))()
  const result: FinanceSyncResult = { imported: 0, skipped: 0, pages: 0, deferredReleased: 0, balanceRows: 0 }
  // historyWindows 自带前推 2 天，这里再前推 12 天凑够 14 天
  const start = options.since ? new Date(options.since.getTime() - (FINANCE_STATUS_REFRESH_DAYS - 2) * DAY) : null
  const windows = options.window ? [options.window] : historyWindows(start, 179)
  for (const window of windows) await pull(ctx, api, scope, { postedAfter: window.after, postedBefore: window.before }, result, transaction => options.onTransaction?.(transaction))
  if (!options.window) await refreshDeferred(ctx, api, scope, now, result)
  if (result.skipped > 0) ctx.logger.warn({ skipped: result.skipped, ...scope }, 'finance transactions skipped: missing id, posted date, amount, or not US marketplace')
  return result
}
