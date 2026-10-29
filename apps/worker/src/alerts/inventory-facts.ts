import { US_MARKETPLACE_ID, isoPlusDays, type InventoryPolicy, type InboundKind, type OrderWindows } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { buildInventoryFact, type InventoryFact } from './inventory-fact'

// 库存预警的数据装配（P2a-15）：读出企业全部库存记录，批量补齐规划报告、库龄快照、滞留快照、商品名与订单汇总，逐行交给 buildInventoryFact。
// 读取方式与接口侧库存健康一致（每个店铺取最近一次快照日期的行）；一个企业的五条库存规则共用同一次读取（同一轮评估的 now 对象做键）。
// 必须在租户上下文里调用。

const READ_LIMIT = 20_000 // Prisma 单次读取上限
const DEFAULT_ZONE = 'America/Los_Angeles'

export interface InventoryFactSet {
  today: string
  policy: InventoryPolicy | null
  facts: InventoryFact[]
  /** 有店铺的库存记录超过单次读取上限，超出部分本轮没有评估 */
  truncated: boolean
}

const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
/** 此刻在企业时区的日历日；时区无效回退到美国太平洋时区。 */
export function todayInZone(zone: string | null | undefined, now: Date): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  try {
    return format(zone || DEFAULT_ZONE)
  } catch {
    return format(DEFAULT_ZONE)
  }
}

