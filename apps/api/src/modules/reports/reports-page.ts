import type { CursorPageInfo } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'

// 报表中心列表的分页（P5-03）：列表合并了三个来源（亚马逊报告、广告报告、数据中心查询），没法用“排序字段 + 编号”游标，
// 所以游标里放“已翻过的位置”，仍由服务端签名、绑定租户与全部查询条件（条件一变游标即失效，返回 400）。做法与广告页、成本列表相同；模块之间只能经 index 引用，这里留一份很小的实现。

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

/** 当前页取了 count 条、读取窗口内一共 reachable 条可翻时的翻页信息；approxTotal 是范围内的真实总数。 */
export function pageInfoAt(offset: number, count: number, reachable: number, total: number, pageSize: number, binding: string): CursorPageInfo {
  const end = offset + count
  const hasMore = end < reachable
  const nextCursor = hasMore ? cursorCodec().encode({ v: 1, b: binding, f: 'offset', r: 'asc', t: 'n', k: String(end), i: '' }) : null
  return { pageSize, nextCursor, hasMore, approxTotal: total }
}
