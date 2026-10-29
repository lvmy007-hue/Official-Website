import type { AdsCampaignChangeRow } from '@nova/api-contracts'
import { memberNames, nameOrFormer } from '../../platform/people'
import type { PrismaService } from '../../platform/prisma.service'

// 广告组与投放对象的本系统内变更记录（P3-08）：读 EntityEvent。当前没有写入方（修改默认竞价、暂停启用、调价随 P3-17），
// 所以多半是空的；P3-17 写入时用同样的 entityType、entityId 与 detailJson 格式，这里就会自动显示。

export const ENTITY_CHANGE_LIMIT = 200

export interface RawChange {
  id: string
  kind: string
  title: string
  occurredAt: Date
  actorKind: string
  actorId: string | null
  detailJson: unknown
}

export async function loadEntityEvents(
  prisma: PrismaService,
  tenantId: string,
  entityType: string,
  entityId: string,
  kind?: string,
  limit: number = ENTITY_CHANGE_LIMIT,
): Promise<{ events: RawChange[]; truncated: boolean }> {
  const rows = await prisma.entityEvent.findMany({
    where: { tenantId, entityType, entityId, ...(kind ? { kind } : {}) },
    select: { id: true, kind: true, title: true, occurredAt: true, actorKind: true, actorId: true, detailJson: true },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
  })
  return { events: rows.slice(0, limit), truncated: rows.length > limit }
}

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** 改前、改后的一句话：只读原始值里的数字、文字与布尔，不展示结构；没有为 null。 */
export function sideText(value: unknown): string | null {
  if (typeof value === 'string') return value || null
  const record = asRecord(value)
  if (!record) return null
  const parts = Object.entries(record)
    .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
    .slice(0, 6)
    .map(([key, item]) => `${key}：${String(item)}`)
  return parts.length ? parts.join('；') : null
}

export async function changeRows(prisma: PrismaService, tenantId: string, events: readonly RawChange[], kindLabels: Record<string, string>): Promise<AdsCampaignChangeRow[]> {
  const names = await memberNames(
    prisma,
    tenantId,
    events.map(event => event.actorId),
  )
  return events.map(event => {
    const detail = asRecord(event.detailJson)
    return {
      id: event.id,
      source: event.actorKind === 'USER' ? 'manual' : 'system',
      kindLabel: kindLabels[event.kind] ?? event.kind,
      title: event.title,
      occurredAt: event.occurredAt.toISOString(),
      actor: nameOrFormer(names, event.actorId),
      before: sideText(detail?.before),
      after: sideText(detail?.after),
    }
  })
}
