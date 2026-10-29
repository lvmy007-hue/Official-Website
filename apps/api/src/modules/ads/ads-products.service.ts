import { Injectable } from '@nestjs/common'
import {
  ADS_ASIN_HALO_NOTE,
  ADS_ASIN_ORGANIC_BASIS,
  ADS_ASIN_PROFIT_NOTE,
  ADS_ASIN_ROW_LIMIT,
  ADS_ASIN_WRITE_PENDING,
  ADS_BUCKET_RULE,
  ADS_READ,
  AdsAsinListQuerySchema,
  adsRangeIssue,
  countBuckets,
  inAdsRanges,
  inBucket,
  summarizeLevel,
  type AdsLevelCountsResponse,
  adsAsinKey,
  asinMatches,
  compareAsinRows,
  summarizeAsins,
  type AdsAsinListResponse,
  type AdsAsinSort,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService } from '../auth'
import { rangeOf } from './ads-campaigns-common'
import { anyRowInScope } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { decodeOffset, pageOf } from './ads-page'
import { adCounts, advertisedGroups, asinFacts, everHadConverted, haloByAsin, hasOtherCurrency, profileStores, totalSalesByAsin } from './ads-products-load'
import { aggregateGroups, rowOf } from './ads-products-rows'

const NOTE_NEVER = '被推广商品日报表还没有同步（需要广告报表的“被推广商品”报告），暂无法按 ASIN 汇总广告；连接广告账户并同步报表后才会出现'
const NOTE_EMPTY = '所选范围内没有被推广商品的报表行'
const NOTE_FILTERED = '没有符合筛选条件的广告商品'
const NOTE_OTHER_CURRENCY = '指标只含美元广告账户；非美元的被推广商品行没有并入（不折算）'

// 广告商品（08 章 8.6）：按“店铺 × ASIN”汇总全部广告。
// 做法：数据库按范围聚合被推广商品日报表（档案 × ASIN × 活动）→ 内存里合成“店铺 × ASIN”并取花费最高的 ADS_ASIN_ROW_LIMIT 个 →
// 再按这批 ASIN 一次性取全部销售额、光环销售、广告数、商品资料与库存 → 内存里算比率、筛选、排序 → 偏移游标分页（游标签名并绑定全部查询条件）。
// 空值是 null，不是 0：没有总销售额行的 ASIN 自然销售额与占比为空；没有转化商品行的 ASIN 光环销售为空。
@Injectable()
export class AdsAsinListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsAsinListResponse> {
    const loaded = await this.load(req, rawQuery)
    return this.respond(loaded)
  }

  /** 分类计数（P6-23）：同一套筛选，分类筛选之前的行按曝光、点击、订单分四类。 */
  async counts(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsLevelCountsResponse> {
    const loaded = await this.load(req, rawQuery)
    const { buckets, withoutMetrics } = countBuckets(loaded.rows.map(row => row.totals))
    const state = loaded.rows.length > 0 ? 'OK' : loaded.dataExists ? 'NO_DATA' : 'NOT_CONNECTED'
    const note = state === 'OK' ? null : state === 'NO_DATA' ? NOTE_FILTERED : NOTE_NEVER
    return { level: 'products', state, note, range: loaded.range, total: loaded.rows.length, buckets, withoutMetrics, rule: ADS_BUCKET_RULE, truncated: loaded.truncated || loaded.metricsTruncated }
  }

  async load(req: RequestWithContext, rawQuery: Record<string, string>) {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsAsinListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const ctx: AdsLoadContext = { tenantId, scope }
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const rangeIssue = adsRangeIssue(query)
    if (rangeIssue) throw appError('VALIDATION_FAILED', rangeIssue, { fieldErrors: { range: [rangeIssue] } })
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)

    const { groups, truncated: metricsTruncated } = await advertisedGroups(this.prisma, ctx, period.from, period.to)
    const stores = await profileStores(
      this.prisma,
      ctx,
      groups.map(group => group.adsProfileId),
    )
    const aggregates = aggregateGroups(groups, stores)
    const kept = aggregates.slice(0, ADS_ASIN_ROW_LIMIT)
    const storeIds = [...new Set(kept.flatMap(item => (item.storeId ? [item.storeId] : [])))]
    const asins = [...new Set(kept.map(item => item.asin))]
    const keyOfProfile = (adsProfileId: string, asin: string) => adsAsinKey(stores.get(adsProfileId)?.storeId ?? null, asin)

    const [totalSales, halo, ads, facts, haloEver, otherCurrency] = await Promise.all([
      totalSalesByAsin(this.prisma, ctx, storeIds, asins, period.from, period.to),
      haloByAsin(this.prisma, ctx, asins, period.from, period.to, keyOfProfile),
      adCounts(this.prisma, ctx, asins, keyOfProfile),
      asinFacts(this.prisma, ctx, storeIds, asins),
      everHadConverted(this.prisma, ctx),
      hasOtherCurrency(this.prisma, ctx, period.from, period.to),
    ])

    const rows = kept
      .map(aggregate => rowOf(aggregate, { totalSales, halo, ads, facts }))
      .filter(row => asinMatches(row, query.q) && (!query.stock || row.stock === query.stock) && inAdsRanges(row.totals, query))
      .sort((a, b) => compareAsinRows(a, b, query.sort.field as AdsAsinSort, query.sort.dir))
    return {
      rows,
      query,
      binding,
      offset,
      otherCurrency,
      haloEver,
      range: { from: period.from, to: period.to, defaulted },
      ctx,
      metricsTruncated,
      dataExists: aggregates.length > 0,
      truncated: aggregates.length > ADS_ASIN_ROW_LIMIT,
    }
  }

  private async respond(loaded: Awaited<ReturnType<AdsAsinListService['load']>>): Promise<AdsAsinListResponse> {
    const { query, binding, offset, ctx, otherCurrency, haloEver, metricsTruncated, dataExists, range, truncated } = loaded
    const rows = loaded.rows.filter(row => inBucket(row.totals, query.bucket))
    const { page, pageInfo } = pageOf(rows, offset, query.pageSize, binding)

    let state: AdsAsinListResponse['state'] = 'OK'
    let note: string | null = otherCurrency ? NOTE_OTHER_CURRENCY : null
    if (rows.length === 0) {
      // 有被推广商品行但被筛选条件挡掉了，与“所选范围没有记录”“从未同步过”要分开说
      const ever = dataExists || (await anyRowInScope(this.prisma, ctx, 'adsAdvertisedProductMetric'))
      state = ever ? 'NO_DATA' : 'NOT_CONNECTED'
      note = dataExists ? NOTE_FILTERED : ever ? NOTE_EMPTY : NOTE_NEVER
    }

    return {
      state,
      note,
      items: page,
      pageInfo,
      range,
      currency: 'USD',
      summary: summarizeAsins(rows),
      level: summarizeLevel(rows.map(row => row.totals)),
      halo: haloEver ? { state: 'OK', note: null } : { state: 'NOT_CONNECTED', note: ADS_ASIN_HALO_NOTE },
      profit: { state: 'NOT_CONNECTED', note: ADS_ASIN_PROFIT_NOTE },
      organicBasis: ADS_ASIN_ORGANIC_BASIS,
      write: ADS_ASIN_WRITE_PENDING,
      truncated,
      metricsTruncated,
    }
  }
}
