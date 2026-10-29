import { PROMOTIONS_ROLE_MISSING, canonicalize } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { Prisma } from '@prisma/client'
import { UpstreamHttpError } from '../../connectors/http-error'
import { isRoleMissing } from '../../connectors/support-api'
import type { PromotionsApi } from '../../connectors/promotions-api'
import type { ImportContext } from '../../types'
import { issuesOfItem, parsePromotions, parseSelection, type ParsedItem, type ParsedItemIssue, type ParsedPromotion } from './parse'

// 促销同步器（importers.md I-17，P4-05）：每日把亚马逊促销接口里的促销与商品清单只读拉下来。接口限速每 10 秒 1 次，所以每次的调用量有上限：
//   - 搜索只取开始时间在回看天数内的促销，每次最多 SEARCH_PAGES 页（每页 100 个），触到上限标 incomplete，下次继续（按开始时间新到旧，旧的最后补）；
//   - 促销本身没变就不写；状态会随时间变化（即将开始→进行中→已结束）而更新时间不变，所以状态也参与比较；
//   - 商品清单只在“促销更新时间与上次取清单时不一致”或版本号变化时重取，每次最多重取 SELECTION_PROMOTIONS 个促销（进行中与即将开始的优先、再按开始时间新到旧），每个最多 SELECTION_PAGES 页（每页 100 个），
//     超过的标记“商品清单不完整”；CATALOG 类型（全店商品）亚马逊不提供清单，只记类型，商品数留空；
//   - 清单整份取回后才先删后写，取不全（中途出错）不会留下半份；
//   - 403（接口角色未获批）以不可重试的 ROLE_MISSING 结束；单个促销的清单取不到（400、404）跳过该促销，其余错误原样抛出交给任务运行时分类重试；
//   - 不删除促销：亚马逊不再返回的促销保留（历史记录），不当作被删除。

export interface PromotionsScope {
  tenantId: string
  sellerAccountId: string
}
export interface PromotionsOptions {
  /** 本次同步的时间；测试注入，缺省取当前时间。 */
  now?: Date
  lookbackDays?: number
  searchPages?: number
  selectionPromotions?: number
  selectionPages?: number
}
export interface PromotionsResult {
  notApplicable: false
  imported: number
  promotions: number
  changed: number
  itemPromotions: number
  items: number
  skipped: number
  incomplete: boolean
}

export const LOOKBACK_DAYS = 400
export const SEARCH_PAGES = 10
export const SELECTION_PROMOTIONS = 15
export const SELECTION_PAGES = 5
const ID_CHUNK = 500
const ACTIVE = ['RUNNING', 'UPCOMING']

/** 403 → ROLE_MISSING（不可重试）；其余原样抛出。 */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (isRoleMissing(error)) throw new NonRetryableError(PROMOTIONS_ROLE_MISSING, '亚马逊促销接口的角色尚未获批，促销无法同步')
    throw error
  }
}
const rejected = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && (error.status === 400 || error.status === 404)
const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null)
const json = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue))

async function fetchPromotions(api: PromotionsApi, since: Date, pages: number): Promise<{ promotions: ParsedPromotion[]; skipped: number; incomplete: boolean }> {
  const promotions: ParsedPromotion[] = []
  let skipped = 0
  let token: string | undefined
  for (let page = 0; page < pages; page += 1) {
    const parsed = parsePromotions(await guarded(() => api.search(since, token)))
    promotions.push(...parsed.promotions)
    skipped += parsed.skipped
    if (!parsed.nextToken) return { promotions, skipped, incomplete: false }
    token = parsed.nextToken
  }
  return { promotions, skipped, incomplete: true }
}

type Existing = {
  id: string
  title: string
  status: string
  revisionStatus: string | null
  startAt: Date
  endAt: Date | null
  amazonUpdatedAt: Date
  errorCount: number
  warningCount: number
  itemsForUpdatedAt: Date | null
  selectionRevision: number | null
  issuesJson: unknown
}

