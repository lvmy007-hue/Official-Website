import { rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { LabelError } from './errors'
import { wrapText } from './pdf-fonts'

// 标签文字排版：把若干行文字放进一块区域，按字号从大到小试，放不下再缩小，缩到最小仍放不下就不勉强。

export interface Layout {
  size: number
  /** 每个输入行折成的若干行。 */
  wrapped: string[][]
  lineHeight: number
  height: number
}

export interface LayoutOptions {
  /** 字号候选，从大到小。 */
  sizes: readonly number[]
  /** 单个输入行最多折成几行。 */
  maxLinesEach: number
  /** 行距倍数。 */
  leading?: number
}

/** 尝试排版；任何字号都放不下返回 null。 */
export function layoutLines(lines: readonly string[], font: PDFFont, width: number, height: number, options: LayoutOptions): Layout | null {
  const leading = options.leading ?? 1.25
  for (const size of options.sizes) {
    const wrapped: string[][] = []
    let fits = true
    for (const line of lines) {
      const rows = wrapText(line, font, size, width, options.maxLinesEach)
      if (!rows) {
        fits = false
        break
      }
      wrapped.push(rows)
    }
    if (!fits) continue
    const lineHeight = size * leading
    const total = wrapped.reduce((sum, rows) => sum + rows.length, 0) * lineHeight
    if (total <= height) return { size, wrapped, lineHeight, height: total }
  }
  return null
}

/** 把排好的文字从 (x, top) 往下画。 */
export function drawLayout(page: PDFPage, layout: Layout, font: PDFFont, x: number, top: number) {
  let y = top - layout.size
  for (const rows of layout.wrapped) {
    for (const row of rows) {
      page.drawText(row, { x, y, size: layout.size, font, color: rgb(0, 0, 0) })
      y -= layout.lineHeight
    }
  }
}

/** 一行放得下优先（不折行、字号不小于 9），放不下再允许折行并缩小字号。 */
const PREFERRED_MIN_SIZE = 9

/** 附页、任务页这类“一定要放下”的区域：放不下就报错（不静默截断文字）。 */
export function mustLayout(lines: readonly string[], font: PDFFont, width: number, height: number, sizes: readonly number[], what: string): Layout {
  const layout =
    layoutLines(lines, font, width, height, { sizes: sizes.filter(size => size >= PREFERRED_MIN_SIZE), maxLinesEach: 1 }) ?? layoutLines(lines, font, width, height, { sizes, maxLinesEach: 6 })
  if (!layout) throw new LabelError('LABEL_TEXT_TOO_LONG', `${what}上的文字太长，放不进标签纸；请缩短品名、原产地或箱号规则后重新生成`)
  return layout
}
