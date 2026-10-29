import { PROFIT_BASES, PROFIT_DERIVE_TASK, PROFIT_RECENT_DAYS, type ProfitBasis } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { tenantTimeZone } from '../derivers/summary-sql'
import type { DeriveTask } from '../derivers/derive'
import { loadAdsAttribution, loadAllocationBasis } from './ads-attribution-load'
import { assembleProfit, type ProfitRow } from './assemble'
import { loadEstimates } from './estimated-fees-load'
import { loadAllocation } from './fee-allocation-load'
import { loadAds, loadCostStreams, loadCosting, loadDictionary, loadFx } from './load'
import { loadFeeLines, loadSales } from './sql'
import { writeProfit } from './write'

// 利润日表的派生任务（P2b-09）：对一个企业的一段日期，三种收入确认口径各算一遍，先删后写（可重复执行）。
// 触发：订单、财务、广告同步完成后（见 derivers/trigger.ts），以及每 6 小时对最近 45 天重算一次
// （汇率更新、成本版本生效、迟到的费用都会改变近期的数字；成本版本生效目前没有即时触发，等下一轮定时重算）。

export const PROFIT_SOURCES = ['orders', 'finance', 'ads', 'cost'] as const
const DAY_MS = 86_400_000

export interface ProfitRange {
  tenantId: string
  dateFrom: string
  dateTo: string
}

/** 企业时区的日历日（YYYY-MM-DD）。 */
export function dayInZone(date: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** 已经在企业的租户上下文里时调用。返回写入的行数。 */
export async function refreshProfitDaily(db: PrismaClient, range: ProfitRange, now: Date = new Date()): Promise<number> {
  const { tenantId } = range
  const timeZone = await tenantTimeZone(db, tenantId)
  const days = { from: range.dateFrom, to: range.dateTo }
  const [setting, cost, ads, attribution, adsBasis, dictionary] = await Promise.all([
    loadCosting(db, tenantId),
    loadCostStreams(db, tenantId),
    loadAds(db, tenantId, days),
    loadAdsAttribution(db, tenantId, days),
    loadAllocationBasis(db, tenantId),
    loadDictionary(db, tenantId),
  ])
  const fx = await loadFx(db, tenantId, cost.currencies, days)
  const allocation = await loadAllocation(db, tenantId, days)
  const estimates = await loadEstimates(db, tenantId, days, timeZone, dictionary)
  // 先进先出等方法要从最早的入库批次开始接着消耗，所以件数往前读到最早批次那天；金额只写 days 范围内的行
  let historyFrom = cost.earliest && cost.earliest < days.from ? cost.earliest : days.from
  // 费用分摊的销售额、销量权重按整月取：有规则时销售至少读到起始月第一天（P6-19）
  const monthStart = `${days.from.slice(0, 7)}-01`
  if (allocation.rules.length > 0 && monthStart < historyFrom) historyFrom = monthStart
  const rows: ProfitRow[] = []
  for (const basis of PROFIT_BASES as readonly ProfitBasis[]) {
    const [sales, fees] = await Promise.all([
      loadSales(db, basis, { tenantId, from: historyFrom, to: days.to, timeZone }),
      loadFeeLines(db, basis, { tenantId, from: days.from, to: days.to, timeZone }),
    ])
    rows.push(
      ...assembleProfit({
        basis,
        costing: setting.costing,
        costingValid: setting.valid,
        range: days,
        today: dayInZone(now, timeZone),
        sales,
        fees,
        streams: cost.streams,
        draftOnly: cost.draftOnly,
        fx,
        ads,
        attribution,
        adsBasis,
        dictionary,
        allocation: dictionary ? allocation : undefined,
        estimates: dictionary ? estimates : undefined,
      }),
    )
  }
  return writeProfit(db, tenantId, days, rows, now)
}

export function createProfitTask(db: PrismaClient): DeriveTask {
  return {
    name: PROFIT_DERIVE_TASK,
    sources: PROFIT_SOURCES,
    refresh: async context => ({ rows: await refreshProfitDaily(db, { tenantId: context.tenantId, dateFrom: context.dateFrom, dateTo: context.dateTo }) }),
  }
}

type Logger = { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }
export interface ProfitAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  logger: Logger
  now?: () => Date
}

/** 逐个企业重算最近 PROFIT_RECENT_DAYS 天；单个企业出错不拖垮其它企业。结束日多放宽一天，覆盖企业时区比世界时早的情况。 */
export async function refreshAllTenants(deps: ProfitAllDeps) {
  const now = deps.now?.() ?? new Date()
  const range = { dateFrom: new Date(now.getTime() - (PROFIT_RECENT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10), dateTo: new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10) }
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let rows = 0
  for (const tenant of tenants) {
    try {
      rows += await runWithTenant(tenant.id, () => refreshProfitDaily(deps.db, { tenantId: tenant.id, ...range }, now))
    } catch (error) {
      deps.logger.warn({ event: 'profit_refresh_failed', error: error instanceof Error ? error.message : String(error) }, 'profit refresh failed for a tenant')
    }
  }
  return { tenants: tenants.length, rows }
}
