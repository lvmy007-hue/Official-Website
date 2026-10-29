import { Injectable } from '@nestjs/common'
import { ADS_CAMPAIGN_TAB_ROW_LIMIT, stockOf, type AdsCampaignProductList, type AdsCampaignProductRow } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { asDate } from '../overview'
import { AdsCampaignAccessService, num, type CampaignRecord } from './ads-campaigns-common'
import { anyRowInScope } from './ads-campaigns-load'
import { pageOf } from './ads-page'
import { latestSnapshots } from './ads-today-load'
import type { AdsLoadContext } from './ads-overview-load'

const NOTE_NEVER = '被推广商品日报表还没有同步（需要广告报表的“被推广商品”报告），暂无法列出这个活动推广的商品'
const NOTE_EMPTY = '所选范围内这个活动没有被推广商品的报表行'

/** 活动在范围内推广的商品（按花费从高到低），带商品名称、图片与最近一次库存快照的可售数量。库存快照只取活动所属店铺。 */
export async function loadAdvertised(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  campaign: CampaignRecord,
  from: string,
  to: string,
  limit: number,
): Promise<{ rows: AdsCampaignProductRow[]; truncated: boolean }> {
  const groups = await prisma.adsAdvertisedProductMetric.groupBy({
    by: ['advertisedAsin'],
    where: {
      tenantId: ctx.tenantId,
      adsProfileId: campaign.adsProfileId,
      campaignId: campaign.externalCampaignId,
      currency: campaign.currency,
      reportDate: { gte: asDate(from), lte: asDate(to) },
    },
    _sum: { impressions: true, clicks: true, spend: true, sales: true, orders: true },
    orderBy: [{ _sum: { spend: 'desc' } }, { advertisedAsin: 'asc' }],
    take: limit + 1,
  })
  const kept = groups.slice(0, limit)
  const facts = await productFacts(
    prisma,
    ctx,
    campaign.adsProfile.sellerAccountId,
    kept.map(group => group.advertisedAsin),
  )
  const rows = kept.map((group): AdsCampaignProductRow => {
    const fact = facts.get(group.advertisedAsin)
    return {
      asin: group.advertisedAsin,
      title: fact?.title ?? null,
      imageUrl: fact?.imageUrl ?? null,
      metrics: { impressions: group._sum.impressions ?? 0, clicks: group._sum.clicks ?? 0, spend: num(group._sum.spend), sales: num(group._sum.sales), orders: group._sum.orders ?? 0 },
      sellable: fact?.sellable ?? null,
      snapshotDate: fact?.snapshotDate ?? null,
      stock: stockOf(fact?.sellable ?? null),
    }
  })
  return { rows, truncated: groups.length > limit }
}

export interface ProductFact {
  title: string | null
  imageUrl: string | null
  sellable: number | null
  snapshotDate: string | null
}

/** 一批 ASIN 的商品名称、图片与最近一次库存快照的可售数量（活动、广告组页签共用）；快照只取广告账户绑定的店铺，没有绑定店铺就没有库存信息。 */
export async function productFacts(prisma: PrismaService, ctx: AdsLoadContext, storeId: string | null, asins: readonly string[]): Promise<Map<string, ProductFact>> {
  const wanted = [...new Set(asins)]
  const [products, snapshots] = await Promise.all([
    wanted.length === 0
      ? Promise.resolve([])
      : prisma.fbaProduct.findMany({
          where: { tenantId: ctx.tenantId, ...storeWhere(ctx.scope), ...(storeId ? { sellerAccountId: storeId } : {}), asin: { in: wanted } },
          select: { asin: true, title: true, imageUrl: true },
          orderBy: [{ asin: 'asc' }, { sellerSku: 'asc' }],
          take: 3000,
        }),
    storeId && wanted.length > 0 ? latestSnapshots(prisma, ctx, [storeId], wanted) : Promise.resolve([]),
  ])
  const facts = new Map<string, ProductFact>()
  for (const product of products) if (!facts.has(product.asin)) facts.set(product.asin, { title: product.title, imageUrl: product.imageUrl, sellable: null, snapshotDate: null })
  // 同一个 ASIN 可能有多个 SKU：可售数量相加；只要有一个 SKU 给了数量就算已知
  for (const snapshot of snapshots) {
    const held = facts.get(snapshot.asin) ?? { title: null, imageUrl: null, sellable: null, snapshotDate: null }
    const sellable = snapshot.sellable === null ? held.sellable : (held.sellable ?? 0) + snapshot.sellable
    facts.set(snapshot.asin, { ...held, sellable, snapshotDate: snapshot.snapshotDate })
  }
  return facts
}

// 广告商品页签（08 章 8.3）：活动推广的 ASIN 的花费、销售额与库存状态；断货的商品标红，提示去暂停该商品广告（写入随 P3-17）。
@Injectable()
export class AdsCampaignProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdsCampaignAccessService,
  ) {}

  async list(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsCampaignProductList> {
    const { campaign, ctx, query, period, binding, offset } = await this.access.openTab(req, id, rawQuery)
    const { rows, truncated } = await loadAdvertised(this.prisma, ctx, campaign, period.from, period.to, ADS_CAMPAIGN_TAB_ROW_LIMIT)
    const needle = query.q?.toLowerCase()
    const filtered = needle ? rows.filter(row => row.asin.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle)) : rows
    const { page, pageInfo } = pageOf(filtered, offset, query.pageSize, binding)
    if (rows.length > 0) return { state: 'OK', note: truncated ? `活动推广的商品很多，只列花费最高的 ${ADS_CAMPAIGN_TAB_ROW_LIMIT} 个` : null, period, items: page, pageInfo, truncated }
    const ever = await anyRowInScope(this.prisma, ctx, 'adsAdvertisedProductMetric')
    return { state: ever ? 'NO_DATA' : 'NOT_CONNECTED', note: ever ? NOTE_EMPTY : NOTE_NEVER, period, items: [], pageInfo, truncated: false }
  }
}
