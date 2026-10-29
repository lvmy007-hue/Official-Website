import { StringDecoder } from 'node:string_decoder'
import { StreamLimitError } from './download'

// 逐行、逐条解析（12.5）：一次只在内存里保留一行（一条），与文件大小无关。

export type Row = Record<string, unknown>

/** 单行最大字符数：超过说明文件不是预期的行式格式，直接报错，避免一行吃掉全部内存。 */
export const MAX_LINE_CHARS = 1_000_000

/** 字节流（或字符串流）→ 逐行。正确处理多字节字符被拆在两个分段之间、CRLF、文件开头的 BOM、末尾没有换行。 */
export async function* readLines(source: AsyncIterable<Buffer | string>, maxLineChars = MAX_LINE_CHARS): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let rest = ''
  let first = true
  const clean = (line: string) => {
    let value = line.endsWith('\r') ? line.slice(0, -1) : line
    if (first) {
      first = false
      if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
    }
    return value
  }
  for await (const chunk of source) {
    rest += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let from = 0
    for (let index = rest.indexOf('\n', from); index !== -1; index = rest.indexOf('\n', from)) {
      yield clean(rest.slice(from, index))
      from = index + 1
    }
    rest = from > 0 ? rest.slice(from) : rest
    if (rest.length > maxLineChars) throw new StreamLimitError('STREAM_LINE_TOO_LONG', `单行超过 ${maxLineChars} 个字符，文件格式不符合预期`)
  }
  rest += decoder.end()
  if (rest.length > 0) yield clean(rest)
}

/** 制表符分隔的报告（亚马逊的平面文件报告）：第一行是表头，之后每行一条记录；空行跳过。 */
export async function* tsvRows(lines: AsyncIterable<string>): AsyncGenerator<Row> {
  let headers: string[] | null = null
  for await (const line of lines) {
    if (line.trim().length === 0) continue
    if (!headers) {
      headers = line.split('\t').map(item => item.trim())
      continue
    }
    const values = line.split('\t')
    const row: Row = {}
    for (let index = 0; index < headers.length; index += 1) row[headers[index]] = values[index] ?? ''
    yield row
  }
}

/** 字节流 → 字符串流（保持多字节字符完整）。 */
export async function* decodeUtf8(source: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  for await (const chunk of source) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (text) yield text
  }
  const tail = decoder.end()
  if (tail) yield tail
}

/** 单条记录最大字符数（JSON）。 */
export const MAX_JSON_ELEMENT_CHARS = 5_000_000

/**
 * JSON 数组或逐行 JSON（NDJSON）→ 逐条记录。不会把整个数组读入内存：
 * 只在内存里保留“当前正在拼接的那一条”，遇到条目结束立即交出。
 * 兼容 `{ "rows": [...] }` 这种包装（此时整个包装对象作为一条读入，仅用于小体量的非标准返回）。
 */
export async function* jsonRows(chunks: AsyncIterable<string>): AsyncGenerator<Row> {
  let depth = 0
  let base = -1 // 记录所在的嵌套深度：顶层是数组为 1，顶层是连续的对象（NDJSON）为 0
  let inString = false
  let escaped = false
  let collecting = false
  let parts: string[] = []
  let collected = 0
  const emit = (text: string): Row[] => {
    const value = JSON.parse(text) as Row
    return Array.isArray(value.rows) ? (value.rows as unknown[]).filter((item): item is Row => !!item && typeof item === 'object') : [value]
  }
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
      if (code === 123 || code === 91) {
        // { [
        if (base < 0) {
          base = code === 91 ? 1 : 0
          if (code === 91) {
            depth = 1
            continue
          }
        }
        if (depth === base && code === 123) {
          collecting = true
          start = index
          parts = []
          collected = 0
        }
        depth += 1
      } else if (code === 125 || code === 93) {
        // } ]
        depth -= 1
        if (collecting && depth === base) {
          parts.push(chunk.slice(start, index + 1))
          const text = parts.join('')
          collecting = false
          parts = []
          for (const row of emit(text)) yield row
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
