import { ECONOMICS_ROW_LIMIT, STORE_LEVEL_SKU, type CompareCandidate, type EconomicsOfficialView, type OursRecord } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate, dateText } from '../overview'

// 官方经济数据对账的取数（P2b-11）：官方日表（EconomicsDaily）与我方利润日表（ProfitDaily）各读一份，按（店铺、SKU、日期）配对。
// 每边最多读 ECONOMICS_ROW_LIMIT 行（Prisma 单次读取上限 20000）；多读一行用来判断是否被截断，被截断时对账不完整，由调用方在响应里标出。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const must = (value: { toString(): string } | null | undefined) => num(value) ?? 0

export interface Loaded {
  candidates: CompareCandidate[]
  officialRows: number
  officialAds: number
  oursAds: number | null
  oursAdsRows: number
  coverage: { from: string; to: string } | null
  truncated: boolean
}

type OfficialRow = Prisma.EconomicsDailyGetPayload<Record<string, never>>

function officialView(row: OfficialRow): EconomicsOfficialView {
  const costPerUnit = num(row.sellerCostPerUnit)
  return {
    sales: must(row.sales),
    orderedSales: must(row.orderedSales),
    refundedSales: must(row.refundedSales),
    units: row.netUnits,
    fees: must(row.feesTotal),
    ads: must(row.adsSpend),
    costPerUnit,
    // 官方给的是单件成本：乘以净销量得到当天成本；卖家没填成本为 null，不是 0
    cost: costPerUnit === null ? null : costPerUnit * row.netUnits,
    netProceeds: num(row.netProceeds),
    currency: row.currency,
  }
}

type OursRow = Pick<
  Prisma.ProfitDailyGetPayload<Record<string, never>>,
  | 'sellerAccountId'
  | 'sku'
  | 'asin'
  | 'profitDate'
  | 'units'
  | 'revenue'
  | 'refunds'
  | 'feeCommission'
  | 'feeFulfillment'
  | 'feeStorage'
  | 'feeAged'
  | 'feeInbound'
  | 'feeOther'
  | 'adsSpendAllocated'
  | 'productCost'
  | 'firstMileCost'
  | 'otherCost'
  | 'profit'
>

function oursRecord(row: OursRow): OursRecord {
  const productCost = num(row.productCost)
  return {
    // 销售净额 = 收入 − 退款（官方的净销售额也是下单销售额减退款销售额）
    sales: must(row.revenue) - must(row.refunds),
    fees: must(row.feeCommission) + must(row.feeFulfillment) + must(row.feeStorage) + must(row.feeAged) + must(row.feeInbound) + must(row.feeOther),
    ads: num(row.adsSpendAllocated),
    // 没有商品成本就是没有成本（利润也算不出），不拿头程或其他成本顶替
    cost: productCost === null ? null : productCost + must(row.firstMileCost) + must(row.otherCost),
    units: row.units,
    profit: num(row.profit),
  }
}

const keyOf = (sellerAccountId: string, msku: string, date: string) => [sellerAccountId, msku, date].join('\u001f')

/** `only` 给出时只读这一个商品（店铺 × SKU，ASIN 360 页签用）；广告核对是店铺层面的，这时只合计这个商品自己的行。 */
export async function loadCompare(
  prisma: PrismaService,
  input: { tenantId: string; scope: ResolvedScope; basis: string; from: string; to: string; only?: { sellerAccountId: string; sku: string } },
): Promise<Loaded> {
  const { tenantId, scope, basis, from, to, only } = input
  const range = { gte: asDate(from), lte: asDate(to) }
  const officialWhere: Prisma.EconomicsDailyWhereInput = { tenantId, aggregation: 'DAY', ...storeWhere(scope), date: range, ...(only ? { sellerAccountId: only.sellerAccountId, msku: only.sku } : {}) }
  const oursWhere: Prisma.ProfitDailyWhereInput = { tenantId, basis, ...storeWhere(scope), profitDate: range, ...(only ? { sellerAccountId: only.sellerAccountId, sku: only.sku } : {}) }
  const [official, ours, adsSum] = await Promise.all([
    prisma.economicsDaily.findMany({ where: officialWhere, orderBy: [{ sellerAccountId: 'asc' }, { msku: 'asc' }, { date: 'asc' }], take: ECONOMICS_ROW_LIMIT + 1 }),
    prisma.profitDaily.findMany({
      // 只看一个商品时 oursWhere 已经限定了 SKU（它本来就不是店铺级行），不能再被“排除店铺级行”覆盖
      where: only ? oursWhere : { ...oursWhere, sku: { not: STORE_LEVEL_SKU } },
      select: {
        sellerAccountId: true,
        sku: true,
        asin: true,
        profitDate: true,
        units: true,
        revenue: true,
        refunds: true,
        feeCommission: true,
        feeFulfillment: true,
        feeStorage: true,
        feeAged: true,
        feeInbound: true,
        feeOther: true,
        adsSpendAllocated: true,
        productCost: true,
        firstMileCost: true,
        otherCost: true,
        profit: true,
      },
      orderBy: [{ sellerAccountId: 'asc' }, { sku: 'asc' }, { profitDate: 'asc' }],
      take: ECONOMICS_ROW_LIMIT + 1,
    }),
    // 我方广告合计含店铺级行（账户级广告）与已分摊到商品的部分；两列都没有值就是“尚未接入”，不是 0
    prisma.profitDaily.aggregate({ where: oursWhere, _sum: { adsSpendAllocated: true, adsUnallocated: true }, _count: { adsSpendAllocated: true, adsUnallocated: true } }),
  ])
  const truncated = official.length > ECONOMICS_ROW_LIMIT || ours.length > ECONOMICS_ROW_LIMIT
  const officialRows = official.slice(0, ECONOMICS_ROW_LIMIT)
  const oursRows = ours.slice(0, ECONOMICS_ROW_LIMIT)

  const byKey = new Map<string, CompareCandidate>()
  for (const row of officialRows) {
    const date = dateText(row.date)
    byKey.set(keyOf(row.sellerAccountId, row.msku, date), { sellerAccountId: row.sellerAccountId, msku: row.msku, date, asin: row.asin, official: officialView(row), ours: null })
  }
  for (const row of oursRows) {
    const date = dateText(row.profitDate)
    const key = keyOf(row.sellerAccountId, row.sku, date)
    const record = oursRecord(row)
    const existing = byKey.get(key)
    if (existing) {
      existing.ours = record
      existing.asin = existing.asin ?? row.asin
    } else byKey.set(key, { sellerAccountId: row.sellerAccountId, msku: row.sku, date, asin: row.asin, official: null, ours: record })
  }

  const usdOfficial = officialRows.filter(row => row.currency === 'USD')
  const adsCount = adsSum._count.adsSpendAllocated + adsSum._count.adsUnallocated
  const dates = officialRows.map(row => dateText(row.date))
  return {
    candidates: [...byKey.values()],
    officialRows: usdOfficial.length,
    officialAds: usdOfficial.reduce((total, row) => total + must(row.adsSpend), 0),
    oursAds: adsCount === 0 ? null : must(adsSum._sum.adsSpendAllocated) + must(adsSum._sum.adsUnallocated),
    oursAdsRows: adsCount,
    coverage: dates.length === 0 ? null : { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) },
    truncated,
  }
}
