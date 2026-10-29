import { createHash } from 'node:crypto'
import {
  ADS_CHANGE_CREATED,
  ADS_CHANGE_LIMITS,
  changeStateFromJson,
  changeStateOf,
  clipChangeText,
  diffChangeStates,
  isOwnChange,
  type AdsChangeEntityType,
  type AdsChangeState,
  type OwnChange,
} from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ENTITY_LOADERS, type EntityRow } from './entities'

// 一个广告档案下一类对象的快照对比（P3-14，08 章 8.11）：读已同步的实体 → 规整成“字段 → 文字” → 与该对象最近一份快照比哈希 →
// 变了就存新快照，并把差异记成变更记录。
//  · 外部变更：差异里“改后的值”与本系统最近 24 小时写入的某条记录一致的，算本系统自己的写入，只更新快照、不记外部变更；
//  · 第一次拍快照是基线，什么都不记；之后出现的新对象记一条“新出现”，但第一次快照后的 24 小时内才进入本系统的对象算初始同步的一部分（同步器分批入库），不记；
//  · 对象从库里消失不处理（亚马逊上删除是“归档”状态，行还在）；只改本系统自己的数据（标签、负责人）不会引起任何记录；
//  · 每个对象最多留 30 份快照，超过 180 天的旧快照在被更新的快照取代后清理（最新一份总是保留）。
// 同一次扫描的快照时间与变更时间都是 `now`：外部变更的“发生时间”只能说在上一份快照与这一次之间（变更记录里的 sinceAt 与 occurredAt）。

const PAGE_SIZE = 1000
const OWN_ROW_LIMIT = 20_000
const DAY_MS = 86_400_000

export interface ProfileScan {
  entities: number
  snapshots: number
  changes: number
  created: number
  /** 因为与本系统自己的写入一致而没有记成外部变更的差异数。 */
  own: number
  pruned: number
}
export const emptyScan = (): ProfileScan => ({ entities: 0, snapshots: 0, changes: 0, created: 0, own: 0, pruned: 0 })

export const hashOfState = (state: AdsChangeState): string => createHash('sha256').update(JSON.stringify(state)).digest('hex')

export interface SnapshotRow {
  id: string
  entityId: string
  snapshotAt: Date
  hash: string
  stateJson: unknown
}

type SnapshotData = Prisma.AdsEntitySnapshotCreateManyInput
type ChangeData = Prisma.AdsChangeLogCreateManyInput

export interface ScanInput {
  tenantId: string
  adsProfileId: string
  entityType: AdsChangeEntityType
  now: Date
}

/** 这一页对象的全部快照，按对象分组（每组从新到旧）。 */
async function loadSnapshots(db: PrismaClient, input: ScanInput, ids: string[]): Promise<Map<string, SnapshotRow[]>> {
  const rows = await db.adsEntitySnapshot.findMany({
    where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, entityType: input.entityType, entityId: { in: ids } },
    select: { id: true, entityId: true, snapshotAt: true, hash: true, stateJson: true },
    orderBy: [{ snapshotAt: 'desc' }, { id: 'asc' }],
    take: ids.length * (ADS_CHANGE_LIMITS.snapshotKeepMax + 2),
  })
  const grouped = new Map<string, SnapshotRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.entityId)
    if (list) list.push(row)
    else grouped.set(row.entityId, [row])
  }
  return grouped
}

/** 本系统最近写入过的改动（手动、自动规则、分时策略），用来排除“自己改的”。 */
async function loadOwnChanges(db: PrismaClient, input: ScanInput, ids: string[]): Promise<OwnChange[]> {
  if (ids.length === 0) return []
  const rows = await db.adsChangeLog.findMany({
    where: {
      tenantId: input.tenantId,
      adsProfileId: input.adsProfileId,
      entityType: input.entityType,
      entityId: { in: ids },
      actorKind: { not: 'EXTERNAL' },
      occurredAt: { gte: new Date(input.now.getTime() - ADS_CHANGE_LIMITS.ownWriteLookbackMs) },
    },
    select: { entityId: true, changedField: true, afterValue: true },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
    take: OWN_ROW_LIMIT,
  })
  return rows.map(row => ({ entityId: row.entityId, field: row.changedField, after: row.afterValue }))
}

/** 被取代、又太旧（或超过每个对象的份数上限）的快照编号。list 是已有的快照（从新到旧），hasNew 表示这次还要新增一份（它排在最前面）。 */
export function prunable(list: readonly SnapshotRow[], hasNew: boolean, now: Date): string[] {
  const cutoff = now.getTime() - ADS_CHANGE_LIMITS.snapshotKeepDays * DAY_MS
  return list
    .filter((row, index) => {
      const position = index + (hasNew ? 1 : 0)
      return position > 0 && (row.snapshotAt.getTime() < cutoff || position >= ADS_CHANGE_LIMITS.snapshotKeepMax)
    })
    .map(row => row.id)
}

