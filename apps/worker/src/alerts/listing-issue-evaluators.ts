import { LISTING_IMPACT_LABEL, LISTING_ISSUE_KINDS, type ListingImpact } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, numberParam, scopeFilter } from './params'
import { DAY_MS, READ_LIMIT, clip, dayText, keyOf, loadProductLookup } from './product-common'

// 刊登问题预警评估器（P4-15，09 章 9.1 商品类）：读刊登质量页同一张表（ListingIssue，P4-10）。
// - 刊登问题新增（listing.issue-new）：还没解决、首次发现时间在回看天数内、严重度与类型在阈值范围内的问题，按 店铺 × SKU 合并成一条；
//   已被搜索抑制的问题（与刊登质量页“被搜索抑制”页签同一口径：问题类型是搜索抑制，或执法动作是搜索抑制）归下一条预警，这里不重复。
// - 被搜索抑制（listing.search-suppressed）：上述口径的、还没解决的问题，按 店铺 × SKU 合并；不限首次发现时间（只要还在抑制中就一直成立）。
// 问题在后续同步里消失（写了解决时间）或超出窗口，命中随之消失，预警自动恢复。“首次发现时间”是同步发现的时间，不是亚马逊产生问题的时间；
// 预警不估算影响金额（刊登质量页有按销量的估算，口径更复杂，不在这里重算）。

const SEVERITIES = ['ERROR', 'WARNING'] as const
const ISSUE_KINDS = LISTING_ISSUE_KINDS.filter(kind => kind !== 'SEARCH_SUPPRESSED')
const TOP_ISSUES = 5

export interface IssueRow {
  sellerAccountId: string
  sellerSku: string
  asin: string
  issueKind: string
  issueCode: string
  attributeName: string
  severity: string
  impact: string
  message: string
  firstSeenAt: Date
}

export interface IssueGroup {
  sellerAccountId: string
  sellerSku: string
  asin: string
  issues: IssueRow[]
  errorCount: number
  firstSeenAt: Date
}

/** 与刊登质量页“被搜索抑制”页签同一口径。 */
export const isSearchSuppressed = (row: Pick<IssueRow, 'issueKind' | 'impact'>) => row.issueKind === 'SEARCH_SUPPRESSED' || row.impact === 'SEARCH_SUPPRESSED'

/** 按 店铺 × SKU 合并：错误多的排前面，其次问题多的，最后按键排序保证稳定（纯函数）。组内问题按首次发现时间从早到晚。 */
export function groupIssues(rows: readonly IssueRow[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.sellerSku)
    const group = groups.get(key) ?? { sellerAccountId: row.sellerAccountId, sellerSku: row.sellerSku, asin: '', issues: [], errorCount: 0, firstSeenAt: row.firstSeenAt }
    group.issues.push(row)
    if (row.severity === 'ERROR') group.errorCount += 1
    if (!group.asin && row.asin) group.asin = row.asin
    if (row.firstSeenAt < group.firstSeenAt) group.firstSeenAt = row.firstSeenAt
    groups.set(key, group)
  }
  for (const group of groups.values()) group.issues.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || (a.issueCode + a.attributeName < b.issueCode + b.attributeName ? -1 : 1))
  return [...groups.values()].sort(
    (a, b) => b.errorCount - a.errorCount || b.issues.length - a.issues.length || (keyOf(a.sellerAccountId, a.sellerSku) < keyOf(b.sellerAccountId, b.sellerSku) ? -1 : 1),
  )
}

const impactText = (impact: string) => LISTING_IMPACT_LABEL[impact as ListingImpact] ?? impact

function evidenceOf(group: IssueGroup, store: string, title: string | null, now: Date) {
  return {
    sku: group.sellerSku,
    asin: group.asin || null,
    title,
    storeName: store,
    issueCount: group.issues.length,
    errorCount: group.errorCount,
    firstSeenAt: group.firstSeenAt.toISOString(),
    openDays: Math.max(0, Math.floor((now.getTime() - group.firstSeenAt.getTime()) / DAY_MS)),
    issues: group.issues.slice(0, TOP_ISSUES).map(issue => ({
      code: issue.issueCode,
      attribute: issue.attributeName || null,
      severity: issue.severity,
      impact: issue.impact,
      impactLabel: impactText(issue.impact),
      message: clip(issue.message, 200),
    })),
  }
}

