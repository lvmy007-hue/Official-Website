import { ALLOCATION_BASES, DEFAULT_POLICY, PROFIT_CURRENCY, type AllocationBasis } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { AdsAttribution } from './types'

// 广告分摊要用的数据（P3-16）：广告商品报表里各 ASIN 的花费、店铺的 ASIN → SKU 对照、财务口径里生效的广告分摊规则。都在租户上下文里读。

type Db = Pick<PrismaClient, 'adsProfile' | 'adsAdvertisedProductMetric' | 'fbaProduct' | 'financePolicyVersion'>
const DAY_MS = 86_400_000
const CAP = 20_000
const CHUNK = 500
const dayText = (value: Date) => value.toISOString().slice(0, 10)
const chunks = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))

/**
 * 广告商品报表（被推广商品日报表）按 店铺 × 日 × ASIN 合计的花费：只取已绑定店铺的美元档案，花费为空的行不算。
 * ASIN → SKU 对照只为报表里出现过的 ASIN 读取（商品目录里同一店铺同一 ASIN 的全部 SKU）。
 */
export async function loadAdsAttribution(db: Db, tenantId: string, range: { from: string; to: string }): Promise<AdsAttribution> {
  const out: AdsAttribution = { direct: new Map(), asinSkus: new Map() }
  const profiles = await db.adsProfile.findMany({ where: { tenantId, sellerAccountId: { not: null }, currencyCode: PROFIT_CURRENCY }, select: { id: true, sellerAccountId: true }, take: 2000 })
  if (profiles.length === 0) return out
  const storeOf = new Map(profiles.map(profile => [profile.id, profile.sellerAccountId as string]))
  const sums = await db.adsAdvertisedProductMetric.groupBy({
    by: ['adsProfileId', 'advertisedAsin', 'reportDate'],
    where: {
      tenantId,
      adsProfileId: { in: [...storeOf.keys()] },
      currency: PROFIT_CURRENCY,
      spend: { not: null },
      reportDate: { gte: new Date(`${range.from}T00:00:00Z`), lt: new Date(Date.parse(`${range.to}T00:00:00Z`) + DAY_MS) },
    },
    _sum: { spend: true },
  })
  const asinsByStore = new Map<string, Set<string>>()
  for (const row of sums) {
    const spend = row._sum.spend === null ? 0 : Number(row._sum.spend.toString())
    if (!(spend > 0)) continue
    const store = storeOf.get(row.adsProfileId) as string
    const days = out.direct.get(store) ?? new Map<string, Map<string, number>>()
    const day = dayText(row.reportDate)
    const asins = days.get(day) ?? new Map<string, number>()
    asins.set(row.advertisedAsin, (asins.get(row.advertisedAsin) ?? 0) + spend)
    days.set(day, asins)
    out.direct.set(store, days)
    const set = asinsByStore.get(store) ?? new Set<string>()
    set.add(row.advertisedAsin)
    asinsByStore.set(store, set)
  }
  for (const [store, asins] of asinsByStore) {
    const bucket = new Map<string, string[]>()
    for (const part of chunks([...asins], CHUNK)) {
      const products = await db.fbaProduct.findMany({ where: { tenantId, sellerAccountId: store, asin: { in: part } }, select: { asin: true, sellerSku: true }, take: CAP })
      for (const product of products) bucket.set(product.asin, [...(bucket.get(product.asin) ?? []), product.sellerSku])
    }
    out.asinSkus.set(store, bucket)
  }
  return out
}

/**
 * 每一天适用的广告分摊规则：财务口径版本里生效中与已被替换的版本，取生效日不晚于这一天的最新一个（同生效日取版本号大的）；
 * 没有任何版本适用，或取值不合法，用默认口径（按销售额）。
 */
export async function loadAllocationBasis(db: Pick<Db, 'financePolicyVersion'>, tenantId: string): Promise<(day: string) => AllocationBasis> {
  const rows = await db.financePolicyVersion.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'REPLACED'] } },
    orderBy: [{ effectiveFrom: 'asc' }, { versionNo: 'asc' }],
    select: { effectiveFrom: true, adsAllocationMode: true },
    take: 1000,
  })
  const versions = rows.map(row => ({ from: dayText(row.effectiveFrom), mode: row.adsAllocationMode }))
  return day => {
    let mode: string = DEFAULT_POLICY.adsAllocationMode
    for (const version of versions) if (version.from <= day) mode = version.mode
    return (ALLOCATION_BASES as readonly string[]).includes(mode) ? (mode as AllocationBasis) : DEFAULT_POLICY.adsAllocationMode
  }
}
