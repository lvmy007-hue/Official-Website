import { existsSync } from 'node:fs'
import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS, ITEM_LABEL_SIZE_SPEC, type BoxLabelJob, type ItemLabelJob, type LabelOptions } from '@nova/api-contracts'
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildBoxLabelPdf, printOrder } from './box-label-pdf'
import { code128Bars, code128Modules, code128Supports, code128Symbols, code128Width } from './code128'
import { LabelError } from './errors'
import { buildItemLabelPdf } from './item-label-pdf'
import { pageTexts, probePage } from './pdf-content'

// 标签生成（P6-12，worker 部分）：条码编码、页面空白区探测、自定义箱标签（附页与追加）、商品标签。

const THERMAL = { width: 288, height: 432 }
/** 模拟亚马逊箱标签：页面中部一大块条码区（y 120 到 320），顶部有一行地址文字。 */
async function amazonLabels(pages: number, size: { width: number; height: number } = THERMAL, options: { fullPageCover?: boolean; rotate?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([size.width, size.height])
    page.drawText(`FBA15ABC${index + 1}`, { x: 20, y: size.height - 40, size: 14, font })
    page.drawRectangle({ x: 20, y: 120, width: size.width - 40, height: 200, color: rgb(0, 0, 0) })
    if (options.fullPageCover) page.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: rgb(1, 1, 1) })
    if (options.rotate) page.setRotation(degrees(90))
  }
  return doc.save()
}

const baseJob = (patch: Partial<BoxLabelJob> = {}, options: Partial<LabelOptions> = {}): BoxLabelJob => ({
  planId: 'plan-1',
  shipmentRowId: 'ship-1',
  shipmentLabel: 'FBA15ABC',
  destinationFc: 'ONT8',
  planName: 'Autumn restock',
  planNo: 'P0001',
  baseLabelJobId: 'job-1',
  templateId: null,
  templateName: 'Default',
  paper: 'THERMAL_4X6',
  options: { ...DEFAULT_LABEL_OPTIONS, ...options },
  boxNoRule: DEFAULT_BOX_NO_RULE,
  boxCount: 3,
  startNumber: 1,
  facts: { items: [{ sku: 'SKU-A', quantity: 12, productName: 'Desk lamp', fnsku: 'X001ABCDEF' }] },
  notes: [],
  ...patch,
})
const run = (job: BoxLabelJob, base: Uint8Array, fontPath?: string) => buildBoxLabelPdf({ base, job, fontPath, generatedAt: new Date('2026-12-14T08:00:00Z') })

describe('Code 128 条码', () => {
  it('符号序列：起始符 B、字符、校验符、终止符；校验符按位置加权求和对 103 取余', () => {
    const symbols = code128Symbols('PJJ123C')
    expect(symbols[0]).toBe(104)
    expect(symbols.at(-1)).toBe(106)
    // 104 + 48 + 2×42 + 3×42 + 4×17 + 5×18 + 6×19 + 7×35 = 879，879 mod 103 = 55
    expect(symbols.at(-2)).toBe(55)
    expect(symbols).toHaveLength(7 + 3)
  })

  it('每个可打印字符的条空宽度合计固定：起始符、字符、校验符各 11 个模块，终止符 13 个模块', () => {
    for (let code = 32; code <= 126; code += 1) expect(code128Width(String.fromCharCode(code))).toBe(11 * 3 + 13)
    expect(code128Modules('X001ABCDEF').length).toBe(6 * 12 + 7)
  })

  it('条的数量与位置：条与空交替，条从 0 起', () => {
    const bars = code128Bars('A')
    expect(bars[0]!.x).toBe(0)
    // 起始符、字符、校验符各 3 个条，终止符 4 个条
    expect(bars).toHaveLength(3 * 3 + 4)
    const last = bars.at(-1)!
    expect(last.x + last.width).toBe(code128Width('A'))
  })

  it('不能编码的字符（中文、空串）被拒绝', () => {
    expect(code128Supports('X001')).toBe(true)
    expect(code128Supports('')).toBe(false)
    expect(code128Supports('编码')).toBe(false)
    expect(() => code128Symbols('编码')).toThrow()
  })
})

