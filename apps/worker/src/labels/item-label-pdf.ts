import { ITEM_LABEL_MAX, ITEM_LABEL_SIZE_SPEC, itemLabelsTotal, type ItemLabelJob, type ItemLabelSizeSpec } from '@nova/api-contracts'
import { PDFDocument, concatTransformationMatrix, drawObject, fill, popGraphicsState, pushGraphicsState, rectangle, rgb, type PDFFont, type PDFPage, type PDFRef } from 'pdf-lib'
import { CODE128_QUIET_MODULES, code128Bars, code128Supports, code128Width } from './code128'
import { LabelError } from './errors'
import { cleanLabelText, embedLabelFonts } from './pdf-fonts'
import { layoutLines, drawLayout } from './pdf-layout'

// 商品标签（FNSKU）：每张标签一个 Code 128 条码 + FNSKU、SKU、品名、状态文字。条码用 FNSKU 本身编码，亚马逊入库扫描认的就是它。
// 标签纸规格见 ITEM_LABEL_SIZE_SPEC：热敏纸一页一张；A4 不干胶按版式从左到右、从上到下排，最后一页不满的格子留空。

export interface ItemLabelResult {
  bytes: Uint8Array
  pages: number
  labels: number
}

const PAD = 4
const BLACK = rgb(0, 0, 0)

interface LabelText {
  fnsku: string
  sku: string
  title: string | null
  condition: string | null
}

/** 条码做成一个可重复引用的图形（每个 FNSKU 只存一份，印多少张都只多一行引用），2 万张标签的文件才不会膨胀。 */
function barcodeForm(out: PDFDocument, fnsku: string): PDFRef {
  const operators = [...code128Bars(fnsku).map(bar => rectangle(bar.x, 0, bar.width, 1)), fill()]
  const stream = out.context.formXObject(operators, { BBox: out.context.obj([0, 0, code128Width(fnsku), 1]) })
  return out.context.register(stream)
}

function drawLabel(page: PDFPage, spec: ItemLabelSizeSpec, left: number, top: number, text: LabelText, barcode: PDFRef, fonts: { regular: PDFFont; bold: PDFFont }) {
  const width = spec.widthPt - 2 * PAD
  const height = spec.heightPt - 2 * PAD
  const x = left + PAD
  const bottom = top - spec.heightPt + PAD
  // 条码占上半部分；模块宽度按可用宽度自适应，但不超过 1.4pt，避免小标签上条码太粗
  const modules = code128Width(text.fnsku) + 2 * CODE128_QUIET_MODULES
  const module = Math.min(width / modules, 1.4)
  const barsWidth = code128Width(text.fnsku) * module
  const barsLeft = x + (width - barsWidth) / 2
  const barHeight = Math.max(height * 0.42, 10)
  const barBottom = top - PAD - barHeight
  const name = page.node.newXObject('Bc', barcode)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(module, 0, 0, barHeight, barsLeft, barBottom), drawObject(name), popGraphicsState())
  // 条码下面的文字：FNSKU 加粗居中，其余按行排，放不下就缩小字号
  const lines = [text.fnsku, `SKU: ${text.sku}`, ...(text.title ? [text.title] : []), ...(text.condition ? [text.condition] : [])]
  const room = barBottom - bottom - 2
  const layout = layoutLines(lines, fonts.regular, width, room, { sizes: [10, 9, 8, 7, 6, 5], maxLinesEach: 2, leading: 1.15 })
  if (!layout) {
    // 品名太长放不下：只印 FNSKU 与 SKU
    const short = layoutLines(lines.slice(0, 2), fonts.regular, width, room, { sizes: [8, 7, 6, 5, 4], maxLinesEach: 1, leading: 1.1 })
    if (!short) throw new LabelError('LABEL_TEXT_TOO_LONG', `商品标签太小，放不下 ${text.fnsku} 的 FNSKU 与 SKU 文字；请换大一点的标签纸`)
    drawLayout(page, short, fonts.regular, x, barBottom - 2)
    return
  }
  const first = layout.wrapped[0]![0]!
  page.drawText(first, { x: x + Math.max(0, (width - fonts.bold.widthOfTextAtSize(first, layout.size)) / 2), y: barBottom - 2 - layout.size, size: layout.size, font: fonts.bold, color: BLACK })
  // 第一行（FNSKU）已画，剩余行从第二行开始往下
  const rest = { ...layout, wrapped: layout.wrapped.slice(1) }
  drawLayout(page, rest, fonts.regular, x, barBottom - 2 - layout.lineHeight)
}

export async function buildItemLabelPdf(input: { job: ItemLabelJob; fontPath: string | undefined }): Promise<ItemLabelResult> {
  const { job } = input
  const total = itemLabelsTotal(job.lines)
  if (total < 1 || total > ITEM_LABEL_MAX) throw new LabelError('LABEL_TOO_LARGE', `商品标签共 ${total} 张，单次最多 ${ITEM_LABEL_MAX} 张；请分批生成`)
  for (const line of job.lines) {
    if (!code128Supports(line.fnsku)) throw new LabelError('LABEL_JOB_INVALID', `FNSKU ${line.fnsku} 含有不能编码成条码的字符，请先在商品资料里修正`)
  }
  const spec = ITEM_LABEL_SIZE_SPEC[job.size]
  const texts = job.lines.map<LabelText>(line => ({
    fnsku: line.fnsku,
    sku: cleanLabelText(line.sku),
    title: job.showTitle && line.title ? cleanLabelText(line.title) : null,
    condition: job.showCondition ? 'New' : null,
  }))
  const out = await PDFDocument.create()
  const fonts = await embedLabelFonts(
    out,
    texts.flatMap(item => [item.fnsku, `SKU: ${item.sku}`, item.title ?? '', item.condition ?? '']),
    input.fontPath,
  )
  const perPage = spec.cols * spec.rows
  const barcodes = texts.map(item => barcodeForm(out, item.fnsku))
  let printed = 0
  let page: PDFPage | null = null
  job.lines.forEach((line, lineIndex) => {
    for (let copy = 0; copy < line.quantity; copy += 1) {
      const slot = printed % perPage
      if (slot === 0) page = out.addPage([spec.pageWidthPt, spec.pageHeightPt])
      const col = slot % spec.cols
      const row = Math.floor(slot / spec.cols)
      drawLabel(page!, spec, spec.marginLeftPt + col * spec.pitchXPt, spec.pageHeightPt - spec.marginTopPt - row * spec.pitchYPt, texts[lineIndex]!, barcodes[lineIndex]!, fonts)
      printed += 1
    }
  })
  return { bytes: await out.save(), pages: out.getPageCount(), labels: printed }
}
