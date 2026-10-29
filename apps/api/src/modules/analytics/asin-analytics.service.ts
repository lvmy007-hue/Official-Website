import { Injectable } from '@nestjs/common'
import {
  ASIN_ISSUE_NOTE,
  ASIN_RISK_FILTER_NOTE,
  ASIN_TREE_PAGE_SIZE,
  ASIN_TREE_NOTE,
  AsinAnalyticsQuerySchema,
  ScopeSearchSchema,
  type AsinAnalyticsQuery,
  type AsinAnalyticsResponse,
  type AsinFilterOptions,
  type AsinSelectRef,
  type AsinSelection,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { InventoryLoaderService, InventoryPolicyService } from '../inventory'
import { nullableSum } from '../overview'
import { loadProducts } from './asin-analytics-load'
import { buildTree, type AsinTotals, type ProductLite } from './asin-analytics-math'
import { AsinSelectionService } from './asin-analytics-selection.service'
import { BusinessReportsAccessService, type BrAccess } from './business-reports-access.service'
import { loadAsinGroups, preferGroups } from './business-reports-load'
import { decodeOffset, pageOf } from './business-reports-page'

// ASIN 与父体分析主页（P4-03，04 章 4.6）：左侧父体树（销售额从高到低，游标分页），右侧所选对象的逐日趋势；选中多个就是对比模式（最多 5 个）。
// 筛选（关键词、品牌、类目、标签、负责人、库存风险、刊登问题）都先在商品目录上做，树里只统计符合条件的子体。

const NO_POLICY_NOTE = '还没有生效的补货策略，库存风险无法计算，所以风险筛选没有结果；先在补货策略里配置'
const RISK_DENIED = '库存风险筛选需要库存读取权限'
const sorted = (values: Iterable<string | null>) => [...new Set([...values].filter((value): value is string => Boolean(value)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

function matches(product: ProductLite, query: AsinAnalyticsQuery, riskAsins: ReadonlySet<string> | null): boolean {
  if (query.brand && product.brand !== query.brand) return false
  if (query.category && product.categoryPath !== query.category) return false
  if (query.tag && !product.tagIds.includes(query.tag)) return false
  if (query.owner && product.ownerUserId !== query.owner) return false
  if (query.issue === 'INACTIVE' && product.listingStatus === 'ACTIVE') return false
  if (query.issue === 'NOT_FOUND' && product.catalogStatus !== 'NOT_FOUND') return false
  if (riskAsins && !riskAsins.has(product.asin)) return false
  if (query.q) {
    const needle = query.q.toLowerCase()
    return [product.asin, product.parentAsin, product.sellerSku, product.title].some(text => text?.toLowerCase().includes(needle))
  }
  return true
}

@Injectable()
export class AsinAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
    private readonly selecting: AsinSelectionService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<AsinAnalyticsResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const query = AsinAnalyticsQuerySchema.parse(rawQuery)
    if (query.risk && !hasPermission(access.permissions, 'inventory.read')) throw appError('TENANT_ACCESS_DENIED', RISK_DENIED)
    const { period } = access.periods
    const range = { from: period.from, to: period.to, days: period.days, defaulted: access.periods.defaulted }
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query, cursor: undefined })
    const offset = decodeOffset(query.cursor, binding)
    const [catalog, groups, risk] = await Promise.all([
      loadProducts(this.prisma, access.tenantId, access.scope),
      loadAsinGroups(this.prisma, access.tenantId, access.scope, 'CHILD', period.from, period.to, undefined),
      this.riskAsins(access, query),
    ])
    const totals = new Map<string, AsinTotals>()
    for (const group of preferGroups(groups.groups)) {
      const held = totals.get(group.asin)
      totals.set(group.asin, { sales: nullableSum([held?.sales, group.orderedSales]), sessions: nullableSum([held?.sessions, group.sessions]) })
    }
    const roundedTotals = new Map([...totals].map(([asin, value]) => [asin, { sales: value.sales === null ? null : Math.round(value.sales * 100) / 100, sessions: value.sessions }]))
    const tree = buildTree(
      catalog.products.filter(product => matches(product, query, risk.asins)),
      roundedTotals,
    )
    const { page, pageInfo } = pageOf(tree, offset, rawQuery.pageSize ? query.pageSize : ASIN_TREE_PAGE_SIZE, binding)
    const defaulted = query.select.length === 0
    const refs: AsinSelectRef[] = defaulted ? (tree[0] ? [{ kind: tree[0].kind, asin: tree[0].asin }] : []) : query.select
    const built = await Promise.all(refs.map(async ref => this.selecting.build(access, ref, await this.selecting.familyOf(access, ref, catalog.products), period)))
    const selection: AsinSelection[] = built.map(item => item.selection)
    const header = await this.access.header(
      access,
      { range, hasData: groups.groups.length > 0, truncated: groups.truncated || catalog.truncated || built.some(item => item.truncated), latestDate: null },
      now,
    )
    return {
      ...header,
      filters: await this.filterOptions(access, catalog.products),
      treeNote: ASIN_TREE_NOTE,
      tree: page,
      pageInfo,
      selectionDefaulted: defaulted,
      selection,
      selectionNote: selection.some(item => item.memberCount === 0) ? '部分所选对象不在你的数据范围内，或商品目录里没有它的记录' : null,
      issueNote: risk.note ?? (query.risk ? ASIN_RISK_FILTER_NOTE : ASIN_ISSUE_NOTE),
    }
  }

  /** 库存风险筛选：口径与库存健康页一致（读取库存记录并按当前生效的补货策略评估）；返回命中风险等级的 ASIN 集合。 */
  private async riskAsins(access: BrAccess, query: AsinAnalyticsQuery): Promise<{ asins: Set<string> | null; note: string | null }> {
    if (!query.risk) return { asins: null, note: null }
    const policy = await this.policies.currentOf(access.tenantId, access.today)
    if (!policy) return { asins: new Set(), note: NO_POLICY_NOTE }
    const { items } = await this.loader.load({ tenantId: access.tenantId, scope: access.scope, today: access.today, policy })
    const asins = new Set(items.filter(item => item.row.assessment.state === 'OK' && item.row.assessment.risk === query.risk).map(item => item.row.asin))
    return { asins, note: null }
  }

  private async filterOptions(access: BrAccess, products: readonly ProductLite[]): Promise<AsinFilterOptions> {
    const ownerIds = sorted(products.map(product => product.ownerUserId))
    const names = await memberNames(this.prisma, access.tenantId, ownerIds)
    return {
      brands: sorted(products.map(product => product.brand)),
      categories: sorted(products.map(product => product.categoryPath)),
      tags: sorted(products.flatMap(product => product.tagIds)),
      owners: ownerIds.map(id => ({ id, name: names.get(id) ?? '已离开的成员' })),
    }
  }
}
