import { Injectable } from '@nestjs/common'
import {
  CATALOG_FRESHNESS_KEY,
  PRODUCT_BASIS,
  PRODUCT_NOT_CONNECTED_NOTE,
  PRODUCT_READ,
  PRODUCT_META_WRITE,
  PRODUCT_WATCH_ENTITY,
  PRODUCT_WINDOW_DAYS,
  ProductListQuerySchema,
  productFilterWhere,
  type ProductDataState,
  type ProductListResponse,
  type ProductSort,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService, type ResolvedScope } from '../auth'
import { InventoryLoaderService, InventoryPolicyService, plusDays, sourceFreshness } from '../inventory'
import { todayIn, validZone } from '../overview'
import { activeMembers, baseWhere, loadFilterOptions, loadMargins, loadProducts, loadSales, loadSellable, loadWatchedIds } from './product-list-load'
import { buildProductRows, compareProductRows } from './product-list-math'
import { decodeOffset, pageOf } from './product-list-page'

const NOTE_NEVER = '可见范围内还没有同步到商品；连接店铺并同步商品目录后才会出现（可以在这里点“同步商品目录”）'
const NOTE_FILTERED = '没有符合筛选条件的商品；可以放宽筛选条件'
const NOTE_NO_STOCK = '范围内还没有库存记录，可售数量同步库存后显示'
const NOTE_NO_PROFIT = '范围内近 30 天还没有利润日表记录，利润率在订单、财务数据同步并计算后显示'
const NOTE_STOCK_RESTRICTED = '需要“库存”读取权限才能查看可售数量与库存风险'
const NOTE_PROFIT_RESTRICTED = '需要“利润”读取与“利润字段”权限才能查看利润率'

/** 商品主数据列表（05 章 5.1）：商品记录来自目录同步，销售、利润、库存数字来自各自的汇总表；筛选在数据库，排序与分页在内存里（偏移游标，签名并绑定全部条件）。 */
@Injectable()
export class ProductListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProductListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PRODUCT_READ, rawQuery)
    const canStock = hasPermission(context.permissions, 'inventory.read')
    const canProfit = hasPermission(context.permissions, 'profit.read') && hasPermission(context.permissions, 'field.profit')
    const canWrite = hasPermission(context.permissions, PRODUCT_META_WRITE)
    if (rawQuery.risk !== undefined) this.context.require(context, 'inventory.read')
    const query = ProductListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    const window = { from: plusDays(today, 1 - PRODUCT_WINDOW_DAYS), to: today, days: PRODUCT_WINDOW_DAYS }
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)

    const base = baseWhere(tenantId, scope)
    const clauses: Prisma.FbaProductWhereInput[] = []
    const filterWhere = productFilterWhere(query) as Prisma.FbaProductWhereInput
    if (Object.keys(filterWhere).length > 0) clauses.push(filterWhere)
    const watchedIds = await loadWatchedIds(this.prisma, tenantId, context.userId, PRODUCT_WATCH_ENTITY)
    if (query.watched !== undefined) clauses.push(query.watched ? { id: { in: watchedIds } } : { id: { notIn: watchedIds } })
    let riskTruncated = false
    if (query.risk) {
      const risk = await this.riskClause(tenantId, scope, today, query.risk)
      riskTruncated = risk.truncated
      clauses.push(risk.clause)
    }

    const { records, truncated } = await loadProducts(this.prisma, { ...base, ...(clauses.length > 0 ? { AND: clauses } : {}) })
    const asins = [...new Set(records.map(record => record.asin))]
    const [sales, stock, margins, names, options, members, freshness] = await Promise.all([
      loadSales(this.prisma, tenantId, scope, asins, window.from, window.to),
      canStock ? loadSellable(this.prisma, tenantId, scope) : Promise.resolve(null),
      canProfit ? loadMargins(this.prisma, tenantId, scope, window.from, window.to) : Promise.resolve(null),
      memberNames(
        this.prisma,
        tenantId,
        records.map(record => record.ownerUserId),
      ),
      loadFilterOptions(this.prisma, base, tenantId),
      canWrite ? activeMembers(this.prisma, tenantId) : Promise.resolve([]),
      sourceFreshness(this.prisma, tenantId, scope, ['orders.api', 'inventory.api', CATALOG_FRESHNESS_KEY], now),
    ])

    const field = query.sort.field as ProductSort
    const rows = buildProductRows({ records, sales, stock, margins, names, watched: new Set(watchedIds), formerLabel: FORMER_MEMBER_LABEL }).sort((a, b) =>
      compareProductRows(a, b, field, query.sort.dir),
    )
    const { page, pageInfo } = pageOf(rows, offset, query.pageSize, binding)

    let state: ProductListResponse['state'] = 'OK'
    let note: string | null = null
    if (rows.length === 0) {
      const any = await this.prisma.fbaProduct.findFirst({ where: base, select: { id: true } })
      state = any ? 'NO_DATA' : 'NOT_CONNECTED'
      note = any ? NOTE_FILTERED : NOTE_NEVER
    }
    return {
      state,
      note,
      items: page,
      pageInfo,
      window,
      currency: 'USD',
      stock: this.dataState(canStock, stock?.size ?? 0, NOTE_STOCK_RESTRICTED, NOTE_NO_STOCK),
      profit: this.dataState(canProfit, margins?.size ?? 0, NOTE_PROFIT_RESTRICTED, NOTE_NO_PROFIT),
      filterOptions: options,
      members,
      canWrite,
      truncated,
      riskTruncated,
      freshness,
      notConnected: PRODUCT_NOT_CONNECTED_NOTE,
      basis: PRODUCT_BASIS,
    }
  }

  private dataState(allowed: boolean, size: number, restricted: string, empty: string): { state: ProductDataState; note: string | null } {
    if (!allowed) return { state: 'RESTRICTED', note: restricted }
    return size === 0 ? { state: 'NO_DATA', note: empty } : { state: 'OK', note: null }
  }

  /** 库存风险筛选：用库存健康页同一套装配与规则，把“风险等级”换成（店铺、SKU）清单，再套在商品查询上。没有匹配的库存记录时清单为空，筛选结果就是空。 */
  private async riskClause(tenantId: string, scope: ResolvedScope, today: string, risk: string): Promise<{ clause: Prisma.FbaProductWhereInput; truncated: boolean }> {
    const policy = await this.policies.currentOf(tenantId, today)
    const { items, truncated } = await this.loader.load({ tenantId, scope, today, policy })
    const bySku = new Map<string, string[]>()
    for (const item of items) {
      if (item.row.assessment.state !== 'OK' || item.row.assessment.risk !== risk) continue
      bySku.set(item.row.sellerAccountId, [...(bySku.get(item.row.sellerAccountId) ?? []), item.row.sku])
    }
    // 一个永远不成立的条件：没有任何匹配的库存记录
    if (bySku.size === 0) return { clause: { id: { in: [] } }, truncated }
    return { clause: { OR: [...bySku].map(([sellerAccountId, skus]) => ({ sellerAccountId, sellerSku: { in: skus } })) }, truncated }
  }
}
