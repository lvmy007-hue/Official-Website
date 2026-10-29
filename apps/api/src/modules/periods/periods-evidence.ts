import {
  FX_BASE_CURRENCY,
  PERIOD_SETTLEMENT_LIMIT,
  PERIOD_SYNC_SOURCES,
  STORE_LEVEL_SKU,
  evaluateAds,
  evaluateCostCoverage,
  evaluateFx,
  evaluateRecon,
  evaluateSettlements,
  evaluateSync,
  type CheckEval,
  type CheckKey,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { addDays, asDate, dateText, eachDay, localDate, zonedDayStart } from '../overview'
import type { Db } from './periods-common'

// 完整性检查的取数（P2b-13）：六个检查项各自读一类数据，判定规则在合同包的纯函数里。全部只读，不改任何数据。
// 日期都按企业口径时区；利润日表的行用“店铺 + 期间日期范围”过滤。

export interface PeriodTarget {
  tenantId: string
  sellerAccountId: string
  start: string
  end: string
  zone: string
}

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

export const profitRange = (target: PeriodTarget): Prisma.ProfitDailyWhereInput => ({
  tenantId: target.tenantId,
  sellerAccountId: target.sellerAccountId,
  profitDate: { gte: asDate(target.start), lte: asDate(target.end) },
})

async function syncEval(db: Db, target: PeriodTarget): Promise<CheckEval> {
  const rows = await db.dataFreshness.findMany({
    where: { tenantId: target.tenantId, sellerAccountId: target.sellerAccountId, sourceKey: { in: PERIOD_SYNC_SOURCES.map(source => source.key) } },
    select: { sourceKey: true, status: true, dataThrough: true, lastSuccessAt: true },
    take: 20,
  })
  const facts = PERIOD_SYNC_SOURCES.map(source => {
    const row = rows.find(item => item.sourceKey === source.key)
    return { key: source.key, label: source.label, status: row?.status ?? null, coveredThrough: row ? (row.dataThrough ?? row.lastSuccessAt) : null }
  })
  return evaluateSync(facts, zonedDayStart(addDays(target.end, 1), target.zone))
}

async function settlementEval(db: Db, target: PeriodTarget): Promise<CheckEval> {
  const rows = await db.fbaSettlement.findMany({
    where: {
      tenantId: target.tenantId,
      sellerAccountId: target.sellerAccountId,
      settlementEndDate: { gte: zonedDayStart(target.start, target.zone) },
      settlementStartDate: { lt: zonedDayStart(addDays(target.end, 1), target.zone) },
    },
    select: { externalSettlementId: true, settlementEndDate: true, txnCount: true },
    orderBy: [{ settlementEndDate: 'desc' }, { id: 'asc' }],
    take: PERIOD_SETTLEMENT_LIMIT,
  })
  return evaluateSettlements(
    rows.map(row => ({ externalSettlementId: row.externalSettlementId, endDate: row.settlementEndDate ? localDate(row.settlementEndDate, target.zone) : null, txnCount: row.txnCount })),
    target.end,
  )
}

async function costEval(db: Db, target: PeriodTarget): Promise<CheckEval> {
  const sum = await db.profitDaily.aggregate({ where: { ...profitRange(target), basis: 'ORDERED', sku: { not: STORE_LEVEL_SKU } }, _sum: { units: true, costedUnits: true }, _count: { _all: true } })
  return evaluateCostCoverage({ rows: sum._count._all, units: sum._sum.units ?? 0, costedUnits: sum._sum.costedUnits ?? 0 })
}

async function fxEval(db: Db, target: PeriodTarget): Promise<CheckEval> {
  const where = profitRange(target)
  const [missingRows, fallbackRows, used] = await Promise.all([
    db.profitDaily.count({ where: { ...where, flags: { has: 'FX_MISSING' } } }),
    db.profitDaily.count({ where: { ...where, flags: { has: 'FX_FALLBACK' } } }),
    db.profitDaily.groupBy({ by: ['costCurrency'], where: { ...where, costCurrency: { not: null } }, orderBy: { costCurrency: 'asc' }, take: 50 }),
  ])
  const currencies = used.flatMap(item => (item.costCurrency && item.costCurrency !== FX_BASE_CURRENCY ? [item.costCurrency] : []))
  const rates =
    currencies.length === 0
      ? []
      : await db.fxRate.findMany({
          where: { tenantId: target.tenantId, quoteCurrency: { in: currencies }, rateDate: { gte: asDate(target.start), lte: asDate(target.end) } },
          select: { quoteCurrency: true, rateDate: true },
          take: 20_000,
        })
  const days = eachDay(target.start, target.end)
  const missingDays = currencies.map(currency => {
    const have = new Set(rates.filter(rate => rate.quoteCurrency === currency).map(rate => dateText(rate.rateDate)))
    return { currency, days: days.filter(day => !have.has(day)) }
  })
  return evaluateFx({ missingRows, fallbackRows, currencies, missingDays })
}

async function adsEval(db: Db, target: PeriodTarget): Promise<CheckEval> {
  const where = { ...profitRange(target), basis: 'ORDERED' }
  const [rows, allocatedRows, left] = await Promise.all([
    db.profitDaily.count({ where }),
    db.profitDaily.count({ where: { ...where, adsSpendAllocated: { not: null } } }),
    db.profitDaily.aggregate({ where, _sum: { adsUnallocated: true } }),
  ])
  return evaluateAds({ rows, allocatedRows, unallocated: num(left._sum.adsUnallocated) })
}

async function reconEval(db: Db, target: PeriodTarget): Promise<CheckEval> {
  const sum = await db.reconciliationException.aggregate({
    where: {
      tenantId: target.tenantId,
      status: 'OPEN',
      reconciliation: { sellerAccountId: target.sellerAccountId, rangeStart: { lte: asDate(target.end) }, rangeEnd: { gte: asDate(target.start) } },
    },
    _count: { _all: true },
    _sum: { absAmount: true },
  })
  return evaluateRecon({ open: sum._count._all, absTotal: num(sum._sum.absAmount) })
}

/** 六个检查项的当前判定。 */
export async function gatherEvals(db: Db, target: PeriodTarget): Promise<Record<CheckKey, CheckEval>> {
  const [SYNC_COMPLETE, SETTLEMENTS_ARRIVED, COST_COVERAGE, FX_COMPLETE, ADS_ALLOCATED, RECON_EXCEPTIONS] = await Promise.all([
    syncEval(db, target),
    settlementEval(db, target),
    costEval(db, target),
    fxEval(db, target),
    adsEval(db, target),
    reconEval(db, target),
  ])
  return { SYNC_COMPLETE, SETTLEMENTS_ARRIVED, COST_COVERAGE, FX_COMPLETE, ADS_ALLOCATED, RECON_EXCEPTIONS }
}
