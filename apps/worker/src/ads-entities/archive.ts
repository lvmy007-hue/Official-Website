import { ADS_ARCHIVED_STATE, adsArchiveDecision, type AdsArchiveSkip } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { delegateOf, keyOf, scopeWhere, TABLES, type Scope, type TableName } from './tables'

// 完整读完一类对象之后，把“这次没出现”的本地行归档（P5-12A）。亚马逊不删除广告对象，只归档，所以本地也只改状态，不删行（没有状态列的否定投放除外，只能删本地副本）。
// 三道保护（判断在 api-contracts 的 adsArchiveDecision，纯函数有单测）：翻页没翻完不归档；一条都没读到而库里有行（多半是接口返回为空）不归档；一次要归档超过一半（至少 20 行）不归档。
// 被保护住的情况写进同步结果（archiveSkipped），不静默。

export const ARCHIVE_ROW_LIMIT = 50_000
const CHUNK = 1000

export type ArchiveOutcome = { archived: number; skipped: AdsArchiveSkip | null }

export async function archiveUnseen(db: PrismaClient, table: TableName, scope: Scope, seen: ReadonlySet<string>, complete: boolean): Promise<ArchiveOutcome> {
  if (!complete) return { archived: 0, skipped: 'INCOMPLETE' }
  const config = TABLES[table]
  const delegate = delegateOf(db, table)
  const where = { ...scopeWhere(table, scope), ...(config.stateCol ? { [config.stateCol]: { not: ADS_ARCHIVED_STATE } } : {}) }
  const active = await delegate.count({ where })
  if (active === 0) return { archived: 0, skipped: null }
  const select = Object.fromEntries(['id', ...config.keyCols].map(column => [column, true as const]))
  const rows = await delegate.findMany({ where, select, orderBy: { id: 'asc' }, take: ARCHIVE_ROW_LIMIT })
  // 读到但没能映射的对象（缺广告产品、缺表达式）只登记了亚马逊编号：它们存在，不能当作“没出现”而归档
  const stale = rows.filter(row => !seen.has(keyOf(table, row)) && !seen.has(String(row[config.keyCols[0]] ?? '')))
  const verdict = adsArchiveDecision({ complete, read: seen.size, active, stale: stale.length })
  if (!verdict.archive) return { archived: 0, skipped: verdict.reason }
  for (let index = 0; index < stale.length; index += CHUNK) {
    const ids = stale.slice(index, index + CHUNK).map(row => row.id)
    const idWhere = { tenantId: scope.tenantId, id: { in: ids } }
    if (config.stateCol) await delegate.updateMany({ where: idWhere, data: { [config.stateCol]: ADS_ARCHIVED_STATE, sourceUpdatedAt: scope.now } })
    else await delegate.deleteMany({ where: idWhere })
  }
  return { archived: stale.length, skipped: null }
}
