import { Injectable } from '@nestjs/common'
import { PRICING_BASIS, PRICING_FRESHNESS_KEY, PRICING_MARGIN_BASIS, PRICING_READ, PricingListQuerySchema, type PricingListResponse, type PricingSort } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ActionGuardService } from '../../platform/write'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { decodeOffset, pageOf, storesOf, writeStatusesOf } from './pricing-common'
import { keyOf, loadBuyBoxPct, loadGuardrails, loadLatestExpected, loadLatestPrices, loadLatestSummaries, loadProducts, loadUnits } from './pricing-load'
import { buildRow, comparePricingRows, summaryOf } from './pricing-rows'

const NOTE_NO_STORE = '可见范围内还没有店铺；连接亚马逊店铺并同步后才会出现价格数据'
const NOTE_NO_PRODUCT = '可见范围内还没有同步到商品；同步商品目录后才会出现'
const NOTE_FILTERED = '没有符合筛选条件的商品；可以放宽筛选条件'

/** 定价列表（05 章 5.5）：以商品目录为底，价格、预期价格、竞争摘要来自定价同步器，没有数据的字段为 null（页面显示“尚无记录”）；筛选与排序在内存里，偏移游标签名并绑定全部条件。 */
@Injectable()
export class PricingListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<PricingListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_READ, rawQuery)
    const query = PricingListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const stores = await storesOf(this.prisma, tenantId, scope)
    const storeIds = stores.map(store => store.id)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const canProfit = canSeeField(context.permissions, 'profit')
    const [products, prices, expected, summaries, units, buyBox, guardrails, freshness, write] = await Promise.all([
      loadProducts(this.prisma, tenantId, scope, { q: query.q }),
      loadLatestPrices(this.prisma, tenantId, storeIds, now),
      loadLatestExpected(this.prisma, tenantId, storeIds, now),
      loadLatestSummaries(this.prisma, tenantId, storeIds, now),
      canProfit ? loadUnits(this.prisma, tenantId, scope, now) : Promise.resolve(new Map()),
      loadBuyBoxPct(this.prisma, tenantId, scope, now),
      loadGuardrails(this.prisma, tenantId, storeIds),
      sourceFreshness(this.prisma, tenantId, scope, [PRICING_FRESHNESS_KEY], now),
      writeStatusesOf(this.guard, context),
    ])
    const rows = products.rows.map(product =>
      buildRow({
        product,
        storeName: names.get(product.sellerAccountId) ?? '',
        price: prices.get(keyOf(product.sellerAccountId, product.sellerSku)),
        expected: expected.get(keyOf(product.sellerAccountId, product.sellerSku)),
        summary: summaries.get(keyOf(product.sellerAccountId, product.asin)),
        buyBoxPct: buyBox.get(keyOf(product.sellerAccountId, product.asin)) ?? null,
        unit: units.get(keyOf(product.sellerAccountId, product.sellerSku)),
        canProfit,
        guardrails,
      }),
    )
    // 健康分布按“除健康筛选以外的全部条件”统计：点某个状态筛选后，分布本身不跟着变
    const summary = summaryOf(rows)
    const shown = query.health ? rows.filter(row => row.health === query.health) : rows
    const field = query.sort.field as PricingSort
    const sorted = [...shown].sort((a, b) => comparePricingRows(a, b, field, query.sort.dir))
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    let state: PricingListResponse['state'] = 'OK'
    let note: string | null = null
    if (stores.length === 0) {
      state = 'NOT_CONNECTED'
      note = NOTE_NO_STORE
    } else if (shown.length === 0) {
      state = 'NO_DATA'
      note = rows.length === 0 && !query.q ? NOTE_NO_PRODUCT : NOTE_FILTERED
    }
    return {
      state,
      note,
      items: page,
      pageInfo,
      summary,
      currency: 'USD',
      stores,
      write,
      marginBasis: PRICING_MARGIN_BASIS,
      truncated: products.truncated,
      freshness,
      basis: PRICING_BASIS,
    }
  }
}
