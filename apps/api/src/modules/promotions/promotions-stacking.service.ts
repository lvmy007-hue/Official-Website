import { Injectable } from '@nestjs/common'
import {
  PRICING_LIMITS,
  PROMOTIONS_READ,
  STACKING_BASIS,
  STACKING_CATALOG_NOTE,
  STACKING_LIMITS,
  StackingQuerySchema,
  isDeep,
  isStacked,
  stackRowsOf,
  stackingThresholds,
  type StackItemInput,
  type StackPromotionInput,
  type StackingResponse,
  type StackingRowView,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, decodeOffset, pageOf } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'

const PROMOTION_LIMIT = 2000
const CHUNK = 500
const key = (storeId: string, value: string) => `${storeId}|${value}`
const num = (value: { toString(): string } | null): number | null => (value === null ? null : Number(value.toString()))

// 促销叠加（P6-17，16 章第 3.2 节）：按已同步的促销清单，算每个 店铺 × ASIN 同一时段叠加了几个促销、叠加后的折扣深度；与“促销叠加预警”共用 api-contracts 的同一份计算。
// 只读：不调用亚马逊，不改促销。读取有上限（促销 2000 个、商品行 2 万行），读满时 truncated 为 true，页面提示“可能不完整”。
@Injectable()
export class PromotionsStackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async stacking(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<StackingResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PROMOTIONS_READ, rawQuery)
    const query = StackingQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const thresholds = stackingThresholds(query)
    const stores = await this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, orderBy: [{ id: 'asc' }], take: 500 })
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const base = { asins: 0, stacked: 0, deep: 0, any: 0, minStack: thresholds.minStack, minDepthPct: thresholds.minDepthPct }
    const empty = (state: StackingResponse['state'], note: string): StackingResponse => ({
      state,
      note,
      items: [],
      pageInfo: { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: 0 },
      summary: base,
      truncated: false,
      basis: STACKING_BASIS,
      catalogNote: STACKING_CATALOG_NOTE,
    })
    if (stores.length === 0) return empty('NOT_CONNECTED', '还没有接入亚马逊店铺；接入并同步促销后，才能看到叠加情况')
    const promotions = await this.prisma.promotion.findMany({
      where: { tenantId, ...storeWhere(scope), status: { in: ['RUNNING', 'UPCOMING'] }, OR: [{ endAt: null }, { endAt: { gt: now } }] },
      select: { id: true, promotionId: true, title: true, promotionType: true, status: true, startAt: true, endAt: true, sellerAccountId: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      take: PROMOTION_LIMIT,
    })
    if (promotions.length === 0) return empty('NO_DATA', '没有进行中或即将开始的促销；促销同步后才会显示叠加情况')
    const itemRows = await this.prisma.promotionItem.findMany({
      where: { tenantId, promotionRowId: { in: promotions.map(item => item.id) } },
      select: { promotionRowId: true, sellerAccountId: true, asin: true, sku: true, benefitType: true, discountType: true, percentOff: true, amountOff: true, fixedPrice: true },
      orderBy: [{ id: 'asc' }],
      take: STACKING_LIMITS.itemRowsMax,
    })
    const truncated = promotions.length >= PROMOTION_LIMIT || itemRows.length >= STACKING_LIMITS.itemRowsMax
    // 清单里只给了 SKU 的行，用商品目录补 ASIN；补不出来的不参与
    const bareSkus = [...new Set(itemRows.filter(row => row.asin === '' && row.sku !== '').map(row => row.sku))]
    const asinOfSku = new Map<string, string>()
    for (let index = 0; index < bareSkus.length; index += CHUNK) {
      const found = await this.prisma.fbaProduct.findMany({
        where: { tenantId, sellerSku: { in: bareSkus.slice(index, index + CHUNK) } },
        select: { sellerAccountId: true, sellerSku: true, asin: true },
        take: 20_000,
      })
      for (const row of found) if (row.asin) asinOfSku.set(key(row.sellerAccountId, row.sellerSku), row.asin)
    }
    const items: StackItemInput[] = itemRows.flatMap(row => {
      const asin = row.asin !== '' ? row.asin : (asinOfSku.get(key(row.sellerAccountId, row.sku)) ?? '')
      return asin === ''
        ? []
        : [
            {
              promotionRowId: row.promotionRowId,
              sellerAccountId: row.sellerAccountId,
              asin,
              sku: row.sku,
              benefitType: row.benefitType,
              discountType: row.discountType,
              percentOff: num(row.percentOff),
              amountOff: num(row.amountOff),
              fixedPrice: num(row.fixedPrice),
            },
          ]
    })
    const asins = [...new Set(items.map(item => item.asin))]
    const storeIds = [...new Set(items.map(item => item.sellerAccountId))]
    const prices = new Map<string, number>()
    const titles = new Map<string, string>()
    const since = new Date(now.getTime() - PRICING_LIMITS.freshWindowMs)
    for (let index = 0; index < asins.length; index += CHUNK) {
      const part = asins.slice(index, index + CHUNK)
      const [priceRows, productRows] = await Promise.all([
        this.prisma.priceSnapshot.findMany({
          where: { tenantId, sellerAccountId: { in: storeIds }, asin: { in: part }, observedAt: { gte: since } },
          select: { sellerAccountId: true, asin: true, price: true },
          orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
          take: 20_000,
        }),
        this.prisma.fbaProduct.findMany({
          where: { tenantId, sellerAccountId: { in: storeIds }, asin: { in: part } },
          select: { sellerAccountId: true, asin: true, title: true },
          orderBy: [{ id: 'asc' }],
          take: 20_000,
        }),
      ])
      for (const row of priceRows) if (!prices.has(key(row.sellerAccountId, row.asin))) prices.set(key(row.sellerAccountId, row.asin), Number(row.price.toString()))
      for (const row of productRows) if (!titles.has(key(row.sellerAccountId, row.asin))) titles.set(key(row.sellerAccountId, row.asin), row.title)
    }
    const inputs: StackPromotionInput[] = promotions.map(item => ({
      rowId: item.id,
      promotionId: item.promotionId,
      title: item.title,
      type: item.promotionType,
      status: item.status,
      startAt: item.startAt,
      endAt: item.endAt,
      sellerAccountId: item.sellerAccountId,
    }))
    const rows = stackRowsOf(inputs, items, (storeId, asin) => prices.get(key(storeId, asin)) ?? null, now.getTime())
    const views: StackingRowView[] = rows.map(row => ({
      ...row,
      storeName: names.get(row.storeId) ?? '',
      title: titles.get(key(row.storeId, row.asin)) ?? null,
      stacked: isStacked(row, thresholds.minStack),
      deep: isDeep(row, thresholds.minDepthPct),
    }))
    const summary = {
      asins: views.length,
      stacked: views.filter(row => row.stacked).length,
      deep: views.filter(row => row.deep).length,
      any: views.filter(row => row.stacked || row.deep).length,
      minStack: thresholds.minStack,
      minDepthPct: thresholds.minDepthPct,
    }
    const keyword = query.q?.trim().toLowerCase()
    const shown = views
      .filter(row => (query.flag === 'stacked' ? row.stacked : query.flag === 'deep' ? row.deep : query.flag === 'any' ? row.stacked || row.deep : true))
      .filter(row => !keyword || row.asin.toLowerCase().includes(keyword) || (row.title ?? '').toLowerCase().includes(keyword))
    const sign = query.sort.dir === 'asc' ? 1 : -1
    const sorted = [...shown].sort((a, b) => {
      const primary = query.sort.field === 'depth' ? (a.depth ?? -1) - (b.depth ?? -1) : a.peakCount - b.peakCount
      const secondary = query.sort.field === 'depth' ? a.peakCount - b.peakCount : (a.depth ?? -1) - (b.depth ?? -1)
      return sign * primary || sign * secondary || (a.id < b.id ? -1 : 1)
    })
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    const state: StackingResponse['state'] = views.length === 0 ? 'NO_DATA' : 'OK'
    const note = views.length === 0 ? '进行中的促销里没有商品清单，或清单还没同步；整个目录范围的促销不计入叠加' : sorted.length === 0 ? '没有符合条件的商品；可以放宽筛选条件' : null
    return { state, note, items: page, pageInfo, summary, truncated, basis: STACKING_BASIS, catalogNote: STACKING_CATALOG_NOTE }
  }
}
