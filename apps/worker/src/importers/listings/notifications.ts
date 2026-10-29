import type { NotificationEventRef, NotificationProcessor } from '../../platform/notification-events'
import { recordFreshness } from '../../freshness/record'
import { NtfSchemaError } from '../notifications/hourly-parse'
import { readJson, resolveSellerAccountId, type HourlyProcessorDeps } from '../notifications/hourly-write'
import { parseIssue } from './items-parse'

// 刊登相关的推送处理器（importers.md N-08、N-09、N-10、N-12，P4-10）。推送接收端按 14.10 暂缓：没有接收端就不会有事件进来，处理器先备好，
// 事件由重放接口或将来的接收端交给它们。字段名按官方文档整理（大小写与驼峰都容忍），未经真实推送验证（CR-085 未验证清单）：
//   N-09 LISTINGS_ITEM_ISSUES_CHANGE   payload 带 sku 与 issues（当前全部问题）→ 刊登问题整体对账（列出的写入或重开，没列出的未解决问题写解决时间）；
//   N-08 LISTINGS_ITEM_STATUS_CHANGE   payload 带 sku 与 status 数组 → 更新刊登当前状态（没有这个 SKU 的当前状态行就不写，等下一次同步建立）；
//   N-10 ITEM_PRODUCT_TYPE_CHANGE      payload 带 asin 与新商品类型 → 商品类型变更事件，并同步这个 ASIN 的刊登当前状态；
//   N-12 BRANDED_ITEM_CONTENT_CHANGE   payload 带 asin 与变更字段 → 内容变更事件；payload 带修改人的卖家编号时对照本店标注 SELF / OTHER，没有就是 UNKNOWN。
// N-11（商品类型定义变更）要刷新的商品类型定义缓存（I-12）本包没有实现，不注册处理器：事件会如实标记为 PROCESSOR_NOT_AVAILABLE。
// I-10 回读由每日同步承担，推送本身不再触发额外调用。

const US = 'ATVPDKIKX0DER'
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const pick = (row: Record<string, unknown>, ...names: string[]): unknown => {
  for (const name of names) if (row[name] !== undefined) return row[name]
  return undefined
}
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

interface Envelope {
  eventTime: Date
  payload: Record<string, unknown>
}
export function parseEnvelope(raw: unknown, expectedType: string): Envelope {
  const root = obj(raw)
  if (!root) throw new NtfSchemaError('通知根对象必须是对象')
  const type = text(root.notificationType)
  if (type !== expectedType) throw new NtfSchemaError(`期望 ${expectedType}，收到 ${type || '空'}`)
  const eventTime = new Date(text(root.eventTime))
  if (Number.isNaN(eventTime.getTime())) throw new NtfSchemaError('eventTime 不是合法时间')
  const payload = obj(root.payload)
  if (!payload) throw new NtfSchemaError('payload 必须是对象')
  const inner = obj(pick(payload, 'listingsItemIssuesChange', 'listingsItemStatusChange', 'itemProductTypeChange', 'brandedItemContentChange', 'ListingsItemIssuesChange')) ?? payload
  return { eventTime, payload: inner }
}

const marketOf = (payload: Record<string, unknown>) => text(pick(payload, 'marketplaceId', 'MarketplaceId')) || US

interface Scoped {
  event: NotificationEventRef
  sellerAccountId: string
  eventTime: Date
  payload: Record<string, unknown>
}
async function scopedOf(deps: HourlyProcessorDeps, event: NotificationEventRef, expectedType: string): Promise<Scoped | null> {
  const { eventTime, payload } = parseEnvelope(await readJson(deps.storage, event.payloadObjectKey), expectedType)
  if (marketOf(payload) !== US) return null // 只做美国站
  const sellerAccountId = await resolveSellerAccountId(deps.db, event.tenantId, event.sellerAccountId, [text(pick(payload, 'sellerId', 'SellerId'))])
  return sellerAccountId ? { event, sellerAccountId, eventTime, payload } : null
}

async function fresh(deps: HourlyProcessorDeps, scope: Scoped, sourceKey: string) {
  await recordFreshness(deps.db, { tenantId: scope.event.tenantId, sellerAccountId: scope.sellerAccountId, sourceKey, ok: true, rowCount: 1, dataThrough: scope.eventTime })
}

