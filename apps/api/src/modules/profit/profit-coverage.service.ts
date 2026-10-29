import { Injectable } from '@nestjs/common'
import {
  COST_STALE_DAYS,
  PROFIT_COVERAGE_ISSUES,
  PROFIT_COVERAGE_ISSUE_LABEL,
  STORE_LEVEL_SKU,
  ProfitCoverageQuerySchema,
  ScopeSearchSchema,
  type ProfitCoverageIssue,
  type ProfitCoverageResponse,
  type ProfitCoverageRow,
  type ProfitFlag,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { dateText } from '../overview'
import { coverageOf } from './profit-aggregate'
import { NO_DATA_NOTE, ProfitAccessService } from './profit-access.service'
import { mergeByDimension } from './profit-groups'
import { loadProducts, loadSkuGroups, loadStoreNames, loadTotalsByStore, MEMBER_SEP } from './profit-load'
import { decodeOffset, pageOf } from './profit-page'

const DAY_MS = 86_400_000
/** 利润日表里能直接数出来的覆盖问题（成本版本过期不是标记，由成本版本日期算）。 */
const FLAG_ISSUES = PROFIT_COVERAGE_ISSUES.filter((issue): issue is Exclude<ProfitCoverageIssue, 'COST_STALE'> => issue !== 'COST_STALE')
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 成本覆盖（07 章 7.9 第 5 个页签）：哪些 SKU 缺成本或成本有问题、成本版本是否过期、广告还有多少没分摊、汇率缺失或沿用了前值。
// 全部是成本类数据，需要 field.cost。只列有问题的 SKU（没有问题的不占位置）；没有成本数据不显示成 0。
@Injectable()
export class ProfitCoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProfitAccessService,
  ) {}

  async coverage(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitCoverageResponse> {
    const access = await this.access.resolve(req, rawQuery, 'cost', now)
    const query = ProfitCoverageQuerySchema.parse({ recognition: rawQuery.recognition, q: rawQuery.q, cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const where = this.access.where(access, query.recognition)
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const skuWhere = { ...where, sku: { not: STORE_LEVEL_SKU } }

    const [loaded, flagGroups, versions, byStore, names, fxGroups, freshness] = await Promise.all([
      loadSkuGroups(this.prisma, where),
      Promise.all(
        FLAG_ISSUES.map(issue =>
          this.prisma.profitDaily.groupBy({
            by: ['sellerAccountId', 'sku'],
            where: { ...skuWhere, flags: { has: issue as ProfitFlag } },
            _count: { _all: true },
            orderBy: [{ sellerAccountId: 'asc' }, { sku: 'asc' }],
            take: 20000,
          }),
        ),
      ),
      this.prisma.costVersion.groupBy({ by: ['sku'], where: { tenantId: access.tenantId, status: 'ACTIVE' }, _max: { effectiveFrom: true }, orderBy: { sku: 'asc' }, take: 20000 }),
      loadTotalsByStore(this.prisma, where),
      loadStoreNames(this.prisma, access.tenantId, access.scope),
      this.prisma.profitDaily.groupBy({
        by: ['costCurrency', 'fxSource', 'fxFallback'],
        where: { ...where, costCurrency: { not: null } },
        _count: { _all: true },
        _avg: { fxRate: true },
        orderBy: [{ costCurrency: 'asc' }, { fxSource: 'asc' }, { fxFallback: 'asc' }],
        take: 500,
      }),
      this.access.freshness(access, now),
    ])

    // 每个 店铺 × SKU 命中了哪些标记（行数）
    const issuesOf = new Map<string, Array<{ issue: ProfitCoverageIssue; rows: number }>>()
    const issueRows = new Map<ProfitCoverageIssue, number>()
    FLAG_ISSUES.forEach((issue, index) => {
      for (const group of flagGroups[index] ?? []) {
        const key = [group.sellerAccountId, group.sku].join(MEMBER_SEP)
        issuesOf.set(key, [...(issuesOf.get(key) ?? []), { issue, rows: group._count._all }])
        issueRows.set(issue, (issueRows.get(issue) ?? 0) + group._count._all)
      }
    })
    const latest = new Map(versions.map(version => [version.sku, version._max.effectiveFrom ? dateText(version._max.effectiveFrom) : null]))
    const ageOf = (sku: string) => {
      const effective = latest.get(sku)
      return effective ? Math.round((Date.parse(`${access.today}T00:00:00Z`) - Date.parse(`${effective}T00:00:00Z`)) / DAY_MS) : null
    }

    const drafts = mergeByDimension(loaded.groups, 'SKU', new Map()).filter(draft => draft.totals.units > 0)
    const withIssues = drafts.flatMap(draft => {
      const issues = [...(issuesOf.get([draft.sellerAccountId, draft.sku].join(MEMBER_SEP)) ?? [])]
      const age = draft.sku ? ageOf(draft.sku) : null
      if (age !== null && age > COST_STALE_DAYS) issues.push({ issue: 'COST_STALE', rows: 1 })
      return issues.length > 0 ? [{ draft, issues, age }] : []
    })
    const needle = query.q?.toLowerCase()
    const matched = withIssues
      .filter(item => !needle || [item.draft.sku, item.draft.asin].some(value => value?.toLowerCase().includes(needle)))
      .sort((a, b) => b.draft.totals.units - a.draft.totals.units || compare(a.draft.key, b.draft.key))
    const { page, pageInfo } = pageOf(matched, offset, query.pageSize, binding)
    const products = await loadProducts(this.prisma, access.tenantId, access.scope, { skus: page.flatMap(item => (item.draft.sku ? [item.draft.sku] : [])) })
    const productOf = (store: string | null, sku: string | null) => products.find(product => product.sellerAccountId === store && product.sellerSku === sku)
    const items: ProfitCoverageRow[] = page.map(({ draft, issues, age }) => {
      const product = productOf(draft.sellerAccountId, draft.sku)
      return {
        key: draft.key,
        sellerAccountId: draft.sellerAccountId ?? '',
        storeName: names.get(draft.sellerAccountId ?? '') ?? draft.sellerAccountId ?? '',
        sku: draft.sku ?? '',
        asin: draft.asin,
        title: product?.title ?? null,
        productId: product?.id ?? null,
        units: draft.totals.units,
        costedUnits: draft.totals.costedUnits,
        coverage: coverageOf(draft.totals.costedUnits, draft.totals.units),
        issues: issues.map(item => ({ ...item, label: PROFIT_COVERAGE_ISSUE_LABEL[item.issue] })).sort((a, b) => PROFIT_COVERAGE_ISSUES.indexOf(a.issue) - PROFIT_COVERAGE_ISSUES.indexOf(b.issue)),
        latestCostEffective: draft.sku ? (latest.get(draft.sku) ?? null) : null,
        costAgeDays: age,
      }
    })

    const adsStores = [...byStore.entries()].flatMap(([id, totals]) => (totals.adsUnallocated === null ? [] : [{ sellerAccountId: id, storeName: names.get(id) ?? id, amount: totals.adsUnallocated }]))
    adsStores.sort((a, b) => b.amount - a.amount || compare(a.storeName, b.storeName))
    const units = drafts.reduce((sum, draft) => sum + draft.totals.units, 0)
    const costedUnits = drafts.reduce((sum, draft) => sum + draft.totals.costedUnits, 0)
    const empty = loaded.groups.length === 0 && byStore.size === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_DATA_NOTE : null,
      ...this.access.common(access, query.recognition, freshness),
      summary: {
        skus: drafts.length,
        skusWithIssues: withIssues.length,
        staleSkus: withIssues.filter(item => item.issues.some(entry => entry.issue === 'COST_STALE')).length,
        units,
        costedUnits,
        coverage: coverageOf(costedUnits, units),
      },
      adsUnallocated: adsStores.length > 0 ? { state: 'OK', total: adsStores.reduce((sum, store) => sum + store.amount, 0), stores: adsStores } : { state: 'NOT_CONNECTED', total: null, stores: [] },
      fx: {
        fallbackRows: issueRows.get('FX_FALLBACK') ?? 0,
        missingRows: issueRows.get('FX_MISSING') ?? 0,
        items: fxGroups.map(group => ({
          currency: group.costCurrency ?? '',
          source: group.fxSource,
          fallback: group.fxFallback,
          rows: group._count._all,
          rate: group._avg.fxRate === null ? null : Number(group._avg.fxRate.toString()),
        })),
      },
      items,
      pageInfo,
      truncated: loaded.truncated,
      staleDays: COST_STALE_DAYS,
    }
  }
}