async function hitsOf(
  db: Parameters<AlertEvaluator['evaluate']>[0]['db'],
  tenantId: string,
  groups: readonly IssueGroup[],
  now: Date,
  text: (group: IssueGroup, store: string) => { title: string; suggestedAction: string },
): Promise<AlertHit[]> {
  if (groups.length === 0) return []
  const lookup = await loadProductLookup(db, tenantId, { storeIds: groups.map(group => group.sellerAccountId), skus: groups.map(group => group.sellerSku) })
  return groups.map((group): AlertHit => {
    const key = keyOf(group.sellerAccountId, group.sellerSku)
    const product = lookup.bySku.get(key)
    const store = lookup.storeName.get(group.sellerAccountId) ?? '店铺'
    const wording = text(group, store)
    return {
      // 有商品记录的点进去是商品全景（刊登质量在其中）；没有的按 店铺|SKU 登记
      entityType: product ? 'ASIN' : 'LISTING_SKU',
      entityId: product?.id ?? key,
      sellerAccountId: group.sellerAccountId,
      entityLabel: `${group.sellerSku}（${store}）`,
      title: wording.title,
      suggestedAction: wording.suggestedAction,
      evidence: evidenceOf({ ...group, asin: group.asin || product?.asin || '' }, store, product?.title ?? null, now),
    }
  })
}

const selectIssue = {
  sellerAccountId: true,
  sellerSku: true,
  asin: true,
  issueKind: true,
  issueCode: true,
  attributeName: true,
  severity: true,
  impact: true,
  message: true,
  firstSeenAt: true,
} as const

export const newListingIssueEvaluator: AlertEvaluator = {
  type: 'listing.issue-new',
  async evaluate({ db, tenantId, rule, now }) {
    const windowDays = numberParam(rule, 'windowDays', 3, { min: 1, max: 30 })
    const severities = choiceListParam(rule, 'severities', SEVERITIES, ['ERROR'])
    const kinds = choiceListParam(rule, 'kinds', ISSUE_KINDS, ISSUE_KINDS)
    const scope = scopeFilter(rule)
    const rows = await db.listingIssue.findMany({
      where: {
        tenantId,
        resolvedAt: null,
        firstSeenAt: { gte: new Date(now.getTime() - windowDays * DAY_MS) },
        issueKind: { in: kinds },
        severity: { in: severities },
        impact: { not: 'SEARCH_SUPPRESSED' },
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
        ...(scope.skus ? { sellerSku: { in: scope.skus } } : {}),
      },
      select: selectIssue,
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    const groups = groupIssues(rows.filter(row => !isSearchSuppressed(row)))
    return hitsOf(db, tenantId, groups, now, group => ({
      title: `SKU ${group.sellerSku} 近 ${windowDays} 天新增 ${group.issues.length} 个刊登问题${group.errorCount > 0 ? `（其中 ${group.errorCount} 个错误）` : ''}`,
      suggestedAction: '到刊登质量页查看问题原文与受影响属性，修改对应属性后先做校验预览再提交；合规类问题先阅读亚马逊的说明再处理',
    }))
  },
}

export const searchSuppressedEvaluator: AlertEvaluator = {
  type: 'listing.search-suppressed',
  async evaluate({ db, tenantId, rule, now }) {
    const scope = scopeFilter(rule)
    const rows = await db.listingIssue.findMany({
      where: {
        tenantId,
        resolvedAt: null,
        OR: [{ issueKind: 'SEARCH_SUPPRESSED' }, { impact: 'SEARCH_SUPPRESSED' }],
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
        ...(scope.skus ? { sellerSku: { in: scope.skus } } : {}),
      },
      select: selectIssue,
      orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    const groups = groupIssues(rows.filter(isSearchSuppressed))
    return hitsOf(db, tenantId, groups, now, group => ({
      title: `SKU ${group.sellerSku} 被搜索抑制，自 ${dayText(group.firstSeenAt)} 起已 ${Math.max(0, Math.floor((now.getTime() - group.firstSeenAt.getTime()) / DAY_MS))} 天（${group.issues.length} 个问题）`,
      suggestedAction: '到刊登质量页的“被搜索抑制”查看原因：补齐标题、关键属性与图片等亚马逊要求的信息后，亚马逊会自动恢复搜索展示；修复后在刊登质量页提交修复',
    }))
  },
}
