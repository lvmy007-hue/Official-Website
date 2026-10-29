import type { CursorPageInfo, ProfitSort } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'
import { marginOf, type Totals } from './profit-aggregate'

// 汇总结果的分页（P2b-10）：先在内存里按分组汇总、排序，再按位置切页。
// 汇总列表（按 ASIN、父体、SKU 的合计）没法用数据库的“排序字段 + 编号”游标，所以游标里放“已翻过的位置”，
// 仍然由服务端签名、绑定租户与全部查询条件（条件一变游标即失效，返回 400），和其他游标列表的行为一致。

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

/** 排序键：没有值（利润算不出、没有利润率）的排在最后，不管升降序。 */
export function sortValue(totals: Totals, sort: ProfitSort): number | null {
  switch (sort) {
    case 'revenue':
      return totals.revenue
    case 'profit':
      return totals.profit
    case 'margin':
      return marginOf(totals.profit, totals.revenue)
    case 'units':
      return totals.units
  }
}

export function sortRows<T extends { key: string; totals: Totals }>(rows: readonly T[], sort: { field: ProfitSort; dir: 'asc' | 'desc' }): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = sortValue(a.totals, sort.field)
    const right = sortValue(b.totals, sort.field)
    if (left === null || right === null) return left === right ? compare(a.key, b.key) : left === null ? 1 : -1
    return left === right ? compare(a.key, b.key) : (left - right) * sign
  })
}
// 排序别用 localeCompare：下划线与字母的先后随区域设置变
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
