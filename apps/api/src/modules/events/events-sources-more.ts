import { auditActionLabel, entityDetailPath, LISTING_CHANGE_KIND_LABEL, type ListingChangeKind } from '@nova/api-contracts'
import { loadEntityEvents } from './events-sources'
import { beforeAfterText, capRows, EMPTY_LOADED, FETCH_LIMIT, mergeLoaded, type LoadContext, type Loaded } from './events-types'

// 统一事件接口的来源（二）：预警、Listing 变更、系统操作（审计里的业务写操作）、其他。

const ALERT_ENTITY_TYPES = ['ASIN', 'SKU', 'INVENTORY', 'LISTING']

/** 预警实例的归属：店铺看店铺下全部；商品与库存按店铺加商品编号、ASIN、SKU；广告活动按活动编号或亚马逊侧活动编号。 */
function alertWhere(ctx: LoadContext) {
  const { target } = ctx
  if (target.objectType === 'STORE' && target.storeId) return { sellerAccountId: target.storeId }
  if ((target.objectType === 'ASIN' || target.objectType === 'INVENTORY') && target.storeId) {
    const ids = [target.objectId, target.asin, target.sku].filter((id): id is string => Boolean(id))
    return { sellerAccountId: target.storeId, entityType: { in: ALERT_ENTITY_TYPES }, entityId: { in: ids } }
  }
  if (target.objectType === 'CAMPAIGN') return { entityType: 'CAMPAIGN', entityId: { in: [target.objectId, target.externalCampaignId].filter((id): id is string => Boolean(id)) } }
  return null
}

export async function loadAlerts(ctx: LoadContext): Promise<Loaded> {
  const { prisma, tenantId, window } = ctx
  const where = alertWhere(ctx)
  const instances = where
    ? await prisma.alertInstance.findMany({
        where: { tenantId, ...where, firstTriggeredAt: { gte: window.from, lt: window.to } },
        select: { id: true, title: true, entityLabel: true, firstTriggeredAt: true },
        orderBy: [{ firstTriggeredAt: 'desc' }, { id: 'asc' }],
        take: FETCH_LIMIT,
      })
    : []
  const capped = capRows(instances)
  const events = await loadEntityEvents(ctx, 'ALERT')
  return mergeLoaded([
    {
      rows: capped.rows.map(row => ({
        id: `alert:${row.id}`,
        type: 'ALERT' as const,
        occurredAt: row.firstTriggeredAt.toISOString(),
        title: row.title ?? '预警',
        summary: row.entityLabel,
        link: `/app/alerts/${encodeURIComponent(row.id)}`,
        actorLabel: '系统',
      })),
      overflow: capped.overflow,
    },
    events,
  ])
}

const listingKindLabel = (kind: string) => LISTING_CHANGE_KIND_LABEL[kind as ListingChangeKind] ?? '商品信息变更'

/** Listing 变更：商品与库存按 SKU 或 ASIN，店铺看全部；广告活动没有。 */
export async function loadListing(ctx: LoadContext): Promise<Loaded> {
  const { prisma, tenantId, target, window } = ctx
  let rows: Array<{ id: string; changeKind: string; fieldPath: string; beforeText: string | null; afterText: string | null; actorKind: string; occurredAt: Date; sellerSku: string }> = []
  const keys = [target.sku ? { sellerSku: target.sku } : null, target.asin ? { asin: target.asin } : null].filter((key): key is { sellerSku: string } | { asin: string } => key !== null)
  const byProduct = target.objectType === 'ASIN' || target.objectType === 'INVENTORY'
  if (target.storeId && (target.objectType === 'STORE' || (byProduct && keys.length > 0))) {
    rows = await prisma.listingChangeEvent.findMany({
      where: { tenantId, sellerAccountId: target.storeId, ...(byProduct ? { OR: keys } : {}), occurredAt: { gte: window.from, lt: window.to } },
      select: { id: true, changeKind: true, fieldPath: true, beforeText: true, afterText: true, actorKind: true, occurredAt: true, sellerSku: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: FETCH_LIMIT,
    })
  }
  const capped = capRows(rows)
  const events = await loadEntityEvents(ctx, 'LISTING')
  return mergeLoaded([
    {
      rows: capped.rows.map(row => ({
        id: `listing:${row.id}`,
        type: 'LISTING' as const,
        occurredAt: row.occurredAt.toISOString(),
        title: `${row.sellerSku ? `${row.sellerSku}：` : ''}${listingKindLabel(row.changeKind)}${row.fieldPath ? `（${row.fieldPath}）` : ''}`,
        summary: beforeAfterText(row.beforeText, row.afterText),
        link: target.objectType === 'STORE' ? null : entityDetailPath(target.objectType, target.objectId),
        actorLabel: row.actorKind === 'AMAZON' ? '亚马逊' : row.actorKind === 'USER' ? '成员' : '系统',
      })),
      overflow: capped.overflow,
    },
    events,
  ])
}

/** 审计里“针对这个对象”的成功写操作：对象类型对应的审计资源类型。试算、查看这类只读动作不算业务写操作。 */
const AUDIT_RESOURCE: Readonly<Record<string, string>> = { STORE: 'SellerAccount', ASIN: 'FbaProduct', CAMPAIGN: 'AdsCampaign' }
const READ_ONLY_ACTION = /(_SIMULATED|_VIEWED|_PREVIEWED)$/

export async function loadAudit(ctx: LoadContext): Promise<Loaded> {
  const { prisma, tenantId, target, window } = ctx
  const resourceType = AUDIT_RESOURCE[target.objectType]
  if (!resourceType) return EMPTY_LOADED
  const rows = await prisma.auditEvent.findMany({
    where: { tenantId, resourceType, resourceId: target.objectId, result: 'SUCCEEDED', occurredAt: { gte: window.from, lt: window.to } },
    select: { id: true, action: true, actorId: true, reason: true, occurredAt: true },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
    take: FETCH_LIMIT,
  })
  const capped = capRows(rows.filter(row => !READ_ONLY_ACTION.test(row.action)))
  return mergeLoaded([
    {
      rows: capped.rows.map(row => ({
        id: `audit:${row.id}`,
        type: 'AUDIT' as const,
        occurredAt: row.occurredAt.toISOString(),
        title: auditActionLabel(row.action),
        summary: row.reason,
        link: entityDetailPath(target.objectType, target.objectId),
        actorId: row.actorId,
        actorLabel: '系统',
      })),
      overflow: capped.overflow || rows.length > FETCH_LIMIT - 1,
    },
  ])
}

export async function loadOther(ctx: LoadContext): Promise<Loaded> {
  return mergeLoaded([await loadEntityEvents(ctx, 'OTHER')])
}
