import { Injectable } from '@nestjs/common'
import { ENTITY_READ_PERMISSION, EVENT_TYPE_PERMISSION, EVENT_TYPES, EventsQuerySchema, type EventItem, type EventType, type EventsResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { EntityAccessService } from '../collab'
import { localDate, validZone } from '../overview'
import { loadAds, loadEntityEvents, loadOperation, loadPrice } from './events-sources'
import { loadAlerts, loadAudit, loadListing, loadOther } from './events-sources-more'
import { genericTarget, isScopedObjectType, resolveScopedTarget } from './events-target'
import type { LoadContext, Loaded, RawEvent } from './events-types'
import { mergeLoaded } from './events-types'
import { resolveWindow } from './events-window'

const LOADERS: Readonly<Record<EventType, (ctx: LoadContext) => Promise<Loaded>>> = {
  OPERATION: loadOperation,
  PRICE: loadPrice,
  ADS: loadAds,
  ALERT: loadAlerts,
  LISTING: loadListing,
  AUDIT: loadAudit,
  OTHER: loadOther,
}

/** 不是店铺、商品、库存、广告活动的对象（待办、采购单、入仓计划……）只有对象事件表一个来源，按事件种类归类。 */
async function loadGeneric(ctx: LoadContext, type: EventType): Promise<Loaded> {
  if (type === 'OPERATION' || type === 'AUDIT') return { items: [], truncated: false }
  const events = await loadEntityEvents(ctx, type)
  return mergeLoaded([events])
}

// 统一事件接口（P6-06，15 章第 9 节）：把运营日志、对象事件、预警、价格与 Listing 变更、广告变更、业务写操作的审计
// 合并成按对象与时间段查询的事件流，给图表事件带和对象详情用。
// 权限分两层：先要能读这个对象（随对象读权限与数据范围），再逐类按各自模块的读权限过滤（permissions.md 10.2），
// 没有权限的类型不报错，列在 unavailableTypes 里；每类最多 200 条，超出标记截断。
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly access: EntityAccessService,
  ) {}

  async list(req: RequestWithContext, rawQuery: unknown): Promise<EventsResponse> {
    // 读对象需要什么权限取决于 objectType：先按它鉴权，再解析其余参数（对象类型本身不合法才先报 422）
    const peek = (rawQuery as Record<string, unknown> | null)?.objectType
    const permission = typeof peek === 'string' ? ENTITY_READ_PERMISSION[peek] : undefined
    const { context, scope } = permission ? await this.context.authorizeScoped(req, permission, {}) : await this.context.resolveScoped(req, {})
    const query = EventsQuerySchema.parse(rawQuery)

    const target = isScopedObjectType(query.objectType)
      ? await resolveScopedTarget(this.prisma, context, scope, query.objectType, query.objectId)
      : await this.genericTarget(context, query.objectType, query.objectId)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const window = resolveWindow(query, zone, new Date())

    const wanted: readonly EventType[] = query.types ?? EVENT_TYPES
    const allowed = wanted.filter(type => EVENT_TYPE_PERMISSION[type] === null || hasPermission(context.permissions, EVENT_TYPE_PERMISSION[type]!))
    const unavailableTypes = wanted.filter(type => !allowed.includes(type))
    const ctx: LoadContext = { prisma: this.prisma, tenantId: context.tenantId, target, window }
    const generic = !isScopedObjectType(query.objectType)
    const loaded = await Promise.all(allowed.map(async type => ({ type, ...(await (generic ? loadGeneric(ctx, type) : LOADERS[type](ctx))) })))

    const raw: RawEvent[] = loaded.flatMap(part => part.items)
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      raw.map(event => event.actorId),
    )
    const items: EventItem[] = raw
      .map(event => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        day: localDate(new Date(event.occurredAt), zone),
        title: event.title,
        summary: event.summary,
        link: event.link,
        actor: event.actorId ? nameOrFormer(names, event.actorId) : (event.actorLabel ?? '系统'),
      }))
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id < b.id ? -1 : 1))
    const truncatedTypes = loaded.filter(part => part.truncated).map(part => part.type)
    return { items, truncated: truncatedTypes.length > 0, truncatedTypes, unavailableTypes }
  }

  private async genericTarget(context: Parameters<EntityAccessService['assertReadable']>[0], objectType: string, objectId: string) {
    await this.access.assertReadable(context, objectType, objectId)
    return genericTarget(objectType, objectId)
  }
}
