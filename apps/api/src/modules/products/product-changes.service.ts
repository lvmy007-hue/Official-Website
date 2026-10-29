import { Injectable } from '@nestjs/common'
import { OPERATION_CATEGORY_LABEL, type Asin360Change, type Asin360ChangesResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ProductAccessService } from './product-access.service'

const LIMIT = 200
const ACTOR_LABEL: Record<string, string> = { SYSTEM: '系统', AMAZON: '亚马逊', USER: '成员' }
const EVENT_KIND_LABEL: Record<string, string> = {
  'price.change': '改价',
  'budget.change': '改预算',
  'listing.change': '商品信息变更',
  'variation.attribute_change': '变体属性变化',
  'inbound.confirm': '入库确认',
  'cost.change': '成本变更',
  alert: '预警',
  manual: '手工记录',
  workitem: '待办',
  'content.change': '内容变更',
  promotion: '促销',
  'product.meta': '负责人与标签',
}

/** 事件详情里变更前后的取值（只认字符串、数字与布尔，别的形状不展开）。 */
export function beforeAfter(detail: unknown): { before: string | null; after: string | null } {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return { before: null, after: null }
  const read = (value: unknown) => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null)
  const record = detail as Record<string, unknown>
  return { before: read(record.before), after: read(record.after) }
}

// 变更与审计页签：把这个商品的对象事件（系统内操作、亚马逊侧变更）与运营日志（手工记录）合成一条时间线，新的在前。
// 事件以商品行编号为对象；运营日志的范围是 ASIN、引用同一个编号。两处各取最近 200 条再合并，超出时标记截断。
@Injectable()
export class ProductChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async changes(req: RequestWithContext, id: string): Promise<Asin360ChangesResponse> {
    const { context, product } = await this.access.resolve(req, id)
    const [events, logs] = await Promise.all([
      this.prisma.entityEvent.findMany({
        where: { tenantId: context.tenantId, entityType: 'ASIN', entityId: product.id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: LIMIT + 1,
      }),
      this.prisma.operationLog.findMany({
        where: { tenantId: context.tenantId, scope: 'ASIN', scopeRef: product.id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: LIMIT + 1,
      }),
    ])
    const names = await memberNames(this.prisma, context.tenantId, [...events.slice(0, LIMIT).map(row => row.actorId), ...logs.slice(0, LIMIT).map(row => row.authorId)])
    const fromEvents: Asin360Change[] = events.slice(0, LIMIT).map(row => ({
      id: `event:${row.id}`,
      source: row.actorKind === 'AMAZON' ? 'amazon' : 'system',
      kind: row.kind,
      kindLabel: EVENT_KIND_LABEL[row.kind] ?? '其他变更',
      title: row.title,
      occurredAt: row.occurredAt.toISOString(),
      actor: row.actorKind === 'USER' ? nameOrFormer(names, row.actorId) : (ACTOR_LABEL[row.actorKind] ?? '系统'),
      ...beforeAfter(row.detailJson),
    }))
    const fromLogs: Asin360Change[] = logs.slice(0, LIMIT).map(row => ({
      id: `log:${row.id}`,
      source: 'manual',
      kind: `log.${row.category}`,
      kindLabel: OPERATION_CATEGORY_LABEL[row.category as keyof typeof OPERATION_CATEGORY_LABEL] ?? '其他',
      title: row.text,
      occurredAt: row.occurredAt.toISOString(),
      actor: nameOrFormer(names, row.authorId),
      before: null,
      after: null,
    }))
    const merged = [...fromEvents, ...fromLogs].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id < b.id ? 1 : -1))
    return { items: merged.slice(0, LIMIT), truncated: events.length > LIMIT || logs.length > LIMIT || merged.length > LIMIT }
  }
}
