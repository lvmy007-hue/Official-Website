import type { CursorPageInfo } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'

// 同步任务列表的分页（P5-06）：游标里放“已翻过的位置”，由服务端签名并绑定租户与全部查询条件（条件一变游标即失效，返回 400）。
// 同步任务只有一张表，本可以用“排序字段 + 编号”游标；这里与报表中心保持同一种做法，前端的翻页逻辑共用。模块之间只能经 index 引用，所以留一份很小的实现。

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