export function createIssuesProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async event => {
    const scope = await scopedOf(deps, event, 'LISTINGS_ITEM_ISSUES_CHANGE')
    if (!scope) return
    const sku = text(pick(scope.payload, 'sku', 'Sku'))
    const issuesRaw = pick(scope.payload, 'issues', 'Issues')
    if (!sku || !Array.isArray(issuesRaw)) throw new NtfSchemaError('问题变更缺少 sku 或 issues')
    const { db } = deps
    const tenantId = event.tenantId
    const now = new Date()
    const asin = text(pick(scope.payload, 'asin', 'Asin')).toUpperCase()
    const parsed = new Map(issuesRaw.flatMap(item => (parseIssue(item) ? [parseIssue(item)!] : [])).map(issue => [`${issue.code}|${issue.attributeName}`, issue]))
    const rows = await db.listingIssue.findMany({ where: { sellerAccountId: scope.sellerAccountId, sellerSku: sku, issueKind: 'ISSUE' } })
    const byKey = new Map(rows.map(row => [`${row.issueCode}|${row.attributeName}`, row]))
    for (const [key, issue] of parsed) {
      const row = byKey.get(key)
      const fields = { asin, category: issue.category, severity: issue.severity, impact: issue.impact, message: issue.message, lastSeenAt: now }
      if (!row)
        await db.listingIssue.create({
          data: {
            tenantId,
            sellerAccountId: scope.sellerAccountId,
            sellerSku: sku,
            issueKind: 'ISSUE',
            issueCode: issue.code,
            attributeName: issue.attributeName,
            firstSeenAt: scope.eventTime,
            ...fields,
          },
        })
      else if (row.resolvedAt)
        await db.listingIssue.update({ where: { id: row.id }, data: { ...fields, firstSeenAt: now, resolvedAt: null, handlingStatus: 'OPEN', handlingRunId: null, version: { increment: 1 } } })
      else await db.listingIssue.update({ where: { id: row.id }, data: fields })
    }
    const gone = rows.filter(row => !row.resolvedAt && !parsed.has(`${row.issueCode}|${row.attributeName}`)).map(row => row.id)
    if (gone.length > 0) await db.listingIssue.updateMany({ where: { id: { in: gone } }, data: { resolvedAt: now } })
    await fresh(deps, scope, 'ntf.listings-issues')
  }
}

export function createStatusProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async event => {
    const scope = await scopedOf(deps, event, 'LISTINGS_ITEM_STATUS_CHANGE')
    if (!scope) return
    const sku = text(pick(scope.payload, 'sku', 'Sku'))
    const statuses = pick(scope.payload, 'status', 'Status')
    if (!sku || !Array.isArray(statuses)) throw new NtfSchemaError('状态变更缺少 sku 或 status')
    const list = statuses.map(text).filter(Boolean)
    const where = { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId: scope.sellerAccountId, marketplaceId: US, sellerSku: sku } }
    const before = await deps.db.listingSnapshot.findUnique({ where })
    const status = list.includes('BUYABLE') ? 'ACTIVE' : 'INACTIVE'
    if (before) await deps.db.listingSnapshot.update({ where, data: { status, amazonStatuses: list, syncedAt: new Date(), ...(before.status !== status ? { statusSince: scope.eventTime } : {}) } })
    await fresh(deps, scope, 'ntf.listings-status')
  }
}

export function createProductTypeProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async event => {
    const scope = await scopedOf(deps, event, 'ITEM_PRODUCT_TYPE_CHANGE')
    if (!scope) return
    const asin = text(pick(scope.payload, 'asin', 'Asin')).toUpperCase()
    const after = text(pick(scope.payload, 'productType', 'ProductType', 'newProductType'))
    if (!asin || !after) throw new NtfSchemaError('商品类型变更缺少 asin 或 productType')
    const before = text(pick(scope.payload, 'previousProductType', 'PreviousProductType', 'oldProductType')) || null
    await deps.db.listingChangeEvent.createMany({
      data: [
        {
          tenantId: event.tenantId,
          sellerAccountId: scope.sellerAccountId,
          asin,
          changeKind: 'PRODUCT_TYPE_CHANGE',
          beforeText: before,
          afterText: after,
          actorKind: 'UNKNOWN',
          occurredAt: scope.eventTime,
          sourceRef: `ntf:${event.id}`,
        },
      ],
      skipDuplicates: true,
    })
    await deps.db.listingSnapshot.updateMany({ where: { sellerAccountId: scope.sellerAccountId, asin }, data: { productType: after } })
    await fresh(deps, scope, 'ntf.item-product-type')
  }
}

export function createBrandedContentProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async event => {
    const scope = await scopedOf(deps, event, 'BRANDED_ITEM_CONTENT_CHANGE')
    if (!scope) return
    const asin = text(pick(scope.payload, 'asin', 'Asin')).toUpperCase()
    if (!asin) throw new NtfSchemaError('内容变更缺少 asin')
    const field = text(pick(scope.payload, 'fieldPath', 'attributeName', 'attribute', 'changedAttribute')) || 'content'
    const editor = text(pick(scope.payload, 'modifiedBySellerId', 'updatedBySellerId', 'lastModifiedBy'))
    const own = editor ? await deps.db.sellerAccount.findFirst({ where: { id: scope.sellerAccountId, tenantId: event.tenantId }, select: { sellerId: true } }) : null
    const actorKind = !editor || !own ? 'UNKNOWN' : own.sellerId === editor ? 'SELF' : 'OTHER'
    await deps.db.listingChangeEvent.createMany({
      data: [
        {
          tenantId: event.tenantId,
          sellerAccountId: scope.sellerAccountId,
          asin,
          changeKind: 'CONTENT_CHANGE',
          fieldPath: field.slice(0, 120),
          actorKind,
          occurredAt: scope.eventTime,
          sourceRef: `ntf:${event.id}`,
        },
      ],
      skipDuplicates: true,
    })
    await fresh(deps, scope, 'ntf.branded-content')
  }
}

export function registerListingProcessors(registry: { register(type: string, processor: NotificationProcessor): unknown }, deps: HourlyProcessorDeps) {
  registry.register('LISTINGS_ITEM_ISSUES_CHANGE', createIssuesProcessor(deps))
  registry.register('LISTINGS_ITEM_STATUS_CHANGE', createStatusProcessor(deps))
  registry.register('ITEM_PRODUCT_TYPE_CHANGE', createProductTypeProcessor(deps))
  registry.register('BRANDED_ITEM_CONTENT_CHANGE', createBrandedContentProcessor(deps))
}