describe('页面空白区探测', () => {
  it('读出已绘制范围：矩形与文字都计入', async () => {
    const doc = await PDFDocument.load(await amazonLabels(1))
    const probe = probePage(doc.getPage(0))
    expect(probe.uncertain).toBeNull()
    expect(probe.bounds!.y0).toBeLessThanOrEqual(120)
    expect(probe.bounds!.y1).toBeGreaterThanOrEqual(392)
    expect(probe.bounds!.x0).toBeLessThanOrEqual(20)
    expect(pageTexts(doc.getPage(0)).map(item => item.text)).toContain('FBA15ABC1')
  })

  it('旋转的页面与带内嵌图片的页面报“不确定”，不给出空白区', async () => {
    const rotated = await PDFDocument.load(await amazonLabels(1, THERMAL, { rotate: true }))
    expect(probePage(rotated.getPage(0)).uncertain).toMatch(/旋转/)
    const doc = await PDFDocument.create()
    const page = doc.addPage([288, 432])
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q 100 0 0 100 10 10 cm BI /W 1 /H 1 /BPC 8 /CS /G ID x EI Q')))
    const loaded = await PDFDocument.load(await doc.save())
    expect(probePage(loaded.getPage(0)).uncertain).toMatch(/内嵌图片/)
  })

  it('空白页：没有已绘制范围', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([288, 432])
    const loaded = await PDFDocument.load(await doc.save())
    const probe = probePage(loaded.getPage(0))
    expect(probe.bounds).toBeNull()
    expect(probe.uncertain).toBeNull()
  })
})

