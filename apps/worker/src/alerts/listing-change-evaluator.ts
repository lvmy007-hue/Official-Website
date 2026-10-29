import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, numberParam, scopeFilter } from './params'
import { DAY_MS, READ_LIMIT, clip, keyOf, loadProductLookup } from './product-common'

// 详情页被他人修改预警评估器（P4-15，09 章 9.1 商品类）：读刊登变更记录（ListingChangeEvent，P4-10）里 changeKind = CONTENT_CHANGE（标题、主图）
// 的事件，回看窗口内、修改人在阈值范围内的，按 店铺 × SKU 合并成一条。
// 修改人（actorKind）的含义：OTHER 是推送带了修改人且不是本店卖家编号；UNKNOWN 是同步比对发现、本系统没有写入能解释，或推送没带修改人——
// 后者可能是卖家自己在卖家后台改的，所以默认把两者都算上、会有误报，可在阈值里去掉“UNKNOWN”；SELF（本系统写入）与 AMAZON 不报。
// 推送接收端按 14.10 暂缓，目前事件基本来自每日同步比对（修改人都是未知）。窗口过后命中消失，预警自动恢复。

const ACTORS = ['OTHER', 'UNKNOWN'] as const
const FIELD_LIMIT = 5
const TEXT_LIMIT = 200

const FIELD_LABEL: Record<string, string> = { item_name: '标题', main_image: '主图' }
export const ACTOR_LABEL: Record<string, string> = { OTHER: '他人', UNKNOWN: '未知' }

export interface ChangeRow {
  sellerAccountId: string
  sellerSku: string
  asin: string
  fieldPath: string
  beforeText: string | null
  afterText: string | null
  actorKind: string
  occurredAt: Date
}

export interface ChangeGroup {
  sellerAccountId: string
  sellerSku: string
  asin: string
  changes: ChangeRow[]
  byOthers: boolean
  lastAt: Date
}

/** 按 店铺 × SKU 合并（没有 SKU 的事件按 ASIN 合并）：有“他人”修改的排前面，其次最近修改的在前（纯函数）。组内最近的在前。 */
export function groupChanges(rows: readonly ChangeRow[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.sellerSku || `asin:${row.asin}`)
    const group = groups.get(key) ?? { sellerAccountId: row.sellerAccountId, sellerSku: row.sellerSku, asin: row.asin, changes: [], byOthers: false, lastAt: row.occurredAt }
    group.changes.push(row)
    if (row.actorKind === 'OTHER') group.byOthers = true
    if (!group.asin && row.asin) group.asin = row.asin
    if (row.occurredAt > group.lastAt) group.lastAt = row.occurredAt
    groups.set(key, group)
  }
  for (const group of groups.values()) group.changes.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.fieldPath < b.fieldPath ? -1 : 1))
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.byOthers) - Number(a.byOthers) ||
      b.lastAt.getTime() - a.lastAt.getTime() ||
      (keyOf(a.sellerAccountId, a.sellerSku || a.asin) < keyOf(b.sellerAccountId, b.sellerSku || b.asin) ? -1 : 1),
  )
}

const fieldText = (path: string) => FIELD_LABEL[path] ?? (path || '内容')

export const contentChangedByOthersEvaluator: AlertEvaluator = {
  type: 'listing.content-changed-by-others',
  async evaluate({ db, tenantId, rule, now }) {
    const windowDays = numberParam(rule, 'windowDays', 3, { min: 1, max: 30 })
    const actors = choiceListParam(rule, 'actors', ACTORS, ACTORS)
    const scope = scopeFilter(rule)
    const rows = await db.listingChangeEvent.findMany({
      where: {
        tenantId,
        changeKind: 'CONTENT_CHANGE',
        actorKind: { in: actors },
        occurredAt: { gte: new Date(now.getTime() - windowDays * DAY_MS), lte: now },
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
        ...(scope.skus ? { sellerSku: { in: scope.skus } } : {}),
      },
      select: { sellerAccountId: true, sellerSku: true, asin: true, fieldPath: true, beforeText: true, afterText: true, actorKind: true, occurredAt: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    const groups = groupChanges(rows)
    if (groups.length === 0) return []
    const lookup = await loadProductLookup(db, tenantId, {
      storeIds: groups.map(group => group.sellerAccountId),
      skus: groups.flatMap(group => (group.sellerSku ? [group.sellerSku] : [])),
      asins: groups.flatMap(group => (!group.sellerSku && group.asin ? [group.asin] : [])),
    })
    return groups.map((group): AlertHit => {
      const key = group.sellerSku ? keyOf(group.sellerAccountId, group.sellerSku) : keyOf(group.sellerAccountId, `asin:${group.asin}`)
      const product = group.sellerSku ? lookup.bySku.get(key) : lookup.byAsin.get(keyOf(group.sellerAccountId, group.asin))
      const store = lookup.storeName.get(group.sellerAccountId) ?? '店铺'
      const label = group.sellerSku || group.asin || '商品'
      const fields = [...new Set(group.changes.map(change => fieldText(change.fieldPath)))]
      return {
        entityType: product ? 'ASIN' : 'LISTING_SKU',
        entityId: product?.id ?? key,
        sellerAccountId: group.sellerAccountId,
        entityLabel: `${label}（${store}）`,
        title: `${group.sellerSku ? `SKU ${group.sellerSku}` : `ASIN ${group.asin}`} 的${fields.join('、')}近 ${windowDays} 天被${group.byOthers ? '他人' : '未知来源'}修改`,
        suggestedAction: group.byOthers
          ? '到商品详情页核对修改内容；不是你们授权的改动，立即在卖家后台恢复，并联系品牌备案支持或检查是否有跟卖卖家改写了详情页'
          : '先确认是不是团队成员在卖家后台改的；不是的话在卖家后台恢复，并检查是否有跟卖卖家改写了详情页',
        evidence: {
          sku: group.sellerSku || null,
          asin: group.asin || null,
          title: product?.title ?? null,
          storeName: store,
          windowDays,
          changeCount: group.changes.length,
          byOthers: group.byOthers,
          lastChangedAt: group.lastAt.toISOString(),
          changes: group.changes.slice(0, FIELD_LIMIT).map(change => ({
            field: change.fieldPath,
            fieldLabel: fieldText(change.fieldPath),
            before: change.beforeText === null ? null : clip(change.beforeText, TEXT_LIMIT),
            after: change.afterText === null ? null : clip(change.afterText, TEXT_LIMIT),
            actor: change.actorKind,
            actorLabel: ACTOR_LABEL[change.actorKind] ?? change.actorKind,
            occurredAt: change.occurredAt.toISOString(),
          })),
        },
      }
    })
  },
}
