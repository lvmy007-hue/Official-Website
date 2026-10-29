import type { Response } from 'express'
import { once } from 'node:events'

// 流式导出（12.5 接口服务第 3 条）：导出一律边读边写，内存占用与导出行数无关。
// 调用方提供“按批读取”的异步迭代器（例如游标分页），本函数逐行写出并遵守背压（客户端读得慢就暂停读取）。

export type CsvCell = string | number | boolean | Date | null | undefined

/** 电子表格会把以这些字符开头的单元格当公式执行（CSV 注入）：加单引号前缀使其按文本显示。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : String(value)
  // 纯数字（含负数）不是公式，保持原样
  if (typeof value !== 'number' && FORMULA_PREFIX.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const csvLine = (cells: readonly CsvCell[]) => `${cells.map(csvCell).join(',')}\r\n`

export interface CsvExportOptions {
  filename: string
  header: readonly string[]
  rows: AsyncIterable<readonly CsvCell[]>
  /** 行数上限：超过即停止并在响应尾部追加说明行，避免无限导出占用连接。默认 1000 万行。 */
  maxRows?: number
}

/** 把行流写成 CSV 下载响应。返回实际写出的数据行数。 */
export async function streamCsv(response: Response, options: CsvExportOptions): Promise<number> {
  const { filename, header, rows, maxRows = 10_000_000 } = options
  response.status(200)
  response.setHeader('Content-Type', 'text/csv; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  response.setHeader('Cache-Control', 'no-store')
  let written = 0
  let truncated = false
  const write = async (text: string) => {
    if (!response.write(text)) await once(response, 'drain')
  }
  try {
    await write(`\uFEFF${csvLine(header)}`) // BOM：让电子表格按 UTF-8 打开中文
    for await (const row of rows) {
      if (written >= maxRows) {
        truncated = true
        break
      }
      await write(csvLine(row))
      written += 1
    }
    if (truncated) await write(csvLine([`导出已在 ${maxRows} 行处截断，请缩小筛选范围后分批导出`]))
  } finally {
    response.end()
  }
  return written
}

/** 把“按页取数”的函数变成逐行迭代器：一次只在内存里保留一页。fetchPage 返回空数组表示结束。 */
export async function* paginate<Row, Cursor>(fetchPage: (cursor: Cursor | undefined) => Promise<{ rows: Row[]; next?: Cursor }>): AsyncGenerator<Row> {
  let cursor: Cursor | undefined
  for (;;) {
    const page = await fetchPage(cursor)
    for (const row of page.rows) yield row
    if (page.next === undefined || page.rows.length === 0) return
    cursor = page.next
  }
}
