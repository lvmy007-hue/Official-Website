import { StreamLimitError } from './download'
import { MAX_JSON_ELEMENT_CHARS, type Row } from './rows'

// 顶层是对象、数据在其中一个数组字段里的 JSON 报告（品牌分析：{ reportSpecification, dataByAsin: [...] }）。
// jsonRows 会把整个顶层对象当成一条记录读入内存，体量大时（热门搜索词报告可达数百万行）不可用；这里只交出“数组元素”。

const OBJECT = 123 // {
const ARRAY = 91 // [

/**
 * 逐个交出数组元素（对象），其余内容（报告说明等）跳过：
 * - 顶层是数组：交出它的每个元素；
 * - 顶层是对象：交出它的“直接子数组”的每个元素（更深层的数组，例如元素里的列表，不拆开）。
 * 内存里只保留“当前正在拼接的那一个元素”；单个元素超过 MAX_JSON_ELEMENT_CHARS 以明确错误失败。
 */
export async function* jsonArrayRows(chunks: AsyncIterable<string>): AsyncGenerator<Row> {
  const stack: number[] = []
  let inString = false
  let escaped = false
  let collecting = false
  let parts: string[] = []
  let collected = 0
  let elementDepth = 0
  /** 当前位置正好是“数组元素”这一层：栈顶是数组，且这个数组是顶层、或是顶层对象的直接子数组。 */
  const atElementLevel = () => stack.length > 0 && stack[stack.length - 1] === ARRAY && (stack.length === 1 || (stack.length === 2 && stack[0] === OBJECT))
  for await (const chunk of chunks) {
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index)
      if (inString) {
        if (escaped) escaped = false
        else if (code === 92) escaped = true
        else if (code === 34) inString = false
        continue
      }
      if (code === 34) {
        inString = true
        continue
      }
      if (code === OBJECT || code === ARRAY) {
        if (!collecting && code === OBJECT && atElementLevel()) {
          collecting = true
          elementDepth = stack.length
          start = index
          parts = []
          collected = 0
        }
        stack.push(code)
      } else if (code === 125 || code === 93) {
        stack.pop()
        if (collecting && stack.length === elementDepth) {
          parts.push(chunk.slice(start, index + 1))
          const text = parts.join('')
          if (text.length > MAX_JSON_ELEMENT_CHARS) throw new StreamLimitError('STREAM_LINE_TOO_LONG', `单条 JSON 记录超过 ${MAX_JSON_ELEMENT_CHARS} 个字符，格式不符合预期`)
          collecting = false
          parts = []
          const value = JSON.parse(text) as unknown
          if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Row
        }
      }
    }
    if (collecting) {
      const piece = chunk.slice(start)
      collected += piece.length
      if (collected > MAX_JSON_ELEMENT_CHARS) throw new StreamLimitError('STREAM_LINE_TOO_LONG', `单条 JSON 记录超过 ${MAX_JSON_ELEMENT_CHARS} 个字符，格式不符合预期`)
      parts.push(piece)
    }
  }
  if (collecting) throw new Error('JSON_STREAM_TRUNCATED')
}
