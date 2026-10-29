import { LABEL_PAPER_SPEC, boxLabelLines, formatBoxNo, labelsPerPage, type BoxLabelJob } from '@nova/api-contracts'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { LabelError } from './errors'
import { probePage, type PageProbe } from './pdf-content'
import { cleanLabelText, embedLabelFonts } from './pdf-fonts'
import { drawLayout, layoutLines, mustLayout } from './pdf-layout'

// 自定义箱标签（P6-12）：以亚马逊返回的箱标签 PDF 为底（原样复制，一个字节的标签内容都不改），
// 把箱号、原产地、SKU 等文字放在“附页”上，或者（热敏纸并且勾选了“追加到原标签”）追加在原标签的空白区。
// 默认附页：空白区无法从文件里可靠判断，判断不了就附页，不冒险压住条码。

export interface BoxLabelResult {
  bytes: Uint8Array
  pages: number
  boxes: number
  /** 追加在原标签空白区的箱数。 */
  overlaid: number
  /** 改用附页的箱数（含没勾选追加的）。 */
  attached: number
  /** 勾选了追加但空白区不够、改成附页的箱数。 */
  fellBack: number
}

const MARGIN = 12
const GAP = 8
const OVERLAY_SIZES = [9, 8, 7, 6] as const
const SHEET_SIZES = [18, 16, 14, 12, 11, 10, 9, 8, 7, 6] as const
const NATURAL = new Intl.Collator('en', { numeric: true })

const boxNumbers = (job: BoxLabelJob) => Array.from({ length: job.boxCount }, (_, index) => formatBoxNo(job.boxNoRule, job.planNo, index, job.startNumber))

/** 打印顺序：热敏纸可以按我方箱号排；拼版纸张按亚马逊页顺序，不重排。 */
export function printOrder(job: BoxLabelJob, numbers: readonly string[]): number[] {
  const indexes = numbers.map((_, index) => index)
  if (job.options.order === 'OURS' && labelsPerPage(job.paper) === 1) indexes.sort((a, b) => NATURAL.compare(numbers[a]!, numbers[b]!) || a - b)
  return indexes
}

/** 每个箱子要印的文字行（已清理控制字符，去掉空行）。 */
const linesFor = (job: BoxLabelJob, boxNo: string) =>
  boxLabelLines(job.options, boxNo, job.facts)
    .map(cleanLabelText)
    .filter(line => line.length > 0)

function taskPageLines(job: BoxLabelJob, numbers: readonly string[]): string[] {
  const range = numbers.length > 1 ? `${numbers[0]} to ${numbers[numbers.length - 1]}` : (numbers[0] ?? '')
  const lines = [`Shipment: ${job.shipmentLabel || '-'}`, `Plan: ${job.planName || '-'}`, `Destination: ${job.destinationFc ?? '-'}`, `Boxes: ${job.boxCount}`, `Template: ${job.templateName}`]
  if (job.options.showBoxNo) lines.push(`Box numbers: ${range}`)
  return lines.map(cleanLabelText)
}

/** 空白区放置：只在热敏纸这类一页一张的标签上用；返回要画的位置，找不到能放下又不碰条码的空白区就返回 null。 */
function overlaySpot(probe: PageProbe, lines: readonly string[], font: PDFFont) {
  if (probe.uncertain) return null
  const width = probe.width - 2 * MARGIN
  const bands = probe.bounds
    ? [
        { bottom: MARGIN, top: probe.bounds.y0 - GAP },
        { bottom: probe.bounds.y1 + GAP, top: probe.height - MARGIN },
      ]
    : [{ bottom: MARGIN, top: probe.height - MARGIN }]
  const usable = bands.filter(band => band.top - band.bottom > 0).sort((a, b) => b.top - b.bottom - (a.top - a.bottom))
  for (const size of OVERLAY_SIZES) {
    for (const band of usable) {
      const layout = layoutLines(lines, font, width, band.top - band.bottom, { sizes: [size], maxLinesEach: 2 })
      if (layout) return { layout, top: band.top }
    }
  }
  return null
}

function addTextPage(out: PDFDocument, width: number, height: number, lines: readonly string[], font: PDFFont, footer: string, sizes: readonly number[]) {
  const page = out.addPage([width, height])
  const area = { width: width - 2 * MARGIN * 1.5, height: height - 3 * MARGIN * 1.5 }
  const layout = mustLayout(lines, font, area.width, area.height, sizes, '附页')
  drawLayout(page, layout, font, MARGIN * 1.5, height - MARGIN * 1.5)
  page.drawText(footer, { x: MARGIN * 1.5, y: MARGIN, size: 6, font, color: rgb(0.4, 0.4, 0.4) })
}

const SHEET_FOOTER = 'Attached sheet. The Amazon label is unchanged.'

