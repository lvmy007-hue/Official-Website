import type { CursorPageInfo } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'

// 刊登表现的分页（P4-09）：流量、广告、库存数字是数据库汇总后在内存里排序的，没法用“排序字段 + 编号”游标，所以游标里放“已翻过的位置”，
// 仍由服务端签名、绑定租户与全部查询条件（条件一变游标即失效，返回 400）。做法与商品列表相同；模块之间只能经 index 引用，这里各留一份很小的实现。

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
