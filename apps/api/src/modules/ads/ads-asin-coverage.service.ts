import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, type ResolvedScope } from '../auth'

// 父体广告覆盖（P4-03）：每个子体 ASIN 在范围内的广告花费、广告销售、订单与在投广告数，给“广告覆盖”页签用。
// 只算已绑定店铺的广告账户、只算美元；被推广商品日报表从没同步过时 everSynced 为 false（页面写“尚未接入”，不是 0）。

const LIMIT = 19_999
const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const ENABLED = 'ENABLED'

export interface AsinAdsCoverage {
  spend: number | null
  sales: number | null
  orders: number | null
  enabledAds: number
  totalAds: number
}

export interface AdsCoverageResult {
  /** 这些店铺有没有已绑定的广告账户。 */
  bound: boolean
  /** 这些广告账户有没有过被推广商品日报表数据。 */
  everSynced: boolean
  byAsin: Map<string, AsinAdsCoverage>
  truncated: boolean
}

@Injectable()
export class AsinAdsCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  async coverage(input: { tenantId: string; scope: ResolvedScope; storeIds: readonly string[]; asins: readonly string[]; from: string; to: string }): Promise<AdsCoverageResult> {
    const { tenantId, scope, storeIds, asins } = input
    const empty: AdsCoverageResult = { bound: false, everSynced: false, byAsin: new Map(), truncated: false }
    if (storeIds.length === 0 || asins.length === 0) return empty
    const allowed = scope.unrestricted ? [...storeIds] : storeIds.filter(id => scope.sellerAccountIds.includes(id))
    const profiles = await this.prisma.adsProfile.findMany({
      where: { tenantId, sellerAccountId: { in: allowed } },
      select: { id: true, sellerAccountId: true },
      take: 1000,
    })
    if (profiles.length === 0) return empty
    const profileIds = profiles.map(profile => profile.id)
    const range = { gte: new Date(`${input.from}T00:00:00Z`), lte: new Date(`${input.to}T00:00:00Z`) }
    const [synced, metrics, ads] = await Promise.all([
      this.prisma.adsAdvertisedProductMetric.findFirst({ where: { tenantId, adsProfileId: { in: profileIds }, ...adsRelationWhere(scope) }, select: { id: true } }),
      this.prisma.adsAdvertisedProductMetric.groupBy({
        by: ['advertisedAsin'],
        where: { tenantId, adsProfileId: { in: profileIds }, ...adsRelationWhere(scope), advertisedAsin: { in: [...asins] }, currency: 'USD', reportDate: range },
        _sum: { spend: true, sales: true, orders: true },
        orderBy: { advertisedAsin: 'asc' },
        take: LIMIT + 1,
      }),
      this.prisma.adsAd.groupBy({
        by: ['asin', 'state'],
        where: { tenantId, adsProfileId: { in: profileIds }, ...adsRelationWhere(scope), asin: { in: [...asins] } },
        _count: { _all: true },
        orderBy: [{ asin: 'asc' }, { state: 'asc' }],
        take: LIMIT + 1,
      }),
    ])
    const byAsin = new Map<string, AsinAdsCoverage>()
    const entry = (asin: string) => byAsin.get(asin) ?? { spend: null, sales: null, orders: null, enabledAds: 0, totalAds: 0 }
    for (const row of metrics.slice(0, LIMIT)) byAsin.set(row.advertisedAsin, { ...entry(row.advertisedAsin), spend: num(row._sum.spend), sales: num(row._sum.sales), orders: row._sum.orders })
    for (const row of ads.slice(0, LIMIT)) {
      if (!row.asin) continue
      const held = entry(row.asin)
      byAsin.set(row.asin, { ...held, totalAds: held.totalAds + row._count._all, enabledAds: held.enabledAds + (row.state === ENABLED ? row._count._all : 0) })
    }
    return { bound: true, everSynced: Boolean(synced), byAsin, truncated: metrics.length > LIMIT || ads.length > LIMIT }
  }
}