/** 多张拼版纸的附页：格子与亚马逊那一页上的标签位置一一对应，方便对着贴。 */
function addGridSheet(out: PDFDocument, job: BoxLabelJob, font: PDFFont, cells: ReadonlyArray<readonly string[]>) {
  const spec = LABEL_PAPER_SPEC[job.paper]
  const page = out.addPage([spec.widthPt, spec.heightPt])
  const cellW = spec.widthPt / spec.cols
  const cellH = spec.heightPt / spec.rows
  cells.forEach((lines, index) => {
    const col = index % spec.cols
    const row = Math.floor(index / spec.cols)
    const x = col * cellW
    const top = spec.heightPt - row * cellH
    page.drawRectangle({ x: x + 4, y: top - cellH + 4, width: cellW - 8, height: cellH - 8, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 })
    const layout = mustLayout(lines, font, cellW - 2 * MARGIN - 8, cellH - 2 * MARGIN - 8, SHEET_SIZES, '附页')
    drawLayout(page, layout, font, x + MARGIN + 4, top - MARGIN - 4)
  })
  page.drawText(SHEET_FOOTER, { x: MARGIN, y: 6, size: 6, font, color: rgb(0.4, 0.4, 0.4) })
}

export async function buildBoxLabelPdf(input: { base: Uint8Array; job: BoxLabelJob; fontPath: string | undefined; generatedAt: Date }): Promise<BoxLabelResult> {
  const { job } = input
  const spec = LABEL_PAPER_SPEC[job.paper]
  const perPage = labelsPerPage(job.paper)
  let base: PDFDocument
  try {
    base = await PDFDocument.load(input.base)
  } catch {
    throw new LabelError('LABEL_BASE_INVALID', '亚马逊箱标签文件打不开（可能已损坏或被加密）；请到入仓计划“标签”页签重新获取箱标签后再生成')
  }
  const expectedPages = Math.ceil(job.boxCount / perPage)
  if (base.getPageCount() !== expectedPages) {
    throw new LabelError(
      'LABEL_PAGE_MISMATCH',
      `亚马逊箱标签文件有 ${base.getPageCount()} 页，而 ${job.boxCount} 个箱子按“${spec.label}”应有 ${expectedPages} 页；箱数或纸张与获取标签时不一致，请重新获取箱标签后再生成`,
    )
  }
  const numbers = boxNumbers(job)
  const perBoxLines = numbers.map(no => linesFor(job, no))
  const taskLines = job.options.taskNamePage ? taskPageLines(job, numbers) : []
  const out = await PDFDocument.create()
  const fonts = await embedLabelFonts(out, [...perBoxLines.flat(), ...taskLines, SHEET_FOOTER, 'Label task'], input.fontPath)
  const font = fonts.regular
  const result: BoxLabelResult = { bytes: new Uint8Array(), pages: 0, boxes: job.boxCount, overlaid: 0, attached: 0, fellBack: 0 }
  const hasLines = perBoxLines.some(lines => lines.length > 0)

  if (job.options.taskNamePage) {
    const first = base.getPage(0).getSize()
    addTextPage(
      out,
      perPage === 1 ? first.width : spec.widthPt,
      perPage === 1 ? first.height : spec.heightPt,
      ['Label task', ...taskLines],
      fonts.bold,
      'Task page. Not part of the Amazon label.',
      [16, 14, 12, 10, 8, 6],
    )
  }

  if (perPage === 1) {
    const order = printOrder(job, numbers)
    const wantOverlay = job.options.appendToOriginal && spec.overlayAllowed
    for (const index of order) {
      const [copied] = await out.copyPages(base, [index])
      const page: PDFPage = out.addPage(copied!)
      const lines = perBoxLines[index]!
      if (!hasLines || lines.length === 0) continue
      const spot = wantOverlay ? overlaySpot(probePage(base.getPage(index)), lines, font) : null
      if (spot) {
        drawLayout(page, spot.layout, font, MARGIN, spot.top)
        result.overlaid += 1
        continue
      }
      if (wantOverlay) result.fellBack += 1
      const { width, height } = page.getSize()
      addTextPage(out, width, height, lines, fonts.bold, SHEET_FOOTER, SHEET_SIZES)
      result.attached += 1
    }
  } else {
    for (let pageIndex = 0; pageIndex < expectedPages; pageIndex += 1) {
      const [copied] = await out.copyPages(base, [pageIndex])
      out.addPage(copied!)
      const cells = perBoxLines.slice(pageIndex * perPage, (pageIndex + 1) * perPage)
      if (!hasLines) continue
      addGridSheet(
        out,
        job,
        font,
        cells.map(lines => (lines.length > 0 ? lines : ['-'])),
      )
      result.attached += cells.length
    }
  }
  result.pages = out.getPageCount()
  result.bytes = await out.save()
  return result
}