describe('自定义箱标签', () => {
  it('默认附页：亚马逊标签页原样保留，每个标签后面跟一张写着箱号与内容的附页', async () => {
    const base = await amazonLabels(3)
    const result = await run(baseJob(), base)
    expect(result).toMatchObject({ pages: 6, boxes: 3, overlaid: 0, attached: 3, fellBack: 0 })
    const out = await PDFDocument.load(result.bytes)
    const original = await PDFDocument.load(base)
    // 偶数页（0、2、4）是亚马逊标签，内容与原文件逐页一致
    for (let index = 0; index < 3; index += 1) {
      expect(pageTexts(out.getPage(index * 2)).map(item => item.text)).toEqual(pageTexts(original.getPage(index)).map(item => item.text))
      expect(probePage(out.getPage(index * 2)).bounds).toEqual(probePage(original.getPage(index)).bounds)
    }
    const sheet = pageTexts(out.getPage(1)).map(item => item.text)
    expect(sheet).toContain('Box No: BOX-001')
    expect(sheet).toContain('Origin: Made in China')
    expect(sheet).toContain('SKU: SKU-A')
    expect(sheet).toContain('Units per box: 12')
    expect(pageTexts(out.getPage(5)).map(item => item.text)).toContain('Box No: BOX-003')
  })

  it('箱号规则与起始序号：从指定序号往下编', async () => {
    const result = await run(baseJob({ startNumber: 8, boxNoRule: { ...DEFAULT_BOX_NO_RULE, prefix: 'CTN', digits: 4, includePlanNo: true } }), await amazonLabels(3))
    const out = await PDFDocument.load(result.bytes)
    expect(pageTexts(out.getPage(1)).map(item => item.text)).toContain('Box No: CTN-P0001-0008')
    expect(pageTexts(out.getPage(5)).map(item => item.text)).toContain('Box No: CTN-P0001-0010')
  })

  it('任务名称页：文件第一页，写明货件、计划、目的地、箱数', async () => {
    const result = await run(baseJob({}, { taskNamePage: true }), await amazonLabels(3))
    expect(result.pages).toBe(7)
    const out = await PDFDocument.load(result.bytes)
    const first = pageTexts(out.getPage(0)).map(item => item.text)
    expect(first).toEqual(expect.arrayContaining(['Shipment: FBA15ABC', 'Plan: Autumn restock', 'Destination: ONT8', 'Boxes: 3', 'Box numbers: BOX-001 to BOX-003']))
  })

  it('追加到原标签：文字落在条码区之外的空白区，不压住条码，原页内容不丢', async () => {
    const result = await run(baseJob({}, { appendToOriginal: true }), await amazonLabels(3))
    expect(result).toMatchObject({ pages: 3, overlaid: 3, attached: 0, fellBack: 0 })
    const out = await PDFDocument.load(result.bytes)
    const added = pageTexts(out.getPage(0)).filter(item => item.text.startsWith('Box No') || item.text.startsWith('Origin') || item.text.startsWith('SKU') || item.text.startsWith('Units'))
    expect(added.length).toBe(4)
    // 条码区是 y 120 到 320：追加文字必须在它的下方（含字高）或上方，并且在页边距之内
    for (const item of added) {
      const top = item.y + item.size
      expect(top <= 120 - 8 || item.y >= 320 + 8).toBe(true)
      expect(item.y).toBeGreaterThanOrEqual(12)
      expect(top).toBeLessThanOrEqual(432 - 12)
    }
    expect(pageTexts(out.getPage(0)).map(item => item.text)).toContain('FBA15ABC1')
  })

  it('空白区不够（整页被盖住）或判断不了：自动改成附页，并计入“改附页”数', async () => {
    const covered = await run(baseJob({}, { appendToOriginal: true }), await amazonLabels(3, THERMAL, { fullPageCover: true }))
    expect(covered).toMatchObject({ pages: 6, overlaid: 0, attached: 3, fellBack: 3 })
    // 页面里有内嵌图片：范围判断不了，同样改附页
    const doc = await PDFDocument.create()
    for (let index = 0; index < 3; index += 1) {
      const page = doc.addPage([288, 432])
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q 100 0 0 100 10 10 cm BI /W 1 /H 1 /BPC 8 /CS /G ID x EI Q')))
    }
    const unsure = await run(baseJob({}, { appendToOriginal: true }), await doc.save())
    expect(unsure).toMatchObject({ pages: 6, overlaid: 0, fellBack: 3 })
  })

  it('A4 拼版纸张：不追加到原标签，按页附一张与标签位置一一对应的附页', async () => {
    const a4 = { width: 595.28, height: 841.89 }
    const result = await run(baseJob({ paper: 'A4_4UP', boxCount: 5 }, { appendToOriginal: false }), await amazonLabels(2, a4))
    expect(result).toMatchObject({ pages: 4, attached: 5 })
    const out = await PDFDocument.load(result.bytes)
    const texts = pageTexts(out.getPage(1)).map(item => item.text)
    expect(texts.filter(text => text.startsWith('Box No')).length).toBe(4)
    expect(
      pageTexts(out.getPage(3))
        .map(item => item.text)
        .filter(text => text.startsWith('Box No')),
    ).toEqual(['Box No: BOX-005'])
  })

  it('每个选项都关掉、也没有任务名称页：不加任何附页，只原样复制', async () => {
    const off = { showOrigin: false, showSku: false, showProductName: false, showFnsku: false, showUnits: false, showBoxNo: false }
    const result = await run(baseJob({}, off), await amazonLabels(3))
    expect(result).toMatchObject({ pages: 3, attached: 0, overlaid: 0 })
  })

  it('品名与 FNSKU 只在内容能确定时才有：没有 facts 就不印', async () => {
    const result = await run(baseJob({ facts: null }, { showProductName: true, showFnsku: true }), await amazonLabels(3))
    const out = await PDFDocument.load(result.bytes)
    const texts = pageTexts(out.getPage(1)).map(item => item.text)
    expect(texts.some(text => text.startsWith('SKU') || text.startsWith('Item') || text.startsWith('FNSKU') || text.startsWith('Units'))).toBe(false)
    expect(texts).toContain('Box No: BOX-001')
  })

  it('亚马逊文件页数与箱数对不上：失败并写明原因，不生成错位的文件', async () => {
    await expect(run(baseJob(), await amazonLabels(2))).rejects.toMatchObject({ code: 'LABEL_PAGE_MISMATCH' })
  })

  it('亚马逊文件不是有效 PDF：失败', async () => {
    await expect(run(baseJob(), Buffer.from('not a pdf'))).rejects.toMatchObject({ code: 'LABEL_BASE_INVALID' })
    await expect(run(baseJob(), Buffer.from('not a pdf'))).rejects.toBeInstanceOf(LabelError)
  })

  it('含中文但没有配置字体：失败并写明去哪里配置，不印成乱码', async () => {
    const job = baseJob({ planName: '秋季补货' }, { taskNamePage: true })
    await expect(run(job, await amazonLabels(3))).rejects.toMatchObject({ code: 'LABEL_FONT_MISSING', message: expect.stringContaining('LABEL_FONT_PATH') })
    await expect(run(job, await amazonLabels(3), 'Z:/nope/font.ttf')).rejects.toMatchObject({ code: 'LABEL_FONT_MISSING', message: expect.stringContaining('读不出来') })
  })

  const SIMHEI = 'C:/Windows/Fonts/simhei.ttf'
  it.skipIf(!existsSync(SIMHEI))('配置了中文字体：品名与原产地可以印中文', async () => {
    const job = baseJob({ facts: { items: [{ sku: 'SKU-A', quantity: 12, productName: '台灯 暖光', fnsku: null }] } }, { showProductName: true, originText: '中国制造' })
    const result = await run(job, await amazonLabels(3), SIMHEI)
    expect(result.pages).toBe(6)
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(6)
  })

  it('打印顺序：热敏纸可按我方箱号重排（数字按大小），拼版纸张不重排', () => {
    const numbers = ['B-10', 'B-2', 'B-1']
    expect(printOrder(baseJob({}, { order: 'AMAZON' }), numbers)).toEqual([0, 1, 2])
    expect(printOrder(baseJob({}, { order: 'OURS' }), numbers)).toEqual([2, 1, 0])
    expect(printOrder(baseJob({ paper: 'A4_2UP' }, { order: 'OURS' }), numbers)).toEqual([0, 1, 2])
  })
})

