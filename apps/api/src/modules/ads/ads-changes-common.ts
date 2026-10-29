import type { Prisma } from '@prisma/client'
import {
  ADS_CHANGE_CREATED,
  ADS_CHANGE_ENTITY_TYPES,
  ADS_CHANGE_SOURCES,
  adsChangePath,
  changeFieldLabel,
  changeValueText,
  type AdsChangeEntityType,
  type AdsChangeRow,
  type AdsChangeSource,
} from '@nova/api-contracts'
import { nameOrFormer } from '../../platform/people'

// 广告变更记录的公共部分（P3-14）：读取字段与行转换。变更记录由 worker（外部变更）与广告写入（手动、自动规则、分时策略，随 P3-17）写入，这里只读。

export const CHANGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const CHANGE_SELECT = {
  id: true,
  adsProfileId: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  changedField: true,
  beforeValue: true,
  afterValue: true,
  actorKind: true,
  actorId: true,
  occurredAt: true,
  sinceAt: true,
  writeRunId: true,
  adsProfile: { select: { displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.AdsChangeLogSelect
export type ChangeRecord = Prisma.AdsChangeLogGetPayload<{ select: typeof CHANGE_SELECT }>

// 库里有检查约束保证枚举合法；落到兜底值说明数据被绕过约束改过，宁可按保守值处理也不让页面崩。
const pick = <T extends string>(list: readonly T[], value: string, fallback: T): T => ((list as readonly string[]).includes(value) ? (value as T) : fallback)
export const changeSourceOf = (value: string): AdsChangeSource => pick(ADS_CHANGE_SOURCES, value, 'EXTERNAL')
export const changeEntityTypeOf = (value: string): AdsChangeEntityType => pick(ADS_CHANGE_ENTITY_TYPES, value, 'CAMPAIGN')

export function changeRowOf(record: ChangeRecord, people: ReadonlyMap<string, string>): AdsChangeRow {
  const entityType = changeEntityTypeOf(record.entityType)
  const created = record.changedField === ADS_CHANGE_CREATED
  const source = changeSourceOf(record.actorKind)
  return {
    id: record.id,
    source,
    entityType,
    entityId: record.entityId,
    entityLabel: record.entityLabel,
    field: record.changedField,
    fieldLabel: changeFieldLabel(entityType, record.changedField),
    before: created ? null : changeValueText(entityType, record.changedField, record.beforeValue),
    after: created ? record.afterValue : changeValueText(entityType, record.changedField, record.afterValue),
    occurredAt: record.occurredAt.toISOString(),
    sinceAt: record.sinceAt?.toISOString() ?? null,
    actorName: source === 'MANUAL' && record.actorId ? nameOrFormer(people, record.actorId) : null,
    accountName: record.adsProfile.displayName ?? record.adsProfile.profileId,
    storeName: record.adsProfile.sellerAccount?.displayName ?? null,
    writeRunId: record.writeRunId,
    path: adsChangePath(entityType, record.entityId),
  }
}
