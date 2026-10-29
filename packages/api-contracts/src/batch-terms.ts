// 批量搜索词（P6-04，15 章第 7 节）：搜索框里一次粘贴多行，按“精确匹配”一次查多个编号。
// 本文件不引用 zod：前端筛选栏（懒加载页面里）与接口校验共用同一套拆分规则，两边拆出来的结果必须一致。
// 拆分规则：换行、制表符、逗号、分号（含全角）都是分隔符；每项去掉首尾空白，空项丢弃，重复项只留第一个（不区分大小写）。
// 取舍：词放在 GET 请求的 qs 参数里（逗号连接），所以总长度有上限（BATCH_MAX_CHARS，约等于反向代理允许的请求行长度减去其余参数）。

/** 一次最多查多少个词。 */
export const BATCH_MAX_ITEMS = 500
/** 每个词最长多少字符（订单号 19、ASIN 10、SKU 最长 80）。 */
export const BATCH_ITEM_MAX = 80
/** 用逗号连起来后的总长度上限；请求行再长会被反向代理拒绝（infrastructure/aliyun/nginx.conf 已放宽到 32k）。 */
export const BATCH_MAX_CHARS = 12000

const SEPARATORS = /[\r\n\t,;，；、]+/

export type BatchParse = {
  /** 去空、去重后的词（保持粘贴顺序）。 */
  items: string[]
  /** 因重复被丢掉的个数。 */
  duplicates: number
  /** 超过单项长度上限的词（不会进入 items）。 */
  tooLong: string[]
  /** 去重后的个数超过 BATCH_MAX_ITEMS，或连接后的总长度超过 BATCH_MAX_CHARS。 */
  overflow: boolean
}

export function parseBatchTerms(text: string): BatchParse {
  const seen = new Set<string>()
  const items: string[] = []
  const tooLong: string[] = []
  let duplicates = 0
  for (const piece of text.split(SEPARATORS)) {
    const term = piece.trim()
    if (term === '') continue
    if (term.length > BATCH_ITEM_MAX) {
      tooLong.push(term)
      continue
    }
    const key = term.toLowerCase()
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    items.push(term)
  }
  return { items, duplicates, tooLong, overflow: items.length > BATCH_MAX_ITEMS || joinBatchTerms(items).length > BATCH_MAX_CHARS }
}

/** 放进地址栏与请求的写法。 */
export const joinBatchTerms = (items: readonly string[]): string => items.join(',')

/** 接口侧：拆出词；不合规（太多、太长、含超长项）返回 null，由调用方给 422。 */
export function splitBatchTerms(text: string | undefined): string[] | null {
  if (text === undefined || text.trim() === '') return []
  const parsed = parseBatchTerms(text)
  return parsed.overflow || parsed.tooLong.length > 0 ? null : parsed.items
}

/** 批量词的校验提示（接口 422 与前端弹窗共用）；合规返回 null。 */
export function batchTermsIssue(text: string | undefined): string | null {
  if (text === undefined || text.trim() === '') return null
  const parsed = parseBatchTerms(text)
  if (parsed.tooLong.length > 0) return `有 ${parsed.tooLong.length} 个词超过 ${BATCH_ITEM_MAX} 个字符`
  if (parsed.overflow) return `批量搜索最多 ${BATCH_MAX_ITEMS} 个词、总长度不超过 ${BATCH_MAX_CHARS} 个字符`
  return null
}
