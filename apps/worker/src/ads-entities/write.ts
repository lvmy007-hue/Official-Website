import type { PrismaClient } from '@prisma/client'
import { delegateOf, keyOf, scopeWhere, TABLES, type Scope, type TableName } from './tables'

// 广告实体的批量写库（P5-12A）：一批一次查已有行、一次批量新建、只更新真的变了的行（不是每行一次 upsert，也不是每次同步都改 syncedAt）。
// 值为 undefined 表示“这次接口没给”：新建行留空（必填列用占位），更新时保持原值。必须在租户上下文里调用（行级安全同时生效），且每个查询都显式带租户条件。

export type WriteRow = { key: string; values: Record<string, unknown>; remove?: boolean }
export type WriteResult = { created: number; updated: number; removed: number }

/** 不参与“有没有变”的比较：接口原文每次都可能有无关差异，只在别的字段变了时顺带刷新。 */
const NO_COMPARE = new Set(['raw'])

/** 数据库值与接口值的比较口径：空与未给等价；日期按时间戳；小数（Decimal）与数字按数值。 */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'object') return Number(String(value))
  return value
}

/** 与已有行相比真的变了的字段；没变返回 null。 */
export function changedValues(existing: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {}
  for (const [column, next] of Object.entries(values)) {
    if (next === undefined || NO_COMPARE.has(column)) continue
    if (normalize(existing[column]) !== normalize(next)) diff[column] = next
  }
  if (Object.keys(diff).length === 0) return null
  if (values.raw !== undefined) diff.raw = values.raw
  return diff
}

/** 必填列的占位：接口没给名称时用对象编号，没给状态时记 UNKNOWN（读取方当作“未知”，不当作启用）。 */
function createData(table: TableName, scope: Scope, key: string, values: Record<string, unknown>): Record<string, unknown> {
  const base = { tenantId: scope.tenantId, adsProfileId: scope.adsProfileId, adsAccountId: scope.adsAccountId, sourceUpdatedAt: scope.now, syncedAt: scope.now }
  const id = key.split('|')[0]
  switch (table) {
    case 'campaigns':
      return { ...base, ...values, name: values.name ?? id, state: values.state ?? 'UNKNOWN', currency: values.currency ?? scope.currency }
    case 'adGroups':
      return { ...base, ...values, name: values.name ?? id, state: values.state ?? 'UNKNOWN' }
    case 'portfolios':
      return { ...base, ...values, name: values.name ?? id, status: values.status ?? 'UNKNOWN', currency: values.currency ?? scope.currency }
    case 'negatives':
      return { ...base, ...values }
    default:
      return { ...base, ...values, state: values.state ?? 'UNKNOWN' }
  }
}

export async function upsertRows(db: PrismaClient, table: TableName, scope: Scope, rows: readonly WriteRow[]): Promise<WriteResult> {
  const result: WriteResult = { created: 0, updated: 0, removed: 0 }
  if (rows.length === 0) return result
  const delegate = delegateOf(db, table)
  const column = TABLES[table].keyCols[0]
  const ids = [...new Set(rows.map(row => row.key.split('|')[0]))]
  const found = await delegate.findMany({ where: { ...scopeWhere(table, scope), [column]: { in: ids } } })
  const existing = new Map(found.map(row => [keyOf(table, row), row]))
  const seen = new Set<string>()
  const creates: Array<Record<string, unknown>> = []
  const removeIds: string[] = []
  for (const row of rows) {
    if (seen.has(row.key)) continue // 同一批里重复出现的对象只处理第一次
    seen.add(row.key)
    const current = existing.get(row.key)
    if (row.remove) {
      if (current) removeIds.push(current.id)
      continue
    }
    if (!current) {
      creates.push(createData(table, scope, row.key, row.values))
      continue
    }
    const diff = changedValues(current, row.values)
    if (!diff) continue
    await delegate.update({ where: { id: current.id }, data: { ...diff, sourceUpdatedAt: scope.now, syncedAt: scope.now } })
    result.updated += 1
  }
  if (creates.length > 0) result.created = (await delegate.createMany({ data: creates, skipDuplicates: true })).count
  if (removeIds.length > 0) {
    await delegate.deleteMany({ where: { tenantId: scope.tenantId, id: { in: removeIds } } })
    result.removed = removeIds.length
  }
  return result
}
