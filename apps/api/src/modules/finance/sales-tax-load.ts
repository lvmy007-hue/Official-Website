import {
  SALES_TAX_AVAILABILITY_LABEL,
  SALES_TAX_AVAILABILITY_NOTE,
  SALES_TAX_CURRENCY,
  SALES_TAX_FRESHNESS_KEY,
  SALES_TAX_JURISDICTION_LIMIT,
  TAX_NOT_GENERATED,
  TAX_ROLE_PENDING,
  addDaysText,
  freshnessErrorMessage,
  roundCash,
  taxKindLabel,
  type SalesTaxAvailability,
  type SalesTaxJurisdictionRow,
  type SalesTaxStateRow,
  type SalesTaxStoreStatus,
  type TaxWindow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate } from '../overview'
import type { Store } from './cashflow-load'

// 销售税的取数（P2b-12）：只读，一律带企业与数据范围条件。
// 税务文档库报告已在导入时按（日期、州、辖区、税种）汇总，这里用数据库汇总再按州归并；订单接口的税只给总额（不含收货州），按月汇总。
// 没有数据返回 null（页面写“尚无记录”），不返回 0。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const REPORT_SOURCE = 'TAX_LIBRARY'

const reportWhere = (tenantId: string, scope: ResolvedScope, from: string, to: string): Prisma.SalesTaxSummaryWhereInput => ({
  tenantId,
  ...storeWhere(scope),
  source: REPORT_SOURCE,
  taxPeriod: { gte: asDate(from), lte: asDate(to) },
})

export interface ReportStates {
  states: SalesTaxStateRow[]
  taxCollected: number | null
  taxableSales: number | null
  truncated: boolean
}

/** 按州汇总，再带出每个州的辖区明细（最多读 SALES_TAX_JURISDICTION_LIMIT 行，超出就标记被截断；各州合计不受影响）。 */
export async function loadReportStates(prisma: PrismaService, tenantId: string, scope: ResolvedScope, from: string, to: string): Promise<ReportStates> {
  const where = reportWhere(tenantId, scope, from, to)
  const [byState, byJurisdiction] = await Promise.all([
    prisma.salesTaxSummary.groupBy({ by: ['state'], where, _sum: { taxCollected: true, taxableSales: true, lineCount: true }, orderBy: { state: 'asc' }, take: 500 }),
    prisma.salesTaxSummary.groupBy({
      by: ['state', 'jurisdictionKey', 'taxKind'],
      where,
      _sum: { taxCollected: true, taxableSales: true, lineCount: true },
      orderBy: [{ state: 'asc' }, { jurisdictionKey: 'asc' }, { taxKind: 'asc' }],
      take: SALES_TAX_JURISDICTION_LIMIT + 1,
    }),
  ])
  const truncated = byJurisdiction.length > SALES_TAX_JURISDICTION_LIMIT
  const details = new Map<string, SalesTaxJurisdictionRow[]>()
  for (const row of byJurisdiction.slice(0, SALES_TAX_JURISDICTION_LIMIT)) {
    const list = details.get(row.state) ?? []
    list.push({
      jurisdictionKey: row.jurisdictionKey,
      taxKind: row.taxKind,
      taxKindLabel: taxKindLabel(row.taxKind),
      taxableSales: num(row._sum.taxableSales),
      taxCollected: roundCash(num(row._sum.taxCollected) ?? 0),
      lineCount: row._sum.lineCount ?? 0,
    })
    details.set(row.state, list)
  }
  const total = byState.length === 0 ? null : roundCash(byState.reduce((sum, row) => sum + (num(row._sum.taxCollected) ?? 0), 0))
  const sales = byState.filter(row => row._sum.taxableSales !== null)
  const states = byState
    .map<SalesTaxStateRow>(row => {
      const taxCollected = roundCash(num(row._sum.taxCollected) ?? 0)
      return {
        state: row.state,
        taxableSales: num(row._sum.taxableSales),
        taxCollected,
        lineCount: row._sum.lineCount ?? 0,
        share: total ? Math.round((taxCollected / total) * 10_000) / 10_000 : null,
        jurisdictions: (details.get(row.state) ?? []).sort((a, b) => b.taxCollected - a.taxCollected || a.jurisdictionKey.localeCompare(b.jurisdictionKey)),
      }
    })
    .sort((a, b) => b.taxCollected - a.taxCollected || a.state.localeCompare(b.state))
  return { states, taxCollected: total, taxableSales: sales.length === 0 ? null : roundCash(sales.reduce((sum, row) => sum + (num(row._sum.taxableSales) ?? 0), 0)), truncated }
}

