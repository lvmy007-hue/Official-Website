import { ECONOMICS_BACKFILL_DAYS, ECONOMICS_DATASET_DAILY } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import type { RowOutcome } from '../streaming/batch'
import type { Row } from '../streaming/rows'
import type { ImportContext } from '../types'
import { count, dateOf, DATE_PATTERN, get, money, quote, round, unwrapRecord } from './json'
import { registerDataKioskDataset, type DataKioskDataset, type KioskScope } from './registry'

// 数据中心“官方单品经济”数据集（P2b-11，importers.md D-04）：按天、按 MSKU 拉官方已发生的销售、费用、广告与成本，供“官方经济数据对账”页与双源核对用。
// 字段对照官方 schema（selling-partner-api-models/schemas/data-kiosk/analytics_economics_2024_03_15.graphql，2026 年 10 月）：
//   economics(marketplaceIds, startDate, endDate, aggregateBy: { date: DAY, productId: MSKU }) → EconomicsDaily 每个 MSKU 每天一行；
//   sales { orderedProductSales refundedProductSales netProductSales unitsOrdered unitsRefunded netUnitsSold }，fees 是按费用类型分的列表（每类下有多笔 charge），
//   ads 是按广告类型分的列表（charge.totalAmount），cost { costOfGoodsSold fbaCost { shippingToAmazonCost } } 是卖家在亚马逊后台填的单件成本（没填为空），
//   netProceeds { total } 是官方算的净收入。需要“卖家洞察”角色；一次查询时间跨度不超过官方限制，所以调用方分窗口（14 天刷新、90 天回补）。
// 未对照真实店铺核对结果行的实际形状：解析对缺失字段一律当“官方没给”（null），不补 0。

export const ECONOMICS_DAILY_DATASET = ECONOMICS_DATASET_DAILY
export const ECONOMICS_MARKETPLACE_ID = 'ATVPDKIKX0DER'
const MAX_WINDOW_DAYS = ECONOMICS_BACKFILL_DAYS + 1

export function buildEconomicsDailyQuery(params: Record<string, string>): string {
  const { startDate, endDate } = params
  if (!DATE_PATTERN.test(startDate ?? '') || !DATE_PATTERN.test(endDate ?? '')) throw new Error('ECONOMICS_DAILY_DATE_INVALID')
  const span = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  if (!(span >= 0) || span + 1 > MAX_WINDOW_DAYS) throw new Error('ECONOMICS_DAILY_DATE_INVALID')
  const amount = '{ amount currencyCode }'
  return `{ analytics_economics_2024_03_15 { economics(
    marketplaceIds: [${quote(ECONOMICS_MARKETPLACE_ID)}], startDate: ${quote(startDate)}, endDate: ${quote(endDate)}, aggregateBy: { date: DAY, productId: MSKU }
  ) { startDate msku childAsin
      sales { orderedProductSales ${amount} refundedProductSales ${amount} netProductSales ${amount} unitsOrdered unitsRefunded netUnitsSold }
      fees { feeTypeName charges { aggregatedDetail { totalAmount ${amount} } } }
      ads { adTypeName charge { totalAmount ${amount} } }
      cost { costOfGoodsSold ${amount} fbaCost { shippingToAmazonCost ${amount} } }
      netProceeds { total ${amount} }
  } } }`
}

export interface ParsedEconomicsDay {
  msku: string
  asin: string | null
  date: string
  currency: string
  unitsOrdered: number
  unitsRefunded: number
  netUnits: number
  orderedSales: number
  refundedSales: number
  sales: number
  fees: Record<string, number>
  feesTotal: number
  adsSpend: number
  /** 官方单件成本（商品成本 + 发往亚马逊的运费）；卖家没填成本为 null。 */
  costPerUnit: number | null
  cost: { cogs: number | null; shippingToAmazon: number | null } | null
  netProceeds: number | null
}

const sumOf = (values: unknown[], pick: (value: unknown) => { amount: number; currency: string | null } | null) =>
  values.reduce<{ total: number; currency: string | null }>(
    (acc, value) => {
      const m = pick(value)
      return m ? { total: acc.total + m.amount, currency: acc.currency ?? m.currency } : acc
    },
    { total: 0, currency: null },
  )