describe('商品标签（FNSKU）', () => {
  const job = (patch: Partial<ItemLabelJob> = {}): ItemLabelJob => ({
    planId: 'plan-1',
    shipmentRowId: 'ship-1',
    size: 'THERMAL_60X40',
    showTitle: true,
    showCondition: true,
    lines: [
      { sku: 'SKU-A', fnsku: 'X001ABCDEF', title: 'Desk lamp', quantity: 3 },
      { sku: 'SKU-B', fnsku: 'X002ABCDEF', title: null, quantity: 2 },
    ],
    ...patch,
  })

  it('热敏纸一页一张：页数等于标签数，页面大小是标签大小', async () => {
    const result = await buildItemLabelPdf({ job: job(), fontPath: undefined })
    expect(result).toMatchObject({ pages: 5, labels: 5 })
    const out = await PDFDocument.load(result.bytes)
    const spec = ITEM_LABEL_SIZE_SPEC.THERMAL_60X40
    expect(out.getPage(0).getSize().width).toBeCloseTo(spec.pageWidthPt, 1)
    const texts = pageTexts(out.getPage(0)).map(item => item.text)
    expect(texts).toEqual(expect.arrayContaining(['X001ABCDEF', 'SKU: SKU-A', 'Desk lamp', 'New']))
    expect(pageTexts(out.getPage(4)).map(item => item.text)).toContain('X002ABCDEF')
  })

  it('A4 不干胶按版式排：21 格一页，最后一页不满的格子留空', async () => {
    const result = await buildItemLabelPdf({ job: job({ size: 'A4_21', lines: [{ sku: 'SKU-A', fnsku: 'X001ABCDEF', title: null, quantity: 25 }] }), fontPath: undefined })
    expect(result).toMatchObject({ pages: 2, labels: 25 })
    const out = await PDFDocument.load(result.bytes)
    expect(pageTexts(out.getPage(0)).filter(item => item.text === 'X001ABCDEF')).toHaveLength(21)
    expect(pageTexts(out.getPage(1)).filter(item => item.text === 'X001ABCDEF')).toHaveLength(4)
  })

  it('条码与文字都在各自的标签格内，不越出标签', async () => {
    const result = await buildItemLabelPdf({
      job: job({ size: 'A4_65', lines: [{ sku: 'SKU-A', fnsku: 'X001ABCDEF', title: 'A very long product title that wraps', quantity: 65 }] }),
      fontPath: undefined,
    })
    const out = await PDFDocument.load(result.bytes)
    const spec = ITEM_LABEL_SIZE_SPEC.A4_65
    expect(probePage(out.getPage(0)).uncertain).toBeNull()
    // 每段文字的起点都落在某一列标签格内
    const cells = Array.from({ length: spec.cols }, (_, col) => [spec.marginLeftPt + col * spec.pitchXPt, spec.marginLeftPt + col * spec.pitchXPt + spec.widthPt] as const)
    const texts = pageTexts(out.getPage(0))
    expect(texts.length).toBeGreaterThan(0)
    for (const item of texts) {
      expect(cells.some(([left, right]) => item.x >= left && item.x <= right)).toBe(true)
      expect(item.y).toBeLessThanOrEqual(spec.pageHeightPt - spec.marginTopPt)
    }
  })

  it('同一个 FNSKU 印很多张时文件不会膨胀：条码只存一份', async () => {
    const result = await buildItemLabelPdf({ job: job({ size: 'A4_65', lines: [{ sku: 'SKU-A', fnsku: 'X001ABCDEF', title: null, quantity: 3000 }] }), fontPath: undefined })
    expect(result.labels).toBe(3000)
    expect(result.bytes.length).toBeLessThan(2_000_000)
  })

  it('FNSKU 含不能编成条码的字符、或总数超限：失败', async () => {
    await expect(buildItemLabelPdf({ job: job({ lines: [{ sku: 'S', fnsku: '条码', title: null, quantity: 1 }] }), fontPath: undefined })).rejects.toMatchObject({ code: 'LABEL_JOB_INVALID' })
    await expect(buildItemLabelPdf({ job: job({ lines: [{ sku: 'S', fnsku: 'X001', title: null, quantity: 20_001 }] }), fontPath: undefined })).rejects.toMatchObject({ code: 'LABEL_TOO_LARGE' })
  })

  it('品名含中文但没有字体：失败；不勾品名就不需要字体', async () => {
    const chinese = job({ lines: [{ sku: 'S', fnsku: 'X001', title: '台灯', quantity: 1 }] })
    await expect(buildItemLabelPdf({ job: chinese, fontPath: undefined })).rejects.toMatchObject({ code: 'LABEL_FONT_MISSING' })
    await expect(buildItemLabelPdf({ job: { ...chinese, showTitle: false }, fontPath: undefined })).resolves.toMatchObject({ labels: 1 })
  })
})
