import { Injectable } from '@nestjs/common'
import {
  LISTING_FRESHNESS_KEY,
  LISTING_FYP_REPORT_TYPE,
  LISTING_QUALITY_BASIS,
  LISTING_QUALITY_LIMITS,
  LISTING_QUALITY_READ,
  ListingQualityQuerySchema,
  averageResolveHours,
  type CursorPageInfo,
  type ListingChangeRow,
  type ListingInactiveRow,
  type ListingIssueRow,
  type ListingLifecycleStats,
  type ListingQualityResponse,
  type ListingQualityTab,
  type ListingRestrictionRow,
  type ListingSourceView,
} from '@nova/api-contracts'
import type { ListingChangeEvent, ListingIssue, ListingSnapshot, ListingWriteRun, Prisma } from '@prisma/client'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ActionGuardService } from '../../platform/write'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { addDays, resolvePeriods, todayIn, validZone } from '../overview'
import {
  QUALITY_ROW_LIMIT,
  changeRowOf,
  inactiveRowOf,
  issueOrderBy,
  issueRowOf,
  issueWhere,
  loadProducts,
  loadSalesByAsin,
  productKey,
  restrictionRowsOf,
  type ProductMap,
  type RowContext,
} from './listing-quality-load'
import { decodeOffset, pageOf } from './listing-perf-page'
import { writeStatusesOf } from './listing-write-common'

const NOTE_NEVER = '还没有同步到刊登数据：连接店铺并完成“商品刊登”授权后，每日同步会读取刊登问题与状态'
const NOTE_EMPTY: Record<ListingQualityTab, string> = {
  issues: '当前筛选条件下没有刊登问题',
  suppressed: '当前筛选条件下没有被搜索抑制的刊登',
  restrictions: '没有未过期的刊登限制查询结果；点“检查刊登限制”查询（结果保留 1 小时）',
  missing: '当前筛选条件下没有缺少必填属性的刊登',
  productType: '同步以来没有发现商品类型变更',
  otherEdits: '同步以来没有发现非本系统的标题或主图修改',
  inactive: '没有非活跃的刊登',
}
type Loaded =
  | { family: 'issue'; issues: ListingIssue[]; truncated: boolean; products: ProductMap }
  | { family: 'change'; changes: ListingChangeEvent[]; truncated: boolean; products: ProductMap }
  | { family: 'inactive'; inactive: ListingSnapshot[]; truncated: boolean; products: ProductMap }
  | { family: 'restriction'; runs: ListingWriteRun[]; truncated: boolean; products: ProductMap }

const SOURCE_KEYS = [LISTING_FRESHNESS_KEY, 'rpt.listings-fyp']