async function currentPolicy(db: PrismaClient, tenantId: string, today: string): Promise<InventoryPolicy | null> {
  const row = await db.replenishmentPolicy.findFirst({ where: { tenantId, level: 'TENANT', levelRef: 'ALL', effectiveFrom: { lte: asDate(today) } }, orderBy: { versionNo: 'desc' } })
  if (!row) return null
  return {
    versionNo: row.versionNo,
    level: 'TENANT',
    leadTimeDays: row.leadTimeDays,
    awdLeadTimeDays: row.awdLeadTimeDays,
    safetyDays: row.safetyDays,
    coverageDays: row.coverageDays,
    redundancyMultiplier: Number(row.redundancyMultiplier.toString()),
    inboundCounted: row.inboundCounted as InboundKind[],
    agingFromDays: row.agingFromDays as InventoryPolicy['agingFromDays'],
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    changeReason: row.changeReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/** 某店铺在该表里“最近一次快照日期”（没有记录为 null）。 */
async function latestDate(db: PrismaClient, table: 'inventoryPlanningSnapshot' | 'inventoryAgeSnapshot' | 'inventoryDailySnapshot', where: Record<string, unknown>): Promise<Date | null> {
  const delegate = db[table] as unknown as { aggregate(args: { where: Record<string, unknown>; _max: { snapshotDate: true } }): Promise<{ _max: { snapshotDate: Date | null } }> }
  return (await delegate.aggregate({ where, _max: { snapshotDate: true } }))._max.snapshotDate
}

/** 近 90 天（到昨天为止）的订单汇总，按 ASIN 聚合：与库存健康页相同的口径。 */
async function orderWindows(db: PrismaClient, tenantId: string, storeId: string, asins: string[], today: string): Promise<Map<string, OrderWindows>> {
  const result = new Map<string, OrderWindows>()
  if (asins.length === 0) return result
  const yesterday = asDate(isoPlusDays(today, -1))
  const base = { tenantId, sellerAccountId: storeId, asin: { in: asins } }
  const within = (days: number) => ({ ...base, summaryDate: { gte: asDate(isoPlusDays(today, -days)), lte: yesterday } })
  const sums = (days: number) => db.asinDailySummary.groupBy({ by: ['asin'], where: within(days), _sum: { units: true } })
  const [g7, g30, g60, g90, first, stock] = await Promise.all([
    sums(7),
    sums(30),
    sums(60),
    sums(90),
    db.asinDailySummary.groupBy({ by: ['asin'], where: within(90), _min: { summaryDate: true } }),
    db.asinDailySummary.groupBy({ by: ['asin'], where: { ...within(30), inventoryAvailable: 0 }, _sum: { units: true }, _count: { _all: true } }),
  ])
  const toMap = <T extends { asin: string }>(rows: T[]) => new Map(rows.map(row => [row.asin, row]))
  const [m7, m30, m60, m90, mStock] = [toMap(g7), toMap(g30), toMap(g60), toMap(g90), toMap(stock)]
  for (const row of first) {
    if (!row._min.summaryDate) continue
    result.set(row.asin, {
      units7: m7.get(row.asin)?._sum.units ?? 0,
      units30: m30.get(row.asin)?._sum.units ?? 0,
      units60: m60.get(row.asin)?._sum.units ?? 0,
      units90: m90.get(row.asin)?._sum.units ?? 0,
      firstSeen: row._min.summaryDate.toISOString().slice(0, 10),
      stockoutDays30: mStock.get(row.asin)?._count._all ?? 0,
      stockoutUnits30: mStock.get(row.asin)?._sum.units ?? 0,
    })
  }
  return result
}

async function loadOnce(db: PrismaClient, tenantId: string, now: Date): Promise<InventoryFactSet> {
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const today = todayInZone(tenant?.timezone, now)
  const policy = await currentPolicy(db, tenantId, today)
  const stores = await db.sellerAccount.findMany({ where: { tenantId }, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: 1000 })
  const facts: InventoryFact[] = []
  let truncated = false
  for (const store of stores) {
    const records = await db.fbaInventoryRecord.findMany({
      where: { tenantId, sellerAccountId: store.id, marketplaceId: US_MARKETPLACE_ID },
      orderBy: [{ sellerSku: 'asc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    if (records.length === 0) continue
    if (records.length >= READ_LIMIT) truncated = true
    const [planningDate, ageDate, strandedDate] = await Promise.all([
      latestDate(db, 'inventoryPlanningSnapshot', { tenantId, sellerAccountId: store.id }),
      latestDate(db, 'inventoryAgeSnapshot', { tenantId, sellerAccountId: store.id }),
      latestDate(db, 'inventoryDailySnapshot', { tenantId, sellerAccountId: store.id, source: 'STRANDED' }),
    ])
    const [planningRows, ageRows, strandedRows, products, orders] = await Promise.all([
      planningDate ? db.inventoryPlanningSnapshot.findMany({ where: { tenantId, sellerAccountId: store.id, snapshotDate: planningDate }, take: READ_LIMIT }) : [],
      ageDate ? db.inventoryAgeSnapshot.findMany({ where: { tenantId, sellerAccountId: store.id, snapshotDate: ageDate }, take: READ_LIMIT }) : [],
      strandedDate
        ? db.inventoryDailySnapshot.findMany({
            where: { tenantId, sellerAccountId: store.id, source: 'STRANDED', snapshotDate: strandedDate },
            select: { sku: true, stranded: true, strandedReason: true },
            take: READ_LIMIT,
          })
        : [],
      db.fbaProduct.findMany({ where: { tenantId, sellerAccountId: store.id }, select: { sellerSku: true, title: true }, take: READ_LIMIT }),
      orderWindows(db, tenantId, store.id, [...new Set(records.map(record => record.asin).filter(Boolean))], today),
    ])
    const planning = new Map(planningRows.map(row => [row.sku, row]))
    const ages = new Map(ageRows.map(row => [row.sku, row]))
    const stranded = new Map(strandedRows.map(row => [row.sku, { qty: row.stranded, reason: row.strandedReason }]))
    const titles = new Map(products.map(product => [product.sellerSku, product.title]))
    for (const record of records) {
      facts.push(
        buildInventoryFact({
          store: { id: store.id, name: store.displayName },
          record,
          title: titles.get(record.sellerSku) ?? null,
          planning: planning.get(record.sellerSku) ?? null,
          age: ages.get(record.sellerSku) ?? null,
          stranded: stranded.get(record.sellerSku) ?? null,
          orders: orders.get(record.asin) ?? null,
          policy,
          today,
        }),
      )
    }
  }
  return { today, policy, facts, truncated }
}

const cache = new WeakMap<Date, Map<string, Promise<InventoryFactSet>>>()

/** 同一轮评估（同一个 now 对象）里同一个企业只读一次。 */
export function loadInventoryFacts(db: PrismaClient, tenantId: string, now: Date): Promise<InventoryFactSet> {
  let perTenant = cache.get(now)
  if (!perTenant) {
    perTenant = new Map()
    cache.set(now, perTenant)
  }
  let loaded = perTenant.get(tenantId)
  if (!loaded) {
    loaded = loadOnce(db, tenantId, now)
    perTenant.set(tenantId, loaded)
  }
  return loaded
}
