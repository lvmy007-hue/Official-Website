import { CASHFLOW_DEFERRED_DAYS, CASHFLOW_RELEASED_DAYS, CASHFLOW_RUN_RATE_DAYS, PAYOUT_HISTORY_SETTLEMENTS, addDaysText, roundCash, type BalanceRow, type CashflowBalances } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { localDate, zonedDayStart } from '../overview'

// 回款与现金流的取数（P2b-08）：余额快照、递延交易、近期已释放交易（日均净入账）、结算单历史。只读，一律带企业与数据范围条件。
// 金额按币种分别汇总，不跨币种相加；没有数据返回空集合（页面写“尚无记录”），不返回 0。

const RELEASED_STATUSES = ['RELEASED', 'DEFERRED_RELEASED']
/** 不算经营入账的交易类型关键字：亚马逊把打款本身也记成一笔交易，算进日均会重复，所以排除。 */
const PAYOUT_TRANSACTION_KEYWORDS = ['transfer', 'disbursement', 'payout']
const BALANCE_LOOKBACK_DAYS = 45

export type Store = { id: string; name: string }
type Where = { tenantId: string; sellerAccountId?: { in: string[] } }
export const baseWhere = (tenantId: string, scope: ResolvedScope): Where => ({ tenantId, ...(scope.unrestricted ? {} : { sellerAccountId: { in: scope.sellerAccountIds } }) })
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : Number(value.toString()))

export async function loadStores(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<Store[]> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' },
    take: 500,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName }))
}

