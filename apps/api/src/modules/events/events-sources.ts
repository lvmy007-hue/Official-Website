import { entityDetailPath, eventKindsOf, EVENT_KIND_TYPE, OPERATION_CATEGORY_LABEL, PRICE_CHANGE_SOURCE_LABEL, type EventType } from '@nova/api-contracts'
import { beforeAfterText, capRows, detailChange, EMPTY_LOADED, FETCH_LIMIT, mergeLoaded, type LoadContext, type Loaded, type RawEvent } from './events-types'

// 统一事件接口的来源（一）：运营日志、对象事件表、价格、广告变更。每个来源最多读 201 行，都走已有索引。
// 来源与对象的对应关系见 CR-114：对象没有对应数据（例如商品没有广告活动变更日志）就返回空，不拿别的对象的数据凑。

const newestFirst = [{ occurredAt: 'desc' as const }, { id: 'asc' as const }]

/** 运营日志：范围只有店铺、商品、广告活动三种，对象类型与范围同名。 */
export async function loadOperation(ctx: LoadContext): Promise<Loaded> {
  const { prisma, tenantId, target, window } = ctx
  if (target.objectType !== 'STORE' && target.objectType !== 'ASIN' && target.objectType !== 'CAMPAIGN') return EMPTY_LOADED
  const rows = await prisma.operationLog.findMany({
    where: { tenantId, scope: target.objectType, scopeRef: target.objectId, occurredAt: { gte: window.from, lt: window.to } },
    orderBy: newestFirst,
    take: FETCH_LIMIT,
  })
  const capped = capRows(rows)
  return mergeLoaded([
    {
      rows: capped.rows.map(row => ({
        id: `log:${row.id}`,
        type: 'OPERATION' as const,
        occurredAt: row.occurredAt.toISOString(),
        title: `运营记录：${OPERATION_CATEGORY_LABEL[row.category as keyof typeof OPERATION_CATEGORY_LABEL] ?? '其他'}`,
        summary: row.text.slice(0, 500),
        link: entityDetailPath(target.objectType, target.objectId),
        actorId: row.authorId,
      })),
      overflow: capped.overflow,
    },
  ])
}

/** 对象事件表里属于某一类型的事件：已登记的种类按 EVENT_KIND_TYPE 归类，“其他”是其余全部。 */
export async function loadEntityEvents(ctx: LoadContext, type: EventType): Promise<{ rows: RawEvent[]; overflow: boolean }> {
  const { prisma, tenantId, target, window } = ctx
  const kindFilter = type === 'OTHER' ? { notIn: Object.keys(EVENT_KIND_TYPE) } : { in: eventKindsOf(type) }
  if (type !== 'OTHER' && eventKindsOf(type).length === 0) return { rows: [], overflow: false }
  const rows = await prisma.entityEvent.findMany({
    where: { tenantId, entityType: target.objectType, entityId: target.objectId, kind: kindFilter, occurredAt: { gte: window.from, lt: window.to } },
    select: { id: true, title: true, occurredAt: true, actorKind: true, actorId: true, detailJson: true },
    orderBy: newestFirst,
    take: FETCH_LIMIT,
  })
  const capped = capRows(rows)
  return {
    rows: capped.rows.map(row => ({
      id: `event:${row.id}`,
      type,
      occurredAt: row.occurredAt.toISOString(),
      title: row.title,
      summary: detailChange(row.detailJson),
      link: entityDetailPath(target.objectType, target.objectId),
      actorId: row.actorKind === 'USER' ? row.actorId : null,
      actorLabel: row.actorKind === 'AMAZON' ? '亚马逊' : '系统',
    })),
    overflow: capped.overflow,
  }
}

const priceSourceLabel = (source: unknown) =>
  typeof source === 'string' ? (PRICE_CHANGE_SOURCE_LABEL[source as keyof typeof PRICE_CHANGE_SOURCE_LABEL] ?? (source === 'RULE_SUGGESTION' ? '规则建议（人工确认）' : source)) : null

const priceOf = (requestJson: unknown): { price: number | null; previous: number | null; currency: string; source: unknown } => {
  const body = requestJson && typeof requestJson === 'object' && !Array.isArray(requestJson) ? (requestJson as Record<string, unknown>) : {}
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return { price: num(body.price), previous: num(body.previousPrice), currency: typeof body.currency === 'string' && body.currency ? body.currency : 'USD', source: body.source }
}

