import { ADS_WRITE_KIND_INFO, ADS_WRITE_KINDS, ADS_WRITE_LIMITS, adsWriteFailureText, type AdsWriteKind, type AdsWriteRunRow, type AdsWriteSource, type AdsWriteStatus } from '@nova/api-contracts'
import { switchSpecOf } from '@nova/api-contracts'
import type { IntegrationSwitchPort } from '../../platform/write'

// 广告写入的公共小件（P3-17）：从原始请求体里取出涉及的写入类型（权限要先于参数校验判断）、开关状态视图、写入记录行转换。

/** 原始请求体里出现的合法写入类型（不合法的忽略，留给参数校验报 422）。 */
export function kindsOf(rawBody: unknown): AdsWriteKind[] {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as { ops?: unknown; kind?: unknown }
  const items = Array.isArray(body.ops) ? body.ops : [body]
  const kinds = items
    .map(item => (item && typeof item === 'object' ? (item as { kind?: unknown }).kind : undefined))
    .filter((kind): kind is AdsWriteKind => (ADS_WRITE_KINDS as readonly unknown[]).includes(kind))
  return [...new Set(kinds)]
}

export const permissionsOfKinds = (kinds: readonly AdsWriteKind[]): string[] => [...new Set(kinds.map(kind => ADS_WRITE_KIND_INFO[kind].permission))]

export async function switchViews(switches: IntegrationSwitchPort, tenantId: string, keys: readonly string[]) {
  const unique = [...new Set(keys)]
  const views = []
  for (const key of unique) {
    const status = await switches.status(tenantId, key)
    views.push({ key, label: switchSpecOf(key)?.label ?? key, enabled: status.enabled, reason: status.enabled ? null : (status.reason ?? '该类写入的开关未开启') })
  }
  return views
}

export const RUN_SELECT = {
  id: true,
  kind: true,
  source: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  beforeValue: true,
  afterValue: true,
  status: true,
  failureCode: true,
  requestedBy: true,
  createdAt: true,
  finishedAt: true,
} as const

export interface RunRecord {
  id: string
  kind: string
  source: string
  entityType: string
  entityId: string
  entityLabel: string | null
  beforeValue: string | null
  afterValue: string
  status: string
  failureCode: string | null
  requestedBy: string | null
  createdAt: Date
  finishedAt: Date | null
}

export function runRowOf(record: RunRecord): AdsWriteRunRow {
  const kind = record.kind as AdsWriteKind
  return {
    id: record.id,
    kind,
    kindLabel: ADS_WRITE_KIND_INFO[kind]?.label ?? record.kind,
    source: record.source as AdsWriteSource,
    entityType: record.entityType,
    entityId: record.entityId,
    entityLabel: record.entityLabel,
    before: record.beforeValue,
    after: record.afterValue,
    status: record.status as AdsWriteStatus,
    failureCode: record.failureCode,
    failureText: record.status === 'FAILED' ? adsWriteFailureText(record.failureCode) : null,
    requestedBy: record.requestedBy,
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
  }
}

/** 两个值是否相同：金额按数值比，其余按文字（大小写不敏感）。 */
export function sameValue(before: string | null, after: string): boolean {
  if (before === null) return false
  const a = Number(before)
  const b = Number(after)
  if (before.trim() !== '' && after.trim() !== '' && Number.isFinite(a) && Number.isFinite(b)) return a === b
  return before.trim().toUpperCase() === after.trim().toUpperCase()
}

export const WRITE_MESSAGE_MAX = ADS_WRITE_LIMITS.messageMax