/** 递延余额：每个店铺、账户类型、币种取最近一次快照（官方没有可用余额接口，见 CR-021）。 */
export async function loadBalances(prisma: PrismaService, where: Where, stores: readonly Store[], today: string): Promise<CashflowBalances> {
  const rows = await prisma.accountBalanceSnapshot.findMany({
    where: { ...where, balanceType: 'DEFERRED', snapshotDate: { gte: new Date(`${addDaysText(today, -BALANCE_LOOKBACK_DAYS)}T00:00:00Z`) } },
    select: { sellerAccountId: true, accountType: true, currency: true, amount: true, snapshotDate: true },
    orderBy: { snapshotDate: 'desc' },
    take: 5000,
  })
  const names = new Map(stores.map(store => [store.id, store.name]))
  const seen = new Set<string>()
  const items: BalanceRow[] = []
  for (const row of rows) {
    const key = `${row.sellerAccountId}|${row.accountType}|${row.currency}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      sellerAccountId: row.sellerAccountId,
      storeName: names.get(row.sellerAccountId) ?? row.sellerAccountId,
      accountType: row.accountType,
      label: row.accountType ? `递延余额（${row.accountType}）` : '递延余额',
      currency: row.currency,
      amount: roundCash(num(row.amount)),
      asOf: row.snapshotDate.toISOString().slice(0, 10),
    })
  }
  items.sort((a, b) => a.storeName.localeCompare(b.storeName) || a.currency.localeCompare(b.currency) || a.accountType.localeCompare(b.accountType))
  const totals = new Map<string, number>()
  for (const item of items) totals.set(item.currency, roundCash((totals.get(item.currency) ?? 0) + item.amount))
  return {
    items,
    totals: [...totals.entries()].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)),
    unavailable: [{ label: '可用余额、下次打款额', note: '官方没有通用的账户余额接口（卖家钱包接口需要钱包账户与证书，不在本期范围），这里不显示；下次打款见下方“打款预测”' }],
  }
}

export type DeferredGroup = { sellerAccountId: string; currency: string; maturityDate: string | null; amount: number; count: number }

/** 递延中的交易（最近 180 天入账、状态仍为递延），按店铺、币种与预计释放日分组。 */
export async function loadDeferred(prisma: PrismaService, where: Where, today: string, zone: string): Promise<DeferredGroup[]> {
  const groups = await prisma.fbaFinancialTransaction.groupBy({
    by: ['sellerAccountId', 'currency', 'maturityAt'],
    where: { ...where, transactionStatus: 'DEFERRED', postedAt: { gte: zonedDayStart(addDaysText(today, -CASHFLOW_DEFERRED_DAYS), zone) } },
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: [{ sellerAccountId: 'asc' }, { currency: 'asc' }, { maturityAt: 'asc' }],
    take: 5000,
  })
  return groups.map(group => ({
    sellerAccountId: group.sellerAccountId,
    currency: group.currency,
    maturityDate: group.maturityAt ? localDate(group.maturityAt, zone) : null,
    amount: roundCash(num(group._sum.amount)),
    count: group._count._all,
  }))
}

/** 最近 90 天入账、现已由递延转为释放的金额（按入账时间；官方没给释放时间，所以不是“最近 90 天释放”）。 */
export async function loadReleased(prisma: PrismaService, where: Where, today: string, zone: string): Promise<Array<{ currency: string; amount: number; count: number }>> {
  const groups = await prisma.fbaFinancialTransaction.groupBy({
    by: ['currency'],
    where: { ...where, transactionStatus: 'DEFERRED_RELEASED', postedAt: { gte: zonedDayStart(addDaysText(today, -CASHFLOW_RELEASED_DAYS), zone) } },
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: { currency: 'asc' },
  })
  return groups.map(group => ({ currency: group.currency, amount: roundCash(num(group._sum.amount)), count: group._count._all }))
}

/** 近期日均净入账：每个店铺、币种，最近 28 天入账且已释放的交易合计 ÷ 28（不含打款本身）。 */
export async function loadRunRates(prisma: PrismaService, where: Where, today: string, zone: string): Promise<Map<string, number>> {
  const notPayout: Prisma.FbaFinancialTransactionWhereInput[] = PAYOUT_TRANSACTION_KEYWORDS.map(word => ({ transactionType: { contains: word, mode: 'insensitive' } }))
  const groups = await prisma.fbaFinancialTransaction.groupBy({
    by: ['sellerAccountId', 'currency'],
    where: { ...where, transactionStatus: { in: RELEASED_STATUSES }, postedAt: { gte: zonedDayStart(addDaysText(today, -CASHFLOW_RUN_RATE_DAYS), zone) }, NOT: notPayout },
    _sum: { amount: true },
    _count: { _all: true },
  })
  const rates = new Map<string, number>()
  for (const group of groups) if (group._count._all > 0) rates.set(`${group.sellerAccountId}|${group.currency}`, num(group._sum.amount) / CASHFLOW_RUN_RATE_DAYS)
  return rates
}

export type SettlementPoint = {
  id: string
  sellerAccountId: string
  externalSettlementId: string
  currency: string
  periodEnd: string
  depositDate: string | null
  disbursementAmount: number | null
}

/** 结算单历史（有周期结束日的，最近的在前）：推断打款周期与到账延迟、列出已公布的打款。每个店铺只保留最近几张。 */
export async function loadSettlementHistory(prisma: PrismaService, where: Where, zone: string): Promise<SettlementPoint[]> {
  const rows = await prisma.fbaSettlement.findMany({
    where: { ...where, settlementEndDate: { not: null } },
    select: { id: true, sellerAccountId: true, externalSettlementId: true, currency: true, settlementEndDate: true, depositDate: true, disbursementAmount: true },
    orderBy: [{ settlementEndDate: 'desc' }, { id: 'asc' }],
    take: 1000,
  })
  const perStore = new Map<string, number>()
  const out: SettlementPoint[] = []
  for (const row of rows) {
    if (!row.settlementEndDate) continue
    const used = perStore.get(row.sellerAccountId) ?? 0
    if (used >= PAYOUT_HISTORY_SETTLEMENTS + 4) continue
    perStore.set(row.sellerAccountId, used + 1)
    out.push({
      id: row.id,
      sellerAccountId: row.sellerAccountId,
      externalSettlementId: row.externalSettlementId,
      currency: row.currency,
      periodEnd: localDate(row.settlementEndDate, zone),
      depositDate: row.depositDate ? localDate(row.depositDate, zone) : null,
      disbursementAmount: row.disbursementAmount === null ? null : roundCash(num(row.disbursementAmount)),
    })
  }
  return out
}
