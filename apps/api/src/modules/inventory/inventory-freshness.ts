import {
  aggregateFreshness,
  APLUS_FRESHNESS_KEY,
  CATALOG_FRESHNESS_KEY,
  COMPETITOR_FRESHNESS_KEY,
  FEEDBACK_FRESHNESS_KEY,
  DATASET_FRESHNESS_SOURCES,
  FRESHNESS_SOURCES,
  JOB_FRESHNESS_SOURCES,
  PRICING_FRESHNESS_KEY,
  REPORT_FRESHNESS_SOURCES,
  SALES_TAX_FRESHNESS_KEY,
  SETTLEMENT_FRESHNESS_KEY,
  type FreshnessSourceSpec,
  type InventoryFreshness,
} from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { storeWhere } from '../auth'

// 库存类页面的数据新鲜度：库存接口与库存相关报告里与本页有关的来源（范围内最近成功时间、需要关注的来源数）。
// 结算报告（P2b-07）与销售税报告（P2b-12）按同步任务类型登记，不属于报告类型表，这里单独并入；数据中心数据集（P2b-11）同理
const ALL_SOURCES: readonly FreshnessSourceSpec[] = [
  ...FRESHNESS_SOURCES,
  ...REPORT_FRESHNESS_SOURCES,
  ...JOB_FRESHNESS_SOURCES.filter(
    source =>
      source.key === SETTLEMENT_FRESHNESS_KEY ||
      source.key === SALES_TAX_FRESHNESS_KEY ||
      source.key === CATALOG_FRESHNESS_KEY ||
      source.key === PRICING_FRESHNESS_KEY ||
      source.key === COMPETITOR_FRESHNESS_KEY ||
      source.key === FEEDBACK_FRESHNESS_KEY ||
      source.key === APLUS_FRESHNESS_KEY,
  ),
  ...DATASET_FRESHNESS_SOURCES,
]
const INVENTORY_KEYS = ['inventory.api', 'rpt.inventory-planning', 'rpt.reserved-inventory', 'rpt.stranded-inventory', 'rpt.storage-fee'] as const
/** 台账页：台账汇总与明细两份报告，以及用来比对的库存接口。 */
export const LEDGER_KEYS = ['rpt.ledger-summary', 'rpt.ledger-detail', 'inventory.api'] as const
/** 移除与弃置页：移除订单、移除货件、推荐移除三份报告。 */
export const REMOVAL_KEYS = ['rpt.removal-order', 'rpt.removal-shipment', 'rpt.recommended-removal'] as const
/** 仓储容量与费用页：三份费用报告与库存规划报告（体积、库龄预估来自它）。 */
export const CAPACITY_KEYS = ['rpt.storage-fee', 'rpt.overage-fee', 'rpt.longterm-storage-fee', 'rpt.inventory-planning'] as const

export async function sourceFreshness(prisma: PrismaService, tenantId: string, scope: ResolvedScope, keys: readonly string[], now = new Date()): Promise<InventoryFreshness> {
  const wanted = new Set(keys)
  const specs = ALL_SOURCES.filter(source => wanted.has(source.key))
  const [stores, rows] = await Promise.all([
    prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true }, take: 500 }),
    prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: { in: [...wanted] }, ...storeWhere(scope) },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 5000,
    }),
  ])
  const view = aggregateFreshness(
    rows,
    stores.map(store => store.id),
    now,
    specs,
  )
  const done = view.sources.filter(source => source.lastSuccessAt)
  const latest = done.reduce<Date | null>((max, source) => (source.lastSuccessAt && (!max || source.lastSuccessAt > max) ? source.lastSuccessAt : max), null)
  return { lastSuccessAt: latest?.toISOString() ?? null, sources: done.map(source => source.label), qualityIssues: view.summary.attention }
}

export const inventoryFreshness = (prisma: PrismaService, tenantId: string, scope: ResolvedScope, now = new Date()) => sourceFreshness(prisma, tenantId, scope, INVENTORY_KEYS, now)
