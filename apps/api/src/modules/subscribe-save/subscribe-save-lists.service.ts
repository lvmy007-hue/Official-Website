import { Injectable } from '@nestjs/common'
import {
  SNS_BASIS,
  SnsAsinListQuerySchema,
  SnsOfferListQuerySchema,
  ScopeSearchSchema,
  snsEmptyState,
  type SnsAsinListResponse,
  type SnsAsinRow,
  type SnsAsinSort,
  type SnsListResponse,
  type SnsOfferListResponse,
  type SnsOfferRow,
  type SnsOfferSort,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { loadLatestOffers, loadProductIds } from './subscribe-save-load'
import { SubscribeSaveAccessService, type SnsAccess } from './subscribe-save-access.service'
import { asinRowsOf, forecastTotals, matchesOffer, offerRowOf, type OfferRecord } from './subscribe-save-math'
import { decodeOffset, pageOf, sortByNumber } from './subscribe-save-page'

// 订阅省的两个明细（04 章 4.9）：ASIN 明细（同店铺同 ASIN 的报价合并）与报价参与列表（每个店铺 SKU 一行）。
// 数据是每个店铺最近一次报价快照；筛选、排序在内存里做，按位置切页（游标）。没有开通、没同步或没记录时返回原因，不返回示例行。

const ASIN_SORT: Record<SnsAsinSort, (row: SnsAsinRow) => number | null> = {
  forecastNext30: row => row.forecastNext30,
  forecastNext60: row => row.forecastNext60,
  forecastNext90: row => row.forecastNext90,
  subscriptions: row => row.subscriptions,
  shippedUnitsPrevMonth: row => row.shippedUnitsPrevMonth,
}
const OFFER_SORT: Record<SnsOfferSort, (row: SnsOfferRow) => number | null> = {
  forecastNext30: row => row.forecastNext30,
  subscriptions: row => row.subscriptions,
  price: row => row.price,
  inventory: row => row.inventory,
}

@Injectable()
export class SubscribeSaveListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SubscribeSaveAccessService,
  ) {}

  async asins(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<SnsAsinListResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const query = SnsAsinListQuerySchema.parse({ q: rawQuery.q, sort: rawQuery.sort, cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), list: 'asins', ...query })
    const offset = decodeOffset(query.cursor, binding)
    const loaded = await loadLatestOffers(this.prisma, access.tenantId, access.scope)
    const matched = loaded.offers.filter(offer => matchesOffer(offer, query.q))
    const sorted = sortByNumber(asinRowsOf(matched, access.today), ASIN_SORT[query.sort.field as SnsAsinSort], query.sort.dir)
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    const products = await loadProductIds(this.prisma, access.tenantId, access.scope, page)
    const items = page.map(row => ({ ...row, productId: products.get(`${row.sellerAccountId}|${row.asin}`) ?? null }))
    return this.respond(access, loaded, items, pageInfo, now, Boolean(query.q) || offset > 0)
  }

  async offers(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<SnsOfferListResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const query = SnsOfferListQuerySchema.parse({ q: rawQuery.q, eligibility: rawQuery.eligibility, sort: rawQuery.sort, cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), list: 'offers', ...query })
    const offset = decodeOffset(query.cursor, binding)
    const loaded = await loadLatestOffers(this.prisma, access.tenantId, access.scope)
    const matched = loaded.offers.filter(offer => matchesOffer(offer, query.q) && (!query.eligibility || offer.eligibility === query.eligibility))
    const sorted = sortByNumber(
      matched.map(offer => offerRowOf(offer, access.today)),
      OFFER_SORT[query.sort.field as SnsOfferSort],
      query.sort.dir,
    )
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    return this.respond(access, loaded, page, pageInfo, now, Boolean(query.q || query.eligibility) || offset > 0)
  }

  private async respond<Row>(
    access: SnsAccess,
    loaded: { offers: OfferRecord[]; truncated: boolean },
    items: Row[],
    pageInfo: SnsListResponse<Row>['pageInfo'],
    now: Date,
    filtered: boolean,
  ): Promise<SnsListResponse<Row>> {
    const { sync, freshness } = await this.access.sync(access, now)
    const totals = forecastTotals(loaded.offers, access.today)
    const empty = loaded.offers.length === 0 ? snsEmptyState(sync) : null
    return {
      state: empty ? empty.state : items.length === 0 && filtered ? 'NO_DATA' : 'OK',
      note: empty ? empty.note : items.length === 0 && filtered ? '没有符合条件的报价；可以放宽筛选条件' : null,
      items,
      pageInfo,
      truncated: loaded.truncated,
      snapshotDate: totals.snapshotDate,
      staleStores: totals.staleStores,
      sync,
      freshness,
      basis: SNS_BASIS,
    }
  }
}
