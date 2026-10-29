import { Injectable } from '@nestjs/common'
import { ProfitGroupsQuerySchema, ScopeSearchSchema, type ProfitAdsResponse, type ProfitAdsRow, type ProfitAdsStoreRow, type ProfitAdsVerdict, type ProfitGroupsResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { stripSensitiveFields } from '../../platform/field-filter'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { bridgeViewOf, marginOf } from './profit-aggregate'
import { NO_DATA_NOTE, ProfitAccessService, type ProfitAccess } from './profit-access.service'
import { groupRow, loadCostDetails, matchesKeyword, mergeByDimension, parentMap, productOf, type GroupDraft } from './profit-groups'
import { loadProducts, loadSkuGroups, loadStoreLevelTotals, loadStoreNames, loadTotalsByStore, type ProductMeta } from './profit-load'
import { decodeOffset, pageOf, sortRows } from './profit-page'

const ADS_NOTE_NOT_ALLOCATED =
  '范围内没有广告分摊结果：广告账户没有绑定店铺、还没有广告花费记录，或这些日子的利润日表还没有重算，所以下表的利润不含广告；下面“店铺层面”给出各店铺的广告花费与广告前后的利润。'
const ADS_NOTE_ALLOCATED = '广告花费先按广告商品报表归属到 ASIN，剩余的账户级花费按财务口径里的规则（销售额或销量）分摊到当天有销售的 SKU；当天没有销售等分不出去的部分留在店铺级行，不计入各商品。'

// 按 ASIN、SKU、父体的利润（07 章 7.9 第 3、4 个页签）：先用数据库汇总出 店铺 × SKU × ASIN 的分组，在内存里按维度合并、排序，再按位置切页（游标）。
@Injectable()
export class ProfitGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProfitAccessService,
  ) {}

  private async prepare(req: RequestWithContext, rawQuery: Record<string, string>, now: Date) {
    const access = await this.access.resolve(req, rawQuery, 'profit', now)
    const query = ProfitGroupsQuerySchema.parse({ recognition: rawQuery.recognition, by: rawQuery.by, q: rawQuery.q, sort: rawQuery.sort, cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const where = this.access.where(access, query.recognition)
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const [loaded, storeLevel, freshness] = await Promise.all([loadSkuGroups(this.prisma, where), loadStoreLevelTotals(this.prisma, where), this.access.freshness(access, now)])
    const parents =
      query.by === 'PARENT'
        ? parentMap(await loadProducts(this.prisma, access.tenantId, access.scope, { asins: [...new Set(loaded.groups.flatMap(group => (group.asin ? [group.asin] : [])))] }))
        : new Map<string, string>()
    const drafts = sortRows(
      mergeByDimension(loaded.groups, query.by, parents).filter(draft => matchesKeyword(draft, query.q)),
      { field: query.sort.field as 'revenue', dir: query.sort.dir },
    )
    return { access, query, where, binding, offset, drafts, truncated: loaded.truncated, storeLevel, freshness }
  }

  private async metaFor(access: ProfitAccess, drafts: readonly GroupDraft[]) {
    const skus = drafts.flatMap(draft => (draft.sku ? [draft.sku] : []))
    const asins = drafts.flatMap(draft => [draft.asin, draft.parentAsin].flatMap(value => (value ? [value] : [])))
    const [products, storeNames] = await Promise.all([loadProducts(this.prisma, access.tenantId, access.scope, { skus, asins }), loadStoreNames(this.prisma, access.tenantId, access.scope)])
    const bySku = new Map<string, ProductMeta>()
    const byAsin = new Map<string, ProductMeta>()
    for (const product of products) {
      const skuKey = `${product.sellerAccountId}|${product.sellerSku}`
      if (!bySku.has(skuKey)) bySku.set(skuKey, product)
      if (!byAsin.has(product.asin)) byAsin.set(product.asin, product)
    }
    return { bySku, byAsin, storeNames }
  }

  async asins(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitGroupsResponse> {
    const { access, query, where, binding, offset, drafts, truncated, storeLevel, freshness } = await this.prepare(req, rawQuery, now)
    const { page, pageInfo } = pageOf(drafts, offset, query.pageSize, binding)
    const [meta, costDetails] = await Promise.all([this.metaFor(access, page), access.canCost ? loadCostDetails(this.prisma, where, page) : Promise.resolve(null)])
    const items = page.map(draft => groupRow(draft, { ...meta, costDetails, canCost: access.canCost }))
    const empty = drafts.length === 0 && !storeLevel && offset === 0
    const response: ProfitGroupsResponse = {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_DATA_NOTE : null,
      ...this.access.common(access, query.recognition, freshness),
      dimension: query.by,
      items,
      pageInfo,
      storeLevel: storeLevel ? bridgeViewOf(storeLevel, access.canCost) : null,
      truncated,
    }
    return stripSensitiveFields(response, access.permissions, {
      cost: ['items[].productCost', 'items[].firstMileCost', 'items[].otherCost', 'items[].costCoverage', 'items[].costDetail', 'items[].perUnit.productCost'],
    })
  }

  async ads(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitAdsResponse> {
    const { access, query, where, binding, offset, drafts, truncated, freshness } = await this.prepare(req, rawQuery, now)
    const [byStore, names] = await Promise.all([loadTotalsByStore(this.prisma, where), loadStoreNames(this.prisma, access.tenantId, access.scope)])
    const { page, pageInfo } = pageOf(drafts, offset, query.pageSize, binding)
    const meta = await this.metaFor(access, page)
    const items: ProfitAdsRow[] = page.map(draft => {
      const { totals } = draft
      const allocated = totals.adsSpendAllocated
      const before = totals.profit === null ? null : totals.profit + (allocated ?? 0)
      const verdict: ProfitAdsVerdict = totals.profit === null ? 'NO_COST' : allocated === null ? 'NOT_ALLOCATED' : totals.profit >= 0 ? 'PROFIT_AFTER_ADS' : 'LOSS_AFTER_ADS'
      const product = productOf(draft, meta)
      return {
        key: draft.key,
        asin: draft.asin,
        sku: draft.sku,
        title: product?.title ?? null,
        storeName: draft.sellerAccountId ? (meta.storeNames.get(draft.sellerAccountId) ?? null) : null,
        productId: product?.id ?? null,
        revenue: totals.revenue,
        adsAllocated: allocated,
        profitBeforeAds: before,
        profit: totals.profit,
        adsShare: allocated === null || totals.revenue <= 0 ? null : allocated / totals.revenue,
        verdict,
      }
    })
    const stores: ProfitAdsStoreRow[] = [...new Set([...names.keys(), ...byStore.keys()])].flatMap(id => {
      const totals = byStore.get(id)
      if (!totals) return []
      const spend = totals.adsSpendAllocated === null && totals.adsUnallocated === null ? null : (totals.adsSpendAllocated ?? 0) + (totals.adsUnallocated ?? 0)
      return [
        {
          sellerAccountId: id,
          storeName: names.get(id) ?? id,
          revenue: totals.revenue,
          adsSpend: spend,
          adsShare: spend === null ? null : marginOf(spend, totals.revenue),
          profitBeforeAds: totals.profit === null ? null : totals.profit + (spend ?? 0),
          netProfit: totals.profit,
        },
      ]
    })
    const allocated = drafts.some(draft => draft.totals.adsSpendAllocated !== null)
    const empty = drafts.length === 0 && byStore.size === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_DATA_NOTE : null,
      ...this.access.common(access, query.recognition, freshness),
      allocation: { state: allocated ? 'ALLOCATED' : 'NOT_ALLOCATED', note: allocated ? ADS_NOTE_ALLOCATED : ADS_NOTE_NOT_ALLOCATED },
      stores,
      items,
      pageInfo,
      truncated,
    }
  }
}
