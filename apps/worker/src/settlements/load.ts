import { SETTLEMENT_PERIOD_GRACE_MS, type SettlementCategory } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { LineFact, TxFact } from './reconcile'

// 三方核对要读的数据（P2b-07）。结算单可能有几万行明细，所以分页读；交易表和订单表是分区表，查询都带企业与店铺。

const PAGE = 10_000
/** 单张结算单读取的上限，防止异常数据拖垮内存；超过时核对结果标注不完整（见 run.ts）。 */
export const SETTLEMENT_LOAD_CAP = 400_000
const CHUNK = 1_000

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : Number(value.toString()))

/** 接口里“还没入账”的交易也算（亚马逊的 DEFERRED 等状态），只排除我们旧版报告导入的 POSTED 行，避免与报告重复。 */
const FROM_API = [{ transactionStatus: null }, { transactionStatus: { not: 'POSTED' } }]

export async function loadLines(db: PrismaClient, settlementId: string): Promise<{ lines: LineFact[]; truncated: boolean }> {
  const lines: LineFact[] = []
  let after = 0
  while (lines.length < SETTLEMENT_LOAD_CAP) {
    const page = await db.settlementLine.findMany({
      where: { settlementId, lineNo: { gt: after } },
      orderBy: { lineNo: 'asc' },
      take: PAGE,
      select: { lineNo: true, category: true, amount: true, amazonOrderId: true, transactionType: true, amountDescription: true },
    })
    for (const row of page) {
      lines.push({
        category: row.category as SettlementCategory,
        amount: num(row.amount),
        amazonOrderId: row.amazonOrderId,
        transactionType: row.transactionType,
        amountDescription: row.amountDescription,
      })
    }
    if (page.length < PAGE) return { lines, truncated: false }
    after = page[page.length - 1]!.lineNo
  }
  return { lines, truncated: true }
}

export async function loadTransactions(db: PrismaClient, tenantId: string, sellerAccountId: string, settlementId: string): Promise<TxFact[]> {
  const out: TxFact[] = []
  for (let skip = 0; out.length < SETTLEMENT_LOAD_CAP; skip += PAGE) {
    const page = await db.fbaFinancialTransaction.findMany({
      where: { tenantId, sellerAccountId, settlementId, OR: FROM_API },
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
      skip,
      take: PAGE,
      select: { amazonOrderId: true, amount: true, currency: true, postedAt: true },
    })
    for (const row of page) out.push({ amazonOrderId: row.amazonOrderId, amount: num(row.amount), currency: row.currency, postedAt: row.postedAt })
    if (page.length < PAGE) break
  }
  return out
}

export async function findOrders(db: PrismaClient, tenantId: string, sellerAccountId: string, orderIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let index = 0; index < orderIds.length; index += CHUNK) {
    const rows = await db.order.findMany({
      where: { tenantId, sellerAccountId, amazonOrderId: { in: orderIds.slice(index, index + CHUNK) as string[] } },
      select: { amazonOrderId: true },
    })
    for (const row of rows) found.add(row.amazonOrderId)
  }
  return found
}

/** 这些订单在接口里没归到本结算单的交易（周期前后各放宽一天），按订单号合计，只算和结算单同币种的。 */
export async function sumUnattributed(
  db: PrismaClient,
  scope: { tenantId: string; sellerAccountId: string; settlementId: string; currency: string; periodStart: Date | null; periodEnd: Date | null },
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  const sums = new Map<string, number>()
  const postedAt = {
    ...(scope.periodStart ? { gte: new Date(scope.periodStart.getTime() - SETTLEMENT_PERIOD_GRACE_MS) } : {}),
    ...(scope.periodEnd ? { lte: new Date(scope.periodEnd.getTime() + SETTLEMENT_PERIOD_GRACE_MS) } : {}),
  }
  for (let index = 0; index < orderIds.length; index += CHUNK) {
    const rows = await db.fbaFinancialTransaction.findMany({
      where: {
        tenantId: scope.tenantId,
        sellerAccountId: scope.sellerAccountId,
        currency: scope.currency,
        amazonOrderId: { in: orderIds.slice(index, index + CHUNK) as string[] },
        AND: [{ OR: [{ settlementId: null }, { settlementId: { not: scope.settlementId } }] }, { OR: FROM_API }],
        ...(Object.keys(postedAt).length > 0 ? { postedAt } : {}),
      },
      select: { amazonOrderId: true, amount: true },
      take: 20_000,
    })
    for (const row of rows) if (row.amazonOrderId) sums.set(row.amazonOrderId, (sums.get(row.amazonOrderId) ?? 0) + num(row.amount))
  }
  return sums
}

/** 店铺最早一笔接口交易、最早一个订单的时间：判断“差异是不是因为我们没同步到那么早”。 */
export async function loadCoverage(db: PrismaClient, tenantId: string, sellerAccountId: string): Promise<{ apiStart: Date | null; ordersStart: Date | null }> {
  const [api, orders] = await Promise.all([
    db.fbaFinancialTransaction.aggregate({ where: { tenantId, sellerAccountId }, _min: { postedAt: true } }),
    db.order.aggregate({ where: { tenantId, sellerAccountId }, _min: { purchaseDate: true } }),
  ])
  return { apiStart: api._min.postedAt, ordersStart: orders._min.purchaseDate }
}
