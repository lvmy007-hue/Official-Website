import { LISTING_ROLE_MISSING } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { isListingsForbidden, type ListingsApi } from '../../connectors/listings-api'
import type { ImportContext } from '../../types'
import { parseListings, type ParsedListing } from './items-parse'

// 刊登同步器（importers.md I-10，P4-10）：每日全量读取美国站的全部刊登，写刊登当前状态、刊登问题，并把标题、主图、商品类型的变化记成变更事件。
// 规则：
//   - 每页 20 个，每次最多 MAX_PAGES 页；翻不完标 incomplete，这一轮不做“消失即解决”的整体对账（没读到不等于已解决），只处理读到的商品；
//   - 问题按（店铺，SKU，类型，代码，属性）幂等：仍然存在 → 更新最后出现时间；消失 → 写解决时间；再次出现 → 重开并把首次出现时间重置为现在；
//   - 状态变化（可售 ↔ 不可售）重置 statusSince；标题、主图、商品类型两边都有值且不同才记变更，首次填入不算；
//   - 变更的行为人：该 SKU 最近 3 天内本系统有成功的修改或批量任务 → SELF（关联任务编号），否则 UNKNOWN（亚马逊不告诉我们是谁改的，页面如实写“未知（非本系统）”）；
//   - 403（缺“商品刊登”角色）以不可重试的 LISTING_ROLE_MISSING 结束。

export interface ListingsScope {
  tenantId: string
  sellerAccountId: string
}
export interface ListingsOptions {
  now?: Date
  maxPages?: number
}
export type ListingsResult =
  | { notApplicable: true; reason: 'SELLER_ID_MISSING'; imported: 0 }
  | { notApplicable: false; imported: number; listings: number; issuesOpened: number; issuesResolved: number; changes: number; skipped: number; incomplete: boolean }

export const MAX_PAGES = 500
export const SELF_WINDOW_MS = 3 * 86_400_000
const MARKETPLACE = 'ATVPDKIKX0DER'
const ymd = (date: Date) => date.toISOString().slice(0, 10)
const WATCHED = [
  { field: 'item_name', kind: 'CONTENT_CHANGE' as const, read: (row: ParsedListing) => row.itemName },
  { field: 'main_image', kind: 'CONTENT_CHANGE' as const, read: (row: ParsedListing) => row.mainImageUrl },
]

/** 最近有成功修改的 SKU → 对应的任务编号（修改刊登带 SKU；批量任务的 SKU 在请求内容里）。 */
export async function recentSelfWrites(ctx: ImportContext, scope: ListingsScope, now: Date): Promise<Map<string, string>> {
  const runs = await ctx.prisma.listingWriteRun.findMany({
    where: {
      tenantId: scope.tenantId,
      sellerAccountId: scope.sellerAccountId,
      kind: { in: ['PATCH', 'BATCH'] },
      status: { in: ['SUCCEEDED', 'PARTIAL'] },
      finishedAt: { gte: new Date(now.getTime() - SELF_WINDOW_MS) },
    },
    select: { id: true, kind: true, sellerSku: true, requestJson: true },
    orderBy: { finishedAt: 'desc' },
    take: 500,
  })
  const map = new Map<string, string>()
  for (const run of runs) {
    if (run.kind === 'PATCH' && run.sellerSku) {
      if (!map.has(run.sellerSku)) map.set(run.sellerSku, run.id)
      continue
    }
    const items = (run.requestJson as { items?: Array<{ sku?: unknown }> } | null)?.items
    for (const item of items ?? []) if (typeof item.sku === 'string' && !map.has(item.sku)) map.set(item.sku, run.id)
  }
  return map
}

export async function syncListings(ctx: ImportContext, api: ListingsApi | null, scope: ListingsScope, options: ListingsOptions = {}): Promise<ListingsResult> {
  const now = options.now ?? new Date()
  if (!api) return { notApplicable: true, reason: 'SELLER_ID_MISSING', imported: 0 }
  const self = await recentSelfWrites(ctx, scope, now)
  const totals = { listings: 0, issuesOpened: 0, issuesResolved: 0, changes: 0, skipped: 0 }
  let token: string | undefined
  let incomplete = true
  for (let page = 0; page < (options.maxPages ?? MAX_PAGES); page += 1) {
    let parsed
    try {
      parsed = parseListings(await api.search(token))
    } catch (error) {
      if (isListingsForbidden(error)) throw new NonRetryableError(LISTING_ROLE_MISSING, '亚马逊商品刊登接口的角色尚未获批，刊登质量无法同步')
      throw error
    }
    totals.skipped += parsed.skipped
    for (const item of parsed.items) await syncOne(ctx, scope, item, now, self, totals)
    if (!parsed.nextToken) {
      incomplete = false
      break
    }
    token = parsed.nextToken
  }
  if (!incomplete) {
    // 整体对账：这一轮完整读完，仍未见到的刊登问题（刊登被删除或问题已不存在）一律写解决时间
    const gone = await ctx.prisma.listingIssue.updateMany({
      where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, issueKind: 'ISSUE', resolvedAt: null, lastSeenAt: { lt: now } },
      data: { resolvedAt: now },
    })
    totals.issuesResolved += gone.count
  } else ctx.logger.warn({ ...scope }, 'listings sync reached the page limit; vanished issues are not reconciled until a complete run')
  return { notApplicable: false, imported: totals.listings, ...totals, incomplete }
}

