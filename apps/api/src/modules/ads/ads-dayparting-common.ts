import type { Prisma } from '@prisma/client'
import {
  DAYPARTING_KINDS,
  DAYPARTING_LEVELS,
  DAYPARTING_STATUSES,
  daypartingDueOf,
  describeGrid,
  neutralGrid,
  type DaypartingKind,
  type DaypartingLevel,
  type DaypartingStatus,
  type DaypartingStrategyRow,
} from '@nova/api-contracts'
import { appError } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, type ResolvedScope } from '../auth'
import { num } from './ads-campaigns-common'

// 分时策略的公共部分（P3-12）：读取字段、行的组装、作用对象的解析与名称。策略是系统自己的数据，同步器从不写。

export const STRATEGY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const STRATEGY_SELECT = {
  id: true,
  adsProfileId: true,
  name: true,
  kind: true,
  targetLevel: true,
  scopeJson: true,
  hourlyMultipliersJson: true,
  baseBid: true,
  timezone: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: true,
  adsProfile: { select: { displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.DaypartingStrategySelect
export type StrategyRecord = Prisma.DaypartingStrategyGetPayload<{ select: typeof STRATEGY_SELECT }>

/** 作用对象的系统编号：库里是 { ids: [...] }，格式不对（不应出现）按没有对象处理。 */
export function targetIdsOf(json: unknown): string[] {
  const ids = (json as { ids?: unknown } | null)?.ids
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/** 168 格取值：库里有检查约束保证是 168 个元素的数组，元素不是数字（不应出现）按中性值 1 处理。 */
export function gridOfRecord(json: unknown): number[] {
  if (!Array.isArray(json)) return neutralGrid()
  return json.map(value => (typeof value === 'number' && Number.isFinite(value) ? value : 1))
}

// 库里有检查约束保证取值合法；落到兜底值说明数据被绕过约束改过，宁可按保守值处理也不让页面崩。
export const kindOf = (value: string): DaypartingKind => ((DAYPARTING_KINDS as readonly string[]).includes(value) ? (value as DaypartingKind) : 'ON_OFF')
export const levelOf = (value: string): DaypartingLevel => ((DAYPARTING_LEVELS as readonly string[]).includes(value) ? (value as DaypartingLevel) : 'CAMPAIGN')
export const statusOf = (value: string): DaypartingStatus => ((DAYPARTING_STATUSES as readonly string[]).includes(value) ? (value as DaypartingStatus) : 'PAUSED')

export interface TargetRef {
  level: DaypartingLevel
  ids: readonly string[]
}

/** 活动与广告组的名称；键是系统编号。已被同步删除的对象不在结果里。读取范围限制在给定的编号里，租户条件显式带上。 */
export async function targetNames(prisma: PrismaService, tenantId: string, refs: readonly TargetRef[]): Promise<Map<string, string>> {
  const idsOf = (level: DaypartingLevel) => [...new Set(refs.filter(ref => ref.level === level).flatMap(ref => ref.ids))]
  const campaignIds = idsOf('CAMPAIGN')
  const groupIds = idsOf('AD_GROUP')
  const [campaigns, groups] = await Promise.all([
    campaignIds.length === 0 ? [] : prisma.adsCampaign.findMany({ where: { tenantId, id: { in: campaignIds } }, select: { id: true, name: true }, orderBy: { id: 'asc' }, take: 5000 }),
    groupIds.length === 0 ? [] : prisma.adsAdGroup.findMany({ where: { tenantId, id: { in: groupIds } }, select: { id: true, name: true }, orderBy: { id: 'asc' }, take: 5000 }),
  ])
  return new Map([...campaigns, ...groups].map(row => [row.id, row.name]))
}

export interface ResolvedTarget {
  id: string
  name: string
  /** 小时指标里的对象编号：活动是外部活动编号，广告组是外部广告组编号。 */
  externalId: string
}

/** 在同一个广告档案下、数据范围内找作用对象；不存在的、别的档案的、范围外的都不会出现在结果里（不泄露存在性）。 */
export async function findTargets(prisma: PrismaService, tenantId: string, scope: ResolvedScope, adsProfileId: string, level: DaypartingLevel, ids: readonly string[]): Promise<ResolvedTarget[]> {
  if (ids.length === 0) return []
  const where = { tenantId, adsProfileId, id: { in: [...ids] }, ...adsRelationWhere(scope) }
  if (level === 'CAMPAIGN') {
    const rows = await prisma.adsCampaign.findMany({ where, select: { id: true, name: true, externalCampaignId: true }, orderBy: { id: 'asc' }, take: ids.length })
    return rows.map(row => ({ id: row.id, name: row.name, externalId: row.externalCampaignId }))
  }
  const rows = await prisma.adsAdGroup.findMany({ where, select: { id: true, name: true, adGroupId: true }, orderBy: { id: 'asc' }, take: ids.length })
  return rows.map(row => ({ id: row.id, name: row.name, externalId: row.adGroupId }))
}

/** 创建与修改时解析作用对象：有一个找不到整批拒绝，什么也不保存。 */
export async function resolveTargets(prisma: PrismaService, tenantId: string, scope: ResolvedScope, adsProfileId: string, level: DaypartingLevel, ids: readonly string[]): Promise<ResolvedTarget[]> {
  const found = await findTargets(prisma, tenantId, scope, adsProfileId, level, ids)
  if (found.length !== ids.length) throw appError('RESOURCE_NOT_FOUND', `有 ${ids.length - found.length} 个作用对象不存在、不属于所选广告账户或不在你的数据范围内，没有保存`)
  return found
}

export function strategyRowOf(record: StrategyRecord, names: ReadonlyMap<string, string>, people: ReadonlyMap<string, string>, now: Date): DaypartingStrategyRow {
  const kind = kindOf(record.kind)
  const grid = gridOfRecord(record.hourlyMultipliersJson)
  return {
    id: record.id,
    adsProfileId: record.adsProfileId,
    accountName: record.adsProfile.displayName ?? record.adsProfile.profileId,
    storeName: record.adsProfile.sellerAccount?.displayName ?? null,
    name: record.name,
    kind,
    level: levelOf(record.targetLevel),
    status: statusOf(record.status),
    timezone: record.timezone,
    baseBid: num(record.baseBid),
    targets: targetIdsOf(record.scopeJson).map(id => ({ id, name: names.get(id) ?? null })),
    grid,
    summary: describeGrid(kind, grid),
    due: daypartingDueOf(kind, grid, record.timezone, now),
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    updatedByName: nameOrFormer(people, record.updatedBy),
  }
}

/** 单个策略的完整行（创建与修改的返回）：补上对象名称与操作人姓名。 */
export async function strategyRowFor(prisma: PrismaService, tenantId: string, record: StrategyRecord, now: Date): Promise<DaypartingStrategyRow> {
  const [names, people] = await Promise.all([
    targetNames(prisma, tenantId, [{ level: levelOf(record.targetLevel), ids: targetIdsOf(record.scopeJson) }]),
    memberNames(prisma, tenantId, [record.updatedBy]),
  ])
  return strategyRowOf(record, names, people, now)
}