/** 价格：成功提交亚马逊的改价（改价复用刊登写入记录 PRICE_PATCH）加对象事件表里的改价事件。商品与库存按 SKU，店铺看全部 SKU；广告活动没有价格。 */
async function loadPriceRuns(ctx: LoadContext): Promise<{ rows: RawEvent[]; overflow: boolean }> {
  const { prisma, tenantId, target, window } = ctx
  if (!target.storeId || (target.objectType !== 'STORE' && !target.sku)) return { rows: [], overflow: false }
  const rows = await prisma.listingWriteRun.findMany({
    where: {
      tenantId,
      sellerAccountId: target.storeId,
      kind: 'PRICE_PATCH',
      status: 'SUCCEEDED',
      ...(target.objectType === 'STORE' ? {} : { sellerSku: target.sku }),
      createdAt: { gte: window.from, lt: window.to },
    },
    select: { id: true, sellerSku: true, requestJson: true, requestedBy: true, createdAt: true, finishedAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: FETCH_LIMIT,
  })
  const capped = capRows(rows)
  return {
    rows: capped.rows.map(row => {
      const body = priceOf(row.requestJson)
      const change = beforeAfterText(body.previous, body.price)
      return {
        id: `price:${row.id}`,
        type: 'PRICE' as const,
        occurredAt: (row.finishedAt ?? row.createdAt).toISOString(),
        title: `${row.sellerSku ? `${row.sellerSku}：` : ''}改价${change ? ` ${change}（${body.currency}）` : ''}`,
        summary: priceSourceLabel(body.source),
        link: row.sellerSku ? entityDetailPath('SKU', row.sellerSku) : null,
        actorId: row.requestedBy,
        actorLabel: row.requestedBy ? undefined : '系统',
      }
    }),
    overflow: capped.overflow,
  }
}

export async function loadPrice(ctx: LoadContext): Promise<Loaded> {
  const [runs, events] = await Promise.all([loadPriceRuns(ctx), loadEntityEvents(ctx, 'PRICE')])
  return mergeLoaded([runs, events])
}

/** 广告变更日志：广告活动按活动本身，店铺按它绑定的全部广告账户；商品与库存没有按商品记录的广告变更，只取对象事件表。 */
async function loadAdsLog(ctx: LoadContext): Promise<{ rows: RawEvent[]; overflow: boolean }> {
  const { prisma, tenantId, target, window } = ctx
  let scope: { adsProfileId: string | { in: string[] }; entityType?: string; entityId?: string } | null = null
  if (target.objectType === 'CAMPAIGN' && target.adsProfileId) scope = { adsProfileId: target.adsProfileId, entityType: 'CAMPAIGN', entityId: target.objectId }
  else if (target.objectType === 'STORE' && target.storeId) {
    const profiles = await prisma.adsProfile.findMany({ where: { tenantId, sellerAccountId: target.storeId }, select: { id: true }, take: 50 })
    if (profiles.length > 0) scope = { adsProfileId: { in: profiles.map(profile => profile.id) } }
  }
  if (!scope) return { rows: [], overflow: false }
  const rows = await prisma.adsChangeLog.findMany({
    where: { tenantId, ...scope, occurredAt: { gte: window.from, lt: window.to } },
    select: { id: true, entityType: true, entityId: true, entityLabel: true, changedField: true, beforeValue: true, afterValue: true, actorKind: true, actorId: true, occurredAt: true },
    orderBy: newestFirst,
    take: FETCH_LIMIT,
  })
  const capped = capRows(rows)
  return {
    rows: capped.rows.map(row => ({
      id: `ads:${row.id}`,
      type: 'ADS' as const,
      occurredAt: row.occurredAt.toISOString(),
      title: `${row.entityLabel ?? row.entityId}：${row.changedField}`,
      summary: beforeAfterText(row.beforeValue, row.afterValue),
      link: row.entityType === 'CAMPAIGN' ? entityDetailPath('CAMPAIGN', row.entityId) : null,
      actorId: row.actorId,
      actorLabel: row.actorKind === 'EXTERNAL' ? '广告后台（外部修改）' : '系统',
    })),
    overflow: capped.overflow,
  }
}

export async function loadAds(ctx: LoadContext): Promise<Loaded> {
  const [log, events] = await Promise.all([loadAdsLog(ctx), loadEntityEvents(ctx, 'ADS')])
  return mergeLoaded([log, events])
}