export async function syncPromotions(ctx: ImportContext, api: PromotionsApi, scope: PromotionsScope, options: PromotionsOptions = {}): Promise<PromotionsResult> {
  const { prisma } = ctx
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - (options.lookbackDays ?? LOOKBACK_DAYS) * 86_400_000)
  const fetched = await fetchPromotions(api, since, options.searchPages ?? SEARCH_PAGES)
  // 同一个促销在翻页期间可能重复出现（促销在两次取页之间更新）：以后出现的为准
  const parsed = [...new Map(fetched.promotions.map(item => [item.promotionId, item])).values()]

  const existing = new Map<string, Existing>()
  for (let start = 0; start < parsed.length; start += ID_CHUNK) {
    const rows = await prisma.promotion.findMany({
      where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, promotionId: { in: parsed.slice(start, start + ID_CHUNK).map(item => item.promotionId) } },
      select: {
        id: true,
        promotionId: true,
        title: true,
        status: true,
        revisionStatus: true,
        startAt: true,
        endAt: true,
        amazonUpdatedAt: true,
        errorCount: true,
        warningCount: true,
        itemsForUpdatedAt: true,
        selectionRevision: true,
        issuesJson: true,
      },
    })
    for (const row of rows) existing.set(row.promotionId, row)
  }

  let changed = 0
  const stale: Array<{ item: ParsedPromotion; rowId: string }> = []
  for (const item of parsed) {
    const before = existing.get(item.promotionId)
    const data = {
      marketplaceId: 'ATVPDKIKX0DER',
      promotionType: item.type,
      couponType: item.couponType,
      title: item.title,
      status: item.status,
      revisionStatus: item.revisionStatus,
      startAt: item.startAt,
      endAt: item.endAt,
      amazonCreatedAt: item.createdAt,
      amazonUpdatedAt: item.updatedAt,
      mappingId: item.mappingId,
      budgetType: item.budget?.type ?? null,
      budgetValue: item.budget?.value ?? null,
      budgetCurrency: item.budget?.currency ?? null,
      benefitJson: json(item.benefit),
      feeJson: json(item.fee),
      selectionType: item.selection?.type ?? null,
      selectionId: item.selection?.id ?? null,
      selectionRevision: item.selection?.revision ?? null,
      issuesJson: item.issues as unknown as Prisma.InputJsonValue,
      errorCount: item.errorCount,
      warningCount: item.warningCount,
      syncedAt: now,
    }
    if (!before) {
      const created = await prisma.promotion.create({ data: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, promotionId: item.promotionId, ...data }, select: { id: true } })
      changed += 1
      if (item.selection?.type === 'ITEMS') stale.push({ item, rowId: created.id })
      continue
    }
    const unchanged =
      before.title === item.title &&
      before.status === item.status &&
      before.revisionStatus === item.revisionStatus &&
      sameTime(before.startAt, item.startAt) &&
      sameTime(before.endAt, item.endAt) &&
      sameTime(before.amazonUpdatedAt, item.updatedAt) &&
      before.errorCount === item.errorCount &&
      before.warningCount === item.warningCount &&
      canonicalize(before.issuesJson) === canonicalize(item.issues) // jsonb 会重排键，不能直接比较序列化结果
    if (!unchanged) {
      await prisma.promotion.update({ where: { id: before.id }, data })
      changed += 1
    }
    const needsItems = item.selection?.type === 'ITEMS' && (!sameTime(before.itemsForUpdatedAt, item.updatedAt) || before.selectionRevision !== (item.selection?.revision ?? null))
    if (needsItems) stale.push({ item, rowId: before.id })
  }

  // 商品清单：进行中与即将开始的优先，再按开始时间新到旧；每次只重取一部分
  stale.sort((a, b) => Number(!ACTIVE.includes(a.item.status)) - Number(!ACTIVE.includes(b.item.status)) || b.item.startAt.getTime() - a.item.startAt.getTime())
  const batch = stale.slice(0, options.selectionPromotions ?? SELECTION_PROMOTIONS)
  let items = 0
  let skipped = fetched.skipped
  let itemPromotions = 0
  let truncatedAny = false
  for (const { item, rowId } of batch) {
    const synced = await syncItems(ctx, api, scope, item, rowId, now, options.selectionPages ?? SELECTION_PAGES)
    if (synced === null) {
      skipped += 1
      continue
    }
    itemPromotions += 1
    items += synced.count
    skipped += synced.skipped
    truncatedAny = truncatedAny || synced.truncated
  }
  const incomplete = fetched.incomplete || stale.length > batch.length || truncatedAny
  if (skipped > 0) ctx.logger.warn({ ...scope, skipped }, 'promotion rows skipped: missing required fields or selection unavailable')
  if (incomplete) ctx.logger.warn({ ...scope }, 'promotions sync reached the page or selection limit; remaining rows are picked up by the next sync')
  return { notApplicable: false, imported: parsed.length + items, promotions: parsed.length, changed, itemPromotions, items, skipped, incomplete }
}

/** 取一个促销的全部商品（含商品级问题）并先删后写；返回写入条数，取不到（400、404）返回 null。 */
async function syncItems(
  ctx: ImportContext,
  api: PromotionsApi,
  scope: PromotionsScope,
  item: ParsedPromotion,
  rowId: string,
  now: Date,
  maxPages: number,
): Promise<{ count: number; skipped: number; truncated: boolean } | null> {
  const { prisma } = ctx
  const selection = item.selection
  if (!selection?.id || selection.revision === null) return null
  const rows = new Map<string, ParsedItem>()
  const issues: ParsedItemIssue[] = []
  let skipped = 0
  let truncated = false
  let token: string | undefined
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const parsed = parseSelection(await guarded(() => api.selection(item.promotionId, selection.id as string, selection.revision as number, token)))
      for (const row of parsed.items) rows.set(`${row.asin}|${row.sku}`, row)
      issues.push(...parsed.issues)
      skipped += parsed.skipped
      if (!parsed.nextToken) break
      token = parsed.nextToken
      truncated = page === maxPages - 1
    }
  } catch (error) {
    if (rejected(error)) return null
    throw error
  }
  const kept = [...rows.values()]
  await prisma.promotionItem.deleteMany({ where: { tenantId: scope.tenantId, promotionRowId: rowId } })
  if (kept.length > 0) {
    await prisma.promotionItem.createMany({
      data: kept.map(row => ({
        tenantId: scope.tenantId,
        sellerAccountId: scope.sellerAccountId,
        promotionRowId: rowId,
        asin: row.asin,
        sku: row.sku,
        benefitType: row.benefitType,
        discountType: row.discountType,
        percentOff: row.percentOff,
        amountOff: row.amountOff,
        fixedPrice: row.fixedPrice,
        currency: row.currency,
        perCustomerUses: row.perCustomerUses,
        budgetType: row.budgetType,
        budgetValue: row.budgetValue,
        issuesJson: issuesOfItem(row, issues) as unknown as Prisma.InputJsonValue,
        syncedAt: now,
      })),
    })
  }
  await prisma.promotion.update({ where: { id: rowId }, data: { itemCount: kept.length, itemsForUpdatedAt: item.updatedAt, itemsTruncated: truncated, syncedAt: now } })
  return { count: kept.length, skipped, truncated }
}