/** 每个月、每家店的报告税额合计（有记录才有值，没有记录没有这一项）。 */
export async function loadReportMonthly(prisma: PrismaService, tenantId: string, scope: ResolvedScope, windows: readonly TaxWindow[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  const lists = await Promise.all(
    windows.map(window =>
      prisma.salesTaxSummary.groupBy({
        by: ['sellerAccountId'],
        where: reportWhere(tenantId, scope, window.from, window.to),
        _sum: { taxCollected: true },
        orderBy: { sellerAccountId: 'asc' },
        take: 500,
      }),
    ),
  )
  lists.forEach((rows, index) => {
    for (const row of rows) result.set(`${row.sellerAccountId}|${windows[index]!.month}`, roundCash(num(row._sum.taxCollected) ?? 0))
  })
  return result
}

/** 每个月、每家店的订单接口税额合计：按下单时间（UTC 日历日）汇总，只算美元（目前只有美国站）。 */
export async function loadOrdersMonthly(prisma: PrismaService, tenantId: string, scope: ResolvedScope, windows: readonly TaxWindow[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  const lists = await Promise.all(
    windows.map(window =>
      prisma.orderCharge.groupBy({
        by: ['sellerAccountId'],
        where: { tenantId, ...storeWhere(scope), chargeKind: 'TAX', currency: SALES_TAX_CURRENCY, purchaseDate: { gte: asDate(window.from), lt: asDate(addDaysText(window.to, 1)) } },
        _sum: { amount: true },
        orderBy: { sellerAccountId: 'asc' },
        take: 500,
      }),
    ),
  )
  lists.forEach((rows, index) => {
    for (const row of rows) result.set(`${row.sellerAccountId}|${windows[index]!.month}`, roundCash(num(row._sum.amount) ?? 0))
  })
  return result
}

/** 每家店税务文档库报告的取得情况：同步任务的最近结果（没有记录就是“尚无记录”，不猜）。 */
export async function loadStoreStatuses(prisma: PrismaService, tenantId: string, scope: ResolvedScope, stores: readonly Store[]): Promise<SalesTaxStoreStatus[]> {
  const rows = await prisma.dataFreshness.findMany({
    where: { tenantId, sourceKey: SALES_TAX_FRESHNESS_KEY, ...storeWhere(scope) },
    select: { sellerAccountId: true, status: true, lastErrorCode: true, lastSuccessAt: true },
    take: 1000,
  })
  const byStore = new Map(rows.flatMap(row => (row.sellerAccountId ? [[row.sellerAccountId, row] as const] : [])))
  return stores.map<SalesTaxStoreStatus>(store => {
    const row = byStore.get(store.id)
    let state: SalesTaxAvailability = 'NO_RECORD'
    if (row) {
      if (row.status === 'NORMAL') state = 'AVAILABLE'
      else if (row.lastErrorCode === TAX_ROLE_PENDING) state = 'ROLE_PENDING'
      else if (row.lastErrorCode === TAX_NOT_GENERATED) state = 'NOT_GENERATED'
      else state = 'FAILED'
    }
    return {
      sellerAccountId: store.id,
      storeName: store.name,
      state,
      stateLabel: SALES_TAX_AVAILABILITY_LABEL[state],
      note: state === 'FAILED' ? (freshnessErrorMessage(row?.lastErrorCode) ?? '同步失败，请稍后重试或查看同步中心') : SALES_TAX_AVAILABILITY_NOTE[state],
      lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    }
  })
}
