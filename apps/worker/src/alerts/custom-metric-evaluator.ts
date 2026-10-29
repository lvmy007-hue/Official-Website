import {
  CUSTOM_METRIC_MAX_STORES,
  CUSTOM_METRIC_TYPE,
  METRIC_DEFINITIONS,
  buildRuleCatalog,
  conditionValuesOf,
  describeConditions,
  evaluateConditions,
  localDateOf,
  loadStoreMetricData,
  ruleMetricsOf,
  unsupportedRuleMetrics,
  validateConditions,
  type ConditionGroups,
  type InventoryDayRow,
  type RuleMetricReader,
  type StoreDayRow,
  type TrafficDayRow,
} from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'

// 自定义指标规则的评估器（P6-16，16 章第 9 节）：条件来自 P6-07 的 ConditionGroups，worker 用 evaluateConditions 判断，
// 取数走统一的指标取数层（api-contracts 的 rule-metric-source，API 的“试算”接口用同一份），按店铺逐个判断，命中的店铺生成预警。
// 限制：一次评估最多判断 CUSTOM_METRIC_MAX_STORES 个店铺（按编号排序取前面的）；整体取数超时就放弃这条规则本轮的评估（评估框架计入规则错误数，
// 已有预警保持原样，不会因为超时被当作“恢复”）；条件里还没接入取数层的指标取不到数，对应条件不触发（保存规则时 API 已拒绝这类指标）。

export const CUSTOM_METRIC_TIMEOUT_MS = 20_000
const READ_LIMIT = 20_000

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const day = (date: Date) => date.toISOString().slice(0, 10)
const dateOf = (value: string) => new Date(`${value}T00:00:00Z`)

type ReaderDb = Pick<PrismaClient, 'storeDailySummary' | 'salesTrafficDaily' | 'inventoryDailySnapshot'>