/** 一行结果 → 一天一个 MSKU 的官方数据；缺少 SKU、日期或净销售额的行无法使用，返回 null。 */
export function readEconomicsDay(row: Row): ParsedEconomicsDay | null {
  const item = unwrapRecord(row, 'analytics_economics_2024_03_15', 'economics')
  const msku = get(item, 'msku')
  const date = dateOf(get(item, 'startDate'))
  const net = money(get(item, 'sales', 'netProductSales'))
  if (typeof msku !== 'string' || msku.trim() === '' || !date || !net) return null
  const ordered = money(get(item, 'sales', 'orderedProductSales'))
  const refunded = money(get(item, 'sales', 'refundedProductSales'))
  const fees: Record<string, number> = {}
  let currency = net.currency
  for (const fee of Array.isArray(get(item, 'fees')) ? (get(item, 'fees') as unknown[]) : []) {
    const type = get(fee, 'feeTypeName')
    const charges = get(fee, 'charges')
    const sum = sumOf(Array.isArray(charges) ? charges : [], charge => money(get(charge, 'aggregatedDetail', 'totalAmount')))
    if (typeof type !== 'string' || type === '' || sum.currency === null) continue
    fees[type] = round((fees[type] ?? 0) + sum.total)
    currency = currency ?? sum.currency
  }
  const ads = sumOf(Array.isArray(get(item, 'ads')) ? (get(item, 'ads') as unknown[]) : [], entry => money(get(entry, 'charge', 'totalAmount')))
  const cogs = money(get(item, 'cost', 'costOfGoodsSold'))
  const shipping = money(get(item, 'cost', 'fbaCost', 'shippingToAmazonCost'))
  const proceeds = money(get(item, 'netProceeds', 'total'))
  const asin = get(item, 'childAsin')
  return {
    msku,
    asin: typeof asin === 'string' && asin !== '' ? asin : null,
    date,
    currency: currency ?? 'USD',
    unitsOrdered: count(get(item, 'sales', 'unitsOrdered')) ?? 0,
    unitsRefunded: count(get(item, 'sales', 'unitsRefunded')) ?? 0,
    netUnits: count(get(item, 'sales', 'netUnitsSold')) ?? 0,
    orderedSales: ordered?.amount ?? 0,
    refundedSales: refunded?.amount ?? 0,
    sales: net.amount,
    fees,
    feesTotal: round(Object.values(fees).reduce((sum, value) => sum + value, 0)),
    adsSpend: round(ads.total),
    costPerUnit: cogs || shipping ? round((cogs?.amount ?? 0) + (shipping?.amount ?? 0)) : null,
    cost: cogs || shipping ? { cogs: cogs?.amount ?? null, shippingToAmazon: shipping?.amount ?? null } : null,
    netProceeds: proceeds?.amount ?? null,
  }
}

async function handle(ctx: ImportContext, row: Row, scope: KioskScope): Promise<RowOutcome> {
  const day = readEconomicsDay(row)
  if (!day) return 'skipped'
  const data = {
    asin: day.asin,
    currency: day.currency,
    unitsOrdered: day.unitsOrdered,
    unitsRefunded: day.unitsRefunded,
    netUnits: day.netUnits,
    orderedSales: day.orderedSales,
    refundedSales: day.refundedSales,
    sales: day.sales,
    feesTotal: day.feesTotal,
    feesJson: Object.entries(day.fees).map(([type, amount]) => ({ type, amount })) as Prisma.InputJsonValue,
    adsSpend: day.adsSpend,
    sellerCostPerUnit: day.costPerUnit,
    costJson: day.cost === null ? Prisma.DbNull : (day.cost as Prisma.InputJsonValue),
    netProceeds: day.netProceeds,
    syncedAt: new Date(),
  }
  const date = new Date(`${day.date}T00:00:00Z`)
  await ctx.prisma.economicsDaily.upsert({
    where: { tenantId_sellerAccountId_msku_date_aggregation: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, msku: day.msku, date, aggregation: 'DAY' } },
    create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, msku: day.msku, date, aggregation: 'DAY', ...data },
    update: data,
  })
  return 'imported'
}

export const economicsDailyDataset: DataKioskDataset = { id: ECONOMICS_DAILY_DATASET, buildQuery: buildEconomicsDailyQuery, handle, reportType: 'DATA_KIOSK_ECONOMICS' }

export function registerEconomicsDaily() {
  registerDataKioskDataset(economicsDailyDataset)
}