async function syncOne(
  ctx: ImportContext,
  scope: ListingsScope,
  item: ParsedListing,
  now: Date,
  self: Map<string, string>,
  totals: { listings: number; issuesOpened: number; issuesResolved: number; changes: number },
) {
  const { prisma } = ctx
  const base = { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId }
  totals.listings += 1
  if (item.hasSummary) {
    const where = { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE, sellerSku: item.sku } }
    const before = await prisma.listingSnapshot.findUnique({ where })
    const data = {
      asin: item.asin,
      productType: item.productType ?? before?.productType ?? null,
      conditionType: item.conditionType,
      status: item.status,
      amazonStatuses: item.amazonStatuses,
      itemName: item.itemName ?? before?.itemName ?? null,
      mainImageUrl: item.mainImageUrl ?? before?.mainImageUrl ?? null,
      syncedAt: now,
    }
    if (!before) await prisma.listingSnapshot.create({ data: { ...base, marketplaceId: MARKETPLACE, sellerSku: item.sku, statusSince: now, ...data } })
    else {
      await prisma.listingSnapshot.update({ where, data: { ...data, ...(before.status !== item.status ? { statusSince: now } : {}) } })
      const changes: Array<{ kind: 'PRODUCT_TYPE_CHANGE' | 'CONTENT_CHANGE'; field: string; from: string; to: string }> = []
      if (before.productType && item.productType && before.productType !== item.productType) changes.push({ kind: 'PRODUCT_TYPE_CHANGE', field: '', from: before.productType, to: item.productType })
      const previous: Record<string, string | null> = { item_name: before.itemName, main_image: before.mainImageUrl }
      for (const watched of WATCHED) {
        const after = watched.read(item)
        const was = previous[watched.field]
        if (was && after && was !== after) changes.push({ kind: watched.kind, field: watched.field, from: was, to: after })
      }
      const runId = self.get(item.sku) ?? null
      for (const change of changes) {
        const created = await prisma.listingChangeEvent.createMany({
          data: [
            {
              ...base,
              sellerSku: item.sku,
              asin: item.asin,
              changeKind: change.kind,
              fieldPath: change.field,
              beforeText: change.from.slice(0, 1000),
              afterText: change.to.slice(0, 1000),
              actorKind: runId ? 'SELF' : 'UNKNOWN',
              occurredAt: now,
              writeRunId: runId,
              sourceRef: `sync:${ymd(now)}`,
            },
          ],
          skipDuplicates: true,
        })
        totals.changes += created.count
      }
    }
  }
  const open = await prisma.listingIssue.findMany({ where: { sellerAccountId: scope.sellerAccountId, sellerSku: item.sku, issueKind: 'ISSUE' } })
  const byKey = new Map(open.map(row => [`${row.issueCode}|${row.attributeName}`, row]))
  for (const issue of item.issues) {
    const row = byKey.get(`${issue.code}|${issue.attributeName}`)
    const fields = { asin: item.asin, category: issue.category, severity: issue.severity, impact: issue.impact, message: issue.message, lastSeenAt: now }
    if (!row) {
      await prisma.listingIssue.create({ data: { ...base, sellerSku: item.sku, issueKind: 'ISSUE', issueCode: issue.code, attributeName: issue.attributeName, firstSeenAt: now, ...fields } })
      totals.issuesOpened += 1
    } else if (row.resolvedAt) {
      await prisma.listingIssue.update({ where: { id: row.id }, data: { ...fields, firstSeenAt: now, resolvedAt: null, handlingStatus: 'OPEN', handlingRunId: null, version: { increment: 1 } } })
      totals.issuesOpened += 1
    } else await prisma.listingIssue.update({ where: { id: row.id }, data: fields })
  }
  const seen = new Set(item.issues.map(issue => `${issue.code}|${issue.attributeName}`))
  const gone = open.filter(row => !row.resolvedAt && !seen.has(`${row.issueCode}|${row.attributeName}`))
  if (gone.length > 0) {
    await prisma.listingIssue.updateMany({ where: { id: { in: gone.map(row => row.id) } }, data: { resolvedAt: now } })
    totals.issuesResolved += gone.length
  }
}
