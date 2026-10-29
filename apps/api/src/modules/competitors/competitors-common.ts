import type { CursorPageInfo } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'
import { storeWhere, type ResolvedScope } from '../auth'

// 竞品监控模块的公共部分（P4-12）：偏移游标（签名并绑定全部条件，与定价模块同一做法；模块之间只能经 index 引用，这里各留一份很小的实现）、可见店铺、取数小工具。

let codec: ReturnType<typeof createCursorCodec> | undefined
const cursorCodec = () => (codec ??= createCursorCodec(resolveCursorKey()))
const invalid = () => new AppError(400, 'CURSOR_INVALID', '翻页游标无效或查询条件已变化，请从第一页重新加载')

export function decodeOffset(token: string | undefined, binding: string): number {
  if (!token) return 0
  const payload = cursorCodec().decode(token)
  const offset = Number(payload.k)
  if (payload.b !== binding || payload.f !== 'offset' || !Number.isInteger(offset) || offset < 0) throw invalid()
  return offset
}

export function pageOf<T>(items: readonly T[], offset: number, pageSize: number, binding: string): { page: T[]; pageInfo: CursorPageInfo } {
  const page = items.slice(offset, offset + pageSize)
  const end = offset + page.length
  const hasMore = end < items.length
  const nextCursor = hasMore ? cursorCodec().encode({ v: 1, b: binding, f: 'offset', r: 'asc', t: 'n', k: String(end), i: '' }) : null
  return { page, pageInfo: { pageSize, nextCursor, hasMore, approxTotal: items.length } }
}

export async function storesOf(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...storeWhere(scope, 'id') },
    select: { id: true, displayName: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName }))
}

export const SEP = '\u001f'
export const keyOf = (storeId: string, value: string) => `${storeId}${SEP}${value}`
export const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
export const ymd = (date: Date): string => date.toISOString().slice(0, 10)
export const asDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

/** 每个键只留最先出现的一行（输入需按时间倒序）。 */
export function firstBy<T>(rows: readonly T[], keyFn: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) if (!map.has(keyFn(row))) map.set(keyFn(row), row)
  return map
}

export const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