export interface PagePlan {
  snapshots: SnapshotData[]
  changes: ChangeData[]
  prune: string[]
  created: number
  own: number
}

export function planPage(input: ScanInput, rows: EntityRow[], snapshots: Map<string, SnapshotRow[]>, own: OwnChange[], baseline: { graceEnd: Date | null }): PagePlan {
  const { tenantId, adsProfileId, entityType, now } = input
  const plan: PagePlan = { snapshots: [], changes: [], prune: [], created: 0, own: 0 }
  for (const row of rows) {
    const state = changeStateOf(entityType, row.values)
    const hash = hashOfState(state)
    const history = snapshots.get(row.id) ?? []
    const previous = history[0]
    if (previous?.hash === hash) {
      plan.prune.push(...prunable(history, false, now))
      continue
    }
    const label = clipChangeText(row.label, ADS_CHANGE_LIMITS.labelMax)
    const base = { tenantId, adsProfileId, entityType, entityId: row.id, entityLabel: label, actorKind: 'EXTERNAL', occurredAt: now }
    plan.snapshots.push({ tenantId, adsProfileId, entityType, entityId: row.id, snapshotAt: now, stateJson: state as Prisma.InputJsonValue, hash })
    plan.prune.push(...prunable(history, true, now))
    if (!previous) {
      // 第一次拍快照是基线；之后才出现、且不在初始同步宽限期内的对象，记“新出现”
      if (baseline.graceEnd && row.createdAt.getTime() >= baseline.graceEnd.getTime()) {
        plan.changes.push({ ...base, changedField: ADS_CHANGE_CREATED, beforeValue: null, afterValue: label })
        plan.created += 1
      }
      continue
    }
    const sinceAt = previous.snapshotAt.getTime() <= now.getTime() ? previous.snapshotAt : now
    for (const diff of diffChangeStates(entityType, changeStateFromJson(entityType, previous.stateJson), state)) {
      if (isOwnChange(entityType, row.id, diff, own)) plan.own += 1
      else plan.changes.push({ ...base, changedField: diff.field, beforeValue: clipChangeText(diff.before), afterValue: clipChangeText(diff.after), sinceAt })
    }
  }
  return plan
}

/** 扫描一个广告档案下的一类对象，把快照与外部变更写进库，返回数量。 */
export async function scanProfileType(db: PrismaClient, input: ScanInput): Promise<ProfileScan> {
  const result = emptyScan()
  const first = await db.adsEntitySnapshot.findFirst({
    where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, entityType: input.entityType },
    select: { snapshotAt: true },
    orderBy: [{ snapshotAt: 'asc' }, { id: 'asc' }],
  })
  const baseline = { graceEnd: first ? new Date(first.snapshotAt.getTime() + ADS_CHANGE_LIMITS.baselineGraceMs) : null }
  let after: string | null = null
  for (;;) {
    const rows: EntityRow[] = await ENTITY_LOADERS[input.entityType](db, { tenantId: input.tenantId, adsProfileId: input.adsProfileId, after, take: PAGE_SIZE })
    if (rows.length === 0) break
    const ids = rows.map(row => row.id)
    const snapshots = await loadSnapshots(db, input, ids)
    // 先按“哈希变了的对象”粗筛，只有真有差异时才去读本系统的写入记录
    const changedIds = rows.filter(row => {
      const previous = snapshots.get(row.id)?.[0]
      return previous && previous.hash !== hashOfState(changeStateOf(input.entityType, row.values))
    })
    const own = await loadOwnChanges(
      db,
      input,
      changedIds.map(row => row.id),
    )
    const plan = planPage(input, rows, snapshots, own, baseline)
    if (plan.snapshots.length > 0 || plan.prune.length > 0) {
      await db.$transaction(async tx => {
        if (plan.snapshots.length > 0) await tx.adsEntitySnapshot.createMany({ data: plan.snapshots, skipDuplicates: true })
        if (plan.changes.length > 0) await tx.adsChangeLog.createMany({ data: plan.changes, skipDuplicates: true })
        if (plan.prune.length > 0) await tx.adsEntitySnapshot.deleteMany({ where: { tenantId: input.tenantId, id: { in: plan.prune } } })
      })
    }
    result.entities += rows.length
    result.snapshots += plan.snapshots.length
    result.changes += plan.changes.length
    result.created += plan.created
    result.own += plan.own
    result.pruned += plan.prune.length
    after = rows[rows.length - 1]!.id
    if (rows.length < PAGE_SIZE) break
  }
  return result
}