/** 刊登质量（05 章 5.4）：七个页签共用一个读取入口；筛选与排序在数据库（最多读 5000 行），分页用偏移游标（签名并绑定全部条件）。 */
@Injectable()
export class ListingQualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
  ) {}

  async quality(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ListingQualityResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_READ, rawQuery)
    const query = ListingQualityQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const tab = (query.tab ?? 'issues') as ListingQualityTab
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    const periods = resolvePeriods({ from: query.from, to: query.to, compare: query.compare, compareFrom: query.compareFrom, compareTo: query.compareTo }, today)
    const stores = new Map(
      (await this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, take: 500 })).map(store => [store.id, store.displayName]),
    )

    const loaded = await this.rowsOf(tab, tenantId, scope, query, now)
    const owners = await memberNames(
      this.prisma,
      tenantId,
      [...loaded.products.values()].map(product => product.ownerUserId),
    )
    const ctx: RowContext = { stores, products: loaded.products, owners, formerLabel: FORMER_MEMBER_LABEL, now }
    let issueView: ListingIssueRow[] = []
    let changeView: ListingChangeRow[] = []
    let inactiveView: ListingInactiveRow[] = []
    let pageInfo: CursorPageInfo = { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: 0 }
    if (loaded.family === 'issue') {
      const mine = loaded.issues.filter(row => !query.ownerId || ctx.products.get(productKey(row.sellerAccountId, row.sellerSku))?.ownerUserId === query.ownerId)
      const paged = pageOf(mine, offset, query.pageSize, binding)
      pageInfo = paged.pageInfo
      const sales =
        paged.page.length > 0
          ? await loadSalesByAsin(
              this.prisma,
              tenantId,
              paged.page.map(row => ({ storeId: row.sellerAccountId, asin: row.asin, firstSeenAt: row.firstSeenAt })),
              now,
            )
          : null
      issueView = paged.page.map(row => issueRowOf(row, ctx, sales))
    } else if (loaded.family === 'change') {
      const paged = pageOf(loaded.changes, offset, query.pageSize, binding)
      pageInfo = paged.pageInfo
      changeView = paged.page.map(row => changeRowOf(row, ctx))
    } else if (loaded.family === 'inactive') {
      const paged = pageOf(loaded.inactive, offset, query.pageSize, binding)
      pageInfo = paged.pageInfo
      inactiveView = paged.page.map(row => inactiveRowOf(row, ctx))
    }
    const restrictionView: ListingRestrictionRow[] = loaded.family === 'restriction' ? restrictionRowsOf(loaded.runs, ctx) : []
    if (loaded.family === 'restriction') pageInfo = { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: restrictionView.length }
    const [counts, stats, sources, freshness] = await Promise.all([
      this.countsOf(tenantId, scope, now),
      this.statsOf(tenantId, scope, periods.period, periods.defaulted),
      this.sourcesOf(tenantId, scope),
      sourceFreshness(this.prisma, tenantId, scope, SOURCE_KEYS, now),
    ])
    const never = sources[0]?.state === 'NOT_CONNECTED' && counts.issues + counts.inactive + counts.suppressed === 0
    const empty = issueView.length + changeView.length + inactiveView.length + restrictionView.length === 0
    return {
      tab,
      state: never ? 'NOT_CONNECTED' : empty ? 'NO_DATA' : 'OK',
      note: never ? NOTE_NEVER : empty ? NOTE_EMPTY[tab] : loaded.truncated ? `只显示最近的 ${QUALITY_ROW_LIMIT} 条，请用筛选条件缩小范围` : null,
      issueRows: issueView,
      changeRows: changeView,
      inactiveRows: inactiveView,
      restrictionRows: restrictionView,
      pageInfo,
      counts,
      stats,
      sources,
      freshness,
      basis: LISTING_QUALITY_BASIS,
      write: await writeStatusesOf(this.guard, context),
      stores: [...stores].map(([id, name]) => ({ id, name })),
    }
  }

  /** 当前页签要读的原始行（问题、变更事件、非活跃刊登、限制查询记录之一），连同它们的商品身份。 */
  private async rowsOf(
    tab: ListingQualityTab,
    tenantId: string,
    scope: ResolvedScope,
    query: { severity?: string; status?: string; impact?: string; sort: { field: string; dir: 'asc' | 'desc' } },
    now: Date,
  ): Promise<Loaded> {
    const base = { tenantId, ...storeWhere(scope) }
    if (tab === 'issues' || tab === 'suppressed' || tab === 'missing') {
      const issues = await this.prisma.listingIssue.findMany({ where: issueWhere(tenantId, scope, tab, query), orderBy: issueOrderBy(query.sort.field, query.sort.dir), take: QUALITY_ROW_LIMIT + 1 })
      const refs = issues.map(row => ({ storeId: row.sellerAccountId, sku: row.sellerSku, asin: row.asin }))
      return { family: 'issue', issues: issues.slice(0, QUALITY_ROW_LIMIT), truncated: issues.length > QUALITY_ROW_LIMIT, products: await loadProducts(this.prisma, tenantId, refs) }
    }
    if (tab === 'productType' || tab === 'otherEdits') {
      const where: Prisma.ListingChangeEventWhereInput = tab === 'productType' ? { ...base, changeKind: 'PRODUCT_TYPE_CHANGE' } : { ...base, changeKind: 'CONTENT_CHANGE', actorKind: { not: 'SELF' } }
      const changes = await this.prisma.listingChangeEvent.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }], take: QUALITY_ROW_LIMIT + 1 })
      const refs = changes.map(row => ({ storeId: row.sellerAccountId, sku: row.sellerSku, asin: row.asin }))
      return { family: 'change', changes: changes.slice(0, QUALITY_ROW_LIMIT), truncated: changes.length > QUALITY_ROW_LIMIT, products: await loadProducts(this.prisma, tenantId, refs) }
    }
    if (tab === 'inactive') {
      const inactive = await this.prisma.listingSnapshot.findMany({ where: { ...base, status: 'INACTIVE' }, orderBy: [{ statusSince: 'asc' }, { id: 'asc' }], take: QUALITY_ROW_LIMIT + 1 })
      const refs = inactive.map(row => ({ storeId: row.sellerAccountId, sku: row.sellerSku, asin: row.asin }))
      return { family: 'inactive', inactive: inactive.slice(0, QUALITY_ROW_LIMIT), truncated: inactive.length > QUALITY_ROW_LIMIT, products: await loadProducts(this.prisma, tenantId, refs) }
    }
    const runs = await this.prisma.listingWriteRun.findMany({
      where: { ...base, kind: 'RESTRICTIONS', status: 'SUCCEEDED', expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
    })
    return { family: 'restriction', runs, truncated: false, products: new Map() }
  }
  private async countsOf(tenantId: string, scope: ResolvedScope, now: Date): Promise<ListingQualityResponse['counts']> {
    const base = { tenantId, ...storeWhere(scope) }
    const open = { ...base, resolvedAt: null }
    const [issues, suppressed, missing, restrictions, productType, otherEdits, inactive] = await Promise.all([
      this.prisma.listingIssue.count({ where: { ...open, issueKind: { in: ['ISSUE', 'COMPLIANCE'] } } }),
      this.prisma.listingIssue.count({ where: { ...open, OR: [{ issueKind: 'SEARCH_SUPPRESSED' }, { impact: 'SEARCH_SUPPRESSED' }] } }),
      this.prisma.listingIssue.count({ where: { ...open, issueKind: { in: ['ISSUE', 'COMPLIANCE'] }, category: 'MISSING_ATTRIBUTE' } }),
      this.prisma.listingWriteRun.count({ where: { ...base, kind: 'RESTRICTIONS', status: 'SUCCEEDED', expiresAt: { gt: now } } }),
      this.prisma.listingChangeEvent.count({ where: { ...base, changeKind: 'PRODUCT_TYPE_CHANGE' } }),
      this.prisma.listingChangeEvent.count({ where: { ...base, changeKind: 'CONTENT_CHANGE', actorKind: { not: 'SELF' } } }),
      this.prisma.listingSnapshot.count({ where: { ...base, status: 'INACTIVE' } }),
    ])
    return { issues, suppressed, restrictions, missing, productType, otherEdits, inactive }
  }

  /** 生命周期统计：范围内新增与解决、当前未解决的构成、平均解决时长。 */
  private async statsOf(tenantId: string, scope: ResolvedScope, period: { from: string; to: string; days: number }, defaulted: boolean): Promise<ListingLifecycleStats> {
    const base = { tenantId, ...storeWhere(scope) }
    const from = new Date(`${period.from}T00:00:00Z`)
    const to = new Date(`${addDays(period.to, 1)}T00:00:00Z`)
    const open = { ...base, resolvedAt: null }
    const [newCount, resolvedCount, inProgressCount, openCount, openErrors, openWarnings, openImpactCount, resolved] = await Promise.all([
      this.prisma.listingIssue.count({ where: { ...base, firstSeenAt: { gte: from, lt: to } } }),
      this.prisma.listingIssue.count({ where: { ...base, resolvedAt: { gte: from, lt: to } } }),
      this.prisma.listingIssue.count({ where: { ...open, handlingStatus: 'IN_PROGRESS' } }),
      this.prisma.listingIssue.count({ where: open }),
      this.prisma.listingIssue.count({ where: { ...open, severity: 'ERROR' } }),
      this.prisma.listingIssue.count({ where: { ...open, severity: 'WARNING' } }),
      this.prisma.listingIssue.count({ where: { ...open, impact: { not: 'NONE' } } }),
      this.prisma.listingIssue.findMany({
        where: { ...base, resolvedAt: { gte: from, lt: to } },
        select: { firstSeenAt: true, resolvedAt: true },
        orderBy: { resolvedAt: 'desc' },
        take: LISTING_QUALITY_LIMITS.statsResolvedRead + 1,
      }),
    ])
    return {
      range: { from: period.from, to: period.to, days: period.days, defaulted },
      newCount,
      resolvedCount,
      inProgressCount,
      openCount,
      openErrors,
      openWarnings,
      openImpactCount,
      avgResolveHours: averageResolveHours(resolved.slice(0, LISTING_QUALITY_LIMITS.statsResolvedRead)),
      resolveSampleTruncated: resolved.length > LISTING_QUALITY_LIMITS.statsResolvedRead,
    }
  }

  /** 数据来源的接入情况：没有来源如实写“尚未接入”，不用 0 代替。 */
  private async sourcesOf(tenantId: string, scope: ResolvedScope): Promise<ListingSourceView[]> {
    const base = { tenantId, ...storeWhere(scope) }
    const [snapshots, rows] = await Promise.all([
      this.prisma.listingSnapshot.count({ where: base }),
      this.prisma.dataFreshness.findMany({ where: { ...base, sourceKey: { in: SOURCE_KEYS } }, select: { sourceKey: true, lastSuccessAt: true }, take: 500 }),
    ])
    const stateOf = (key: string, hasData: boolean): ListingSourceView['state'] => {
      const mine = rows.filter(row => row.sourceKey === key)
      return hasData || mine.some(row => row.lastSuccessAt) ? 'OK' : mine.length > 0 ? 'NO_DATA' : 'NOT_CONNECTED'
    }
    return [
      { key: LISTING_FRESHNESS_KEY, label: '刊登接口（每日同步）', state: stateOf(LISTING_FRESHNESS_KEY, snapshots > 0), note: snapshots > 0 ? null : '还没有成功同步过刊登，需要“商品刊登”授权' },
      { key: LISTING_FYP_REPORT_TYPE, label: '被搜索抑制报告（每日）', state: stateOf('rpt.listings-fyp', false), note: null },
      { key: 'restrictions', label: '刊登限制（按需查询）', state: 'OK', note: '需要时点“检查刊登限制”，结果保留 1 小时' },
      { key: 'notifications', label: '亚马逊推送（实时）', state: 'NOT_CONNECTED', note: '推送接收端暂缓接入，没有实时事件；以每日同步为准' },
    ]
  }
}