/** 从日汇总表读出取数层需要的行（API 的试算有一份同样的读取，改口径时两处一起改）。 */
export function prismaRuleMetricReader(db: ReaderDb): RuleMetricReader {
  return {
    async storeDays(tenantId, storeIds, from, to) {
      const rows = await db.storeDailySummary.findMany({
        where: { tenantId, sellerAccountId: { in: [...storeIds] }, summaryDate: { gte: dateOf(from), lte: dateOf(to) } },
        select: { sellerAccountId: true, summaryDate: true, orders: true, units: true, salesAmount: true, adsSpend: true, adsSales: true, profit: true, sessions: true },
        take: READ_LIMIT,
      })
      return rows.map<StoreDayRow & { storeId: string }>(row => ({
        storeId: row.sellerAccountId,
        date: day(row.summaryDate),
        orders: row.orders,
        units: row.units,
        sales: num(row.salesAmount) ?? 0,
        adsSpend: num(row.adsSpend),
        adsSales: num(row.adsSales),
        profit: num(row.profit),
        sessions: row.sessions,
      }))
    },
    async trafficDays(tenantId, storeIds, from, to) {
      const rows = await db.salesTrafficDaily.findMany({
        where: { tenantId, sellerAccountId: { in: [...storeIds] }, granularity: 'DAY', date: { gte: dateOf(from), lte: dateOf(to) } },
        select: { sellerAccountId: true, date: true, unitsOrdered: true, unitsRefunded: true },
        orderBy: { syncedAt: 'asc' },
        take: READ_LIMIT,
      })
      return rows.map<TrafficDayRow & { storeId: string }>(row => ({ storeId: row.sellerAccountId, date: day(row.date), unitsOrdered: row.unitsOrdered, unitsRefunded: row.unitsRefunded }))
    },
    async inventoryDays(tenantId, storeIds, from, to) {
      // 同一天同一商品可能有多个来源的快照：按来源分别合计，取各来源合计里最大的一个（来源之间报的是同一批库存，不能相加）
      const rows = await db.inventoryDailySnapshot.groupBy({
        by: ['sellerAccountId', 'snapshotDate', 'source'],
        where: { tenantId, sellerAccountId: { in: [...storeIds] }, snapshotDate: { gte: dateOf(from), lte: dateOf(to) }, sellable: { not: null } },
        _sum: { sellable: true },
        orderBy: [{ sellerAccountId: 'asc' }, { snapshotDate: 'asc' }, { source: 'asc' }],
        take: READ_LIMIT,
      })
      const best = new Map<string, InventoryDayRow & { storeId: string }>()
      for (const row of rows) {
        const sellable = num(row._sum.sellable)
        if (sellable === null) continue
        const key = `${row.sellerAccountId}|${day(row.snapshotDate)}`
        const current = best.get(key)
        if (!current || sellable > current.sellable) best.set(key, { storeId: row.sellerAccountId, date: day(row.snapshotDate), sellable })
      }
      return [...best.values()]
    },
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`自定义指标规则取数超过 ${ms} 毫秒，本轮跳过`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

const CATALOG = buildRuleCatalog(ruleMetricsOf(METRIC_DEFINITIONS))
const ids = (value: unknown): string[] | null => (Array.isArray(value) && value.length > 0 ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : null)

export async function evaluateCustomMetric(
  context: { db: PrismaClient; tenantId: string; rule: { name: string; scope: Record<string, unknown>; conditionGroups: ConditionGroups | null }; now: Date },
  options: { reader?: RuleMetricReader; timeoutMs?: number } = {},
): Promise<AlertHit[]> {
  const { db, tenantId, rule, now } = context
  const groups = rule.conditionGroups
  if (!groups) return []
  const issues = validateConditions(groups, CATALOG)
  if (issues.length > 0) throw new Error(`自定义指标规则的条件无效：${issues[0].message}`)
  const wanted = ids(rule.scope.sellerAccountIds)
  const stores = await db.sellerAccount.findMany({
    where: { tenantId, ...(wanted ? { id: { in: wanted } } : {}) },
    select: { id: true, displayName: true },
    orderBy: { id: 'asc' },
    take: CUSTOM_METRIC_MAX_STORES,
  })
  if (stores.length === 0) return []
  const zone = (await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }))?.timezone ?? null
  const today = localDateOf(now, zone)
  const data = await withTimeout(
    loadStoreMetricData(
      options.reader ?? prismaRuleMetricReader(db),
      tenantId,
      stores.map(store => store.id),
      groups,
      [today],
    ),
    options.timeoutMs ?? CUSTOM_METRIC_TIMEOUT_MS,
  )
  const text = describeConditions(groups, CATALOG)
  const skipped = unsupportedRuleMetrics(groups)
  const hits: AlertHit[] = []
  for (const store of stores) {
    const metricData = data.get(store.id)
    if (!metricData) continue
    const evaluation = evaluateConditions(groups, conditionValuesOf(metricData, today))
    if (!evaluation.triggered) continue
    const matched = evaluation.groups.flatMap((group, groupIndex) =>
      group.triggered ? group.conditions.map((result, conditionIndex) => ({ result, condition: groups.groups[groupIndex].conditions[conditionIndex] })) : [],
    )
    hits.push({
      entityType: 'STORE',
      entityId: store.id,
      sellerAccountId: store.id,
      entityLabel: store.displayName,
      title: `${rule.name}：${store.displayName}`,
      suggestedAction: `店铺满足条件“${text}”，请到对应页面核查原因`,
      evidence: {
        asOf: today,
        condition: text,
        storeName: store.displayName,
        matched: matched.map(({ result, condition }) => ({
          metric: condition.metric,
          metricName: CATALOG.get(condition.metric)?.name ?? condition.metric,
          current: result.current,
          previous: result.previous,
          value: result.value,
          op: condition.op,
          threshold: condition.threshold,
        })),
        ...(skipped.length > 0 ? { unsupportedMetrics: skipped } : {}),
      },
    })
  }
  return hits
}

export const customMetricEvaluator: AlertEvaluator = {
  type: CUSTOM_METRIC_TYPE,
  evaluate: ({ db, tenantId, rule, now }) => evaluateCustomMetric({ db, tenantId, rule, now }),
}
