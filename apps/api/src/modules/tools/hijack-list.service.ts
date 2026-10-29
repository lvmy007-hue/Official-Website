import { Injectable } from '@nestjs/common'
import {
  HIJACK_BLOCKED_NO_PERMISSION,
  HIJACK_MANAGE,
  HIJACK_READ,
  HijackListQuerySchema,
  hijackDelayNote,
  hijackMaxDelayHours,
  sellerRefOf,
  type HijackListResponse,
  type HijackRow,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, decodeOffset, pageInfoAt } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'

const NOTE_NO_STORE = '还没有接入亚马逊店铺；接入店铺并同步报价后，才能看到跟卖情况'
const NOTE_NONE = '还没有观察到其他报价方；定价同步器读到官方竞争摘要后才会出现（最长延迟见下方说明）'
const NOTE_FILTERED = '没有符合筛选条件的记录；可以放宽筛选条件'

/**
 * 跟卖监控列表（P6-17，16 章第 3.2 节）：我方 Listing 上出现的其他报价方，来自 OfferCompetitor（官方竞争摘要，定价同步器写入）。
 * 默认只看“仍在报价”且“不含白名单”；白名单按租户生效（自己的其他店铺不算跟卖）。偏移游标，每个条件都绑进游标。
 * 卖家只给哈希前 6 位；页面写明最长延迟，数据不是实时的。
 */
@Injectable()
export class HijackListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<HijackListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, HIJACK_READ, rawQuery)
    const query = HijackListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const canManage = hasPermission(context.permissions, HIJACK_MANAGE)
    const status = query.status ?? 'active'
    const whitelistMode = query.whitelist ?? 'exclude'
    const binding = bindingOf(tenantId, { ...query, status, whitelist: whitelistMode })
    const offset = decodeOffset(query.cursor, binding)
    const stores = await this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, orderBy: [{ id: 'asc' }], take: 500 })
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const storeScope: Prisma.OfferCompetitorWhereInput = { tenantId, sellerAccountId: { in: stores.map(store => store.id) } }
    const whitelist = (await this.prisma.hijackWhitelist.findMany({ where: { tenantId }, select: { sellerId: true }, take: 1000 })).map(row => row.sellerId)
    const listed = { in: whitelist }
    const [active, gone, whitelistedActive, asinCount] = await Promise.all([
      this.prisma.offerCompetitor.count({ where: { ...storeScope, goneAt: null } }),
      this.prisma.offerCompetitor.count({ where: { ...storeScope, goneAt: { not: null } } }),
      this.prisma.offerCompetitor.count({ where: { ...storeScope, goneAt: null, sellerId: listed } }),
      this.prisma.fbaProduct.count({ where: { tenantId, sellerAccountId: { in: stores.map(store => store.id) }, asin: { not: '' } } }),
    ])
    const summary = { active, gone, whitelisted: whitelistedActive, activeNotWhitelisted: active - whitelistedActive }
    const maxDelayHours = hijackMaxDelayHours(asinCount)
    const base = { maxDelayHours, delayNote: hijackDelayNote(maxDelayHours), canManage, manageBlockedReason: canManage ? null : HIJACK_BLOCKED_NO_PERMISSION }
    if (stores.length === 0) {
      return { state: 'NOT_CONNECTED', note: NOTE_NO_STORE, items: [], pageInfo: { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: 0 }, summary, ...base }
    }
    const and: Prisma.OfferCompetitorWhereInput[] = [storeScope]
    if (status === 'active') and.push({ goneAt: null })
    if (status === 'gone') and.push({ goneAt: { not: null } })
    if (whitelistMode === 'exclude') and.push({ sellerId: { notIn: whitelist } })
    if (whitelistMode === 'only') and.push({ sellerId: listed })
    if (query.q) and.push({ OR: [{ sku: { contains: query.q, mode: 'insensitive' } }, { asin: { contains: query.q, mode: 'insensitive' } }] })
    const where: Prisma.OfferCompetitorWhereInput = { AND: and }
    const direction = query.sort.dir
    const field = query.sort.field as 'firstSeenAt' | 'lastSeenAt' | 'price'
    const [total, rows] = await Promise.all([
      this.prisma.offerCompetitor.count({ where }),
      this.prisma.offerCompetitor.findMany({ where, orderBy: [{ [field]: direction }, { id: 'asc' }], skip: offset, take: query.pageSize }),
    ])
    const skus = [...new Set(rows.map(row => row.sku))]
    const products =
      skus.length === 0
        ? []
        : await this.prisma.fbaProduct.findMany({
            where: { tenantId, sellerSku: { in: skus }, sellerAccountId: { in: stores.map(store => store.id) } },
            select: { sellerAccountId: true, sellerSku: true, title: true },
            take: 5000,
          })
    const titles = new Map(products.map(row => [`${row.sellerAccountId}|${row.sellerSku}`, row.title]))
    const listedSet = new Set(whitelist)
    const items: HijackRow[] = rows.map(row => ({
      id: row.id,
      storeId: row.sellerAccountId,
      storeName: names.get(row.sellerAccountId) ?? '',
      sku: row.sku,
      asin: row.asin,
      title: titles.get(`${row.sellerAccountId}|${row.sku}`) ?? null,
      sellerKey: row.sellerId,
      sellerRef: sellerRefOf(row.sellerId),
      whitelisted: listedSet.has(row.sellerId),
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      goneAt: row.goneAt?.toISOString() ?? null,
      status: row.goneAt ? 'gone' : 'active',
      price: Number(row.price.toString()),
      currency: row.currency,
      isFba: row.isFba,
      hasBuybox: row.hasBuybox,
    }))
    const empty = total === 0
    const unfiltered = status === 'active' && whitelistMode === 'exclude' && !query.q
    const state: HijackListResponse['state'] = empty && active + gone === 0 ? 'NO_DATA' : 'OK'
    const note = empty ? (active + gone === 0 ? NOTE_NONE : unfiltered ? '目前没有需要关注的跟卖（没有白名单之外仍在报价的其他卖家）' : NOTE_FILTERED) : null
    return { state, note, items, pageInfo: pageInfoAt(offset, items.length, total, query.pageSize, binding), summary, ...base }
  }
}
