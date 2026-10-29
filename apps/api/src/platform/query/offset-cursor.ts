import type { CursorPageInfo } from '@nova/api-contracts'
import { AppError } from '../http'
import { createCursorCodec, resolveCursorKey } from './cursor.service'

// 偏移游标（签名并绑定全部查询条件）：结果要先在内存里算出来再排序切页的列表用（跟卖、促销叠加）。条件变了旧游标就失效。

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

export function pageInfoAt(offset: number, count: number, total: number, pageSize: number, binding: string): CursorPageInfo {
  const end = offset + count
  const hasMore = end < total
  const nextCursor = hasMore ? cursorCodec().encode({ v: 1, b: binding, f: 'offset', r: 'asc', t: 'n', k: String(end), i: '' }) : null
  return { pageSize, nextCursor, hasMore, approxTotal: total }
}

export function pageOf<T>(items: readonly T[], offset: number, pageSize: number, binding: string): { page: T[]; pageInfo: CursorPageInfo } {
  const page = items.slice(offset, offset + pageSize)
  return { page, pageInfo: pageInfoAt(offset, page.length, items.length, pageSize, binding) }
}
