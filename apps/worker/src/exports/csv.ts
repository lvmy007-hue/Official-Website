import { once } from 'node:events'
import type { Writable } from 'node:stream'

export type Cell = string | number | boolean | Date | null | undefined

/** 电子表格会把以这些字符开头的单元格当公式执行（CSV 注入）：加单引号前缀使其按文本显示；数字（含负数）不是公式。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : String(value)
  if (typeof value !== 'number' && FORMULA_PREFIX.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const csvLine = (cells: readonly Cell[]) => `${cells.map(csvCell).join(',')}\r\n`

/** 写入时遵守背压：目标写不动就暂停，等待排空。 */
export async function writeChunk(target: Writable, chunk: string | Buffer): Promise<void> {
  if (!target.write(chunk)) await once(target, 'drain')
}

/** 把行流写成 CSV（带 BOM，电子表格按 UTF-8 打开中文）；返回数据行数。不负责结束 target。 */
export async function writeCsv(target: Writable, header: readonly string[], rows: AsyncIterable<readonly Cell[]>): Promise<number> {
  await writeChunk(target, `\uFEFF${csvLine(header)}`)
  let written = 0
  for await (const row of rows) {
    await writeChunk(target, csvLine(row))
    written += 1
  }
  return written
}
