import type { CursorPageInfo } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'

// A+ 内容列表的偏移游标（P4-14）：签名并绑定全部查询条件，条件变了或被篡改的游标一律 400（与评价、竞品、定价模块同一做法；模块之间只能经 index 引用，这里留一份很小的实现）。

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
