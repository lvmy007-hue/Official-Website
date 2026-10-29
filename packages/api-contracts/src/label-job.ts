import { boxNoPreview, normalizeBoxNoRule, normalizeLabelOptions, LABEL_PAPERS, type BoxNoRule, type LabelOptions, type LabelPaper } from './label-template.js'

// 标签生成任务契约（P6-12）：自定义箱标签与商品标签（FNSKU）的任务载荷、箱内内容的确定规则、标签上的文字行、标签纸规格。
// 生成在 worker 里进行，结果走导出中心（PDF）。零 zod：接口、worker 与页面共用；请求体校验在 label-template-query.ts。

export const BOX_LABEL_KIND = 'inbound-box-labels'
export const ITEM_LABEL_KIND = 'inbound-item-labels'
/** 单个货件最多生成多少个箱子的标签。 */
export const LABEL_MAX_BOXES = 2000
/** 一个商品标签任务最多印多少张。 */
export const ITEM_LABEL_MAX = 20_000
/** 一个商品标签任务最多包含多少个 SKU。 */
export const ITEM_LABEL_MAX_SKUS = 1000
export const LABEL_EXPORT_PATH = '/app/my/exports'

// ---------------------------------------------------------------- 箱内内容
export interface BoxFactsItem {
  sku: string
  /** 每箱件数；各箱不同时为 null（不印）。 */
  quantity: number | null
  productName: string | null
  fnsku: string | null
}
/** 能确定的、对所有箱子都成立的箱内内容（亚马逊箱标签与我方装箱记录没有一一对应关系，所以只在内容一致时才印）。 */
export interface BoxContentFacts {
  items: BoxFactsItem[]
}
export interface PlanBoxContent {
  /** 这一行装箱记录代表几个相同的箱子。 */
  quantity: number
  items: ReadonlyArray<{ sku: string; quantity: number }>
}
export interface BoxFactsResult {
  facts: BoxContentFacts | null
  /** 不能确定时的原因（给页面和任务说明用）；能确定时为 null。 */
  note: string | null
}

const signatureOf = (items: PlanBoxContent['items']) =>
  [...items]
    .map(item => `${item.sku}:${item.quantity}`)
    .sort()
    .join('|')

/**
 * 判断“每个箱子装了什么”能不能确定。
 * 亚马逊的箱标签按箱序号排列，我方装箱记录里没有记下哪个箱子对应亚马逊哪一箱，所以只有下面两种情况是确定的：
 * 1. 所有箱子内容完全一致：SKU、品名、FNSKU、每箱件数都能印（并用货件里的数量核对：货件数量必须等于箱数 × 每箱件数）；
 * 2. 所有箱子都只装同一个 SKU（每箱件数不同）：能印 SKU、品名、FNSKU，不印件数。
 * 其余情况（多种商品混装且各箱不同）一律不印内容，宁可少印也不印错。
 */
export function boxContentFacts(input: {
  boxes: readonly PlanBoxContent[]
  shipmentItems: ReadonlyArray<{ sku: string; quantity: number }>
  boxCount: number
  names: ReadonlyMap<string, { productName: string | null; fnsku: string | null }>
}): BoxFactsResult {
  const rows = input.boxes.filter(box => box.quantity > 0 && box.items.length > 0)
  if (rows.length === 0) return { facts: null, note: '这个计划还没有装箱记录，SKU、品名、FNSKU、箱内件数不印' }
  const enrich = (sku: string, quantity: number | null): BoxFactsItem => ({ sku, quantity, productName: input.names.get(sku)?.productName ?? null, fnsku: input.names.get(sku)?.fnsku ?? null })
  const first = signatureOf(rows[0]!.items)
  if (rows.every(row => signatureOf(row.items) === first)) {
    const perBox = rows[0]!.items
    const shipmentQty = new Map<string, number>()
    for (const item of input.shipmentItems) shipmentQty.set(item.sku, (shipmentQty.get(item.sku) ?? 0) + item.quantity)
    if (shipmentQty.size === 0) return { facts: null, note: '货件的商品明细还没有同步，无法核对箱内内容，SKU、品名、FNSKU、箱内件数不印' }
    const consistent = shipmentQty.size === perBox.length && perBox.every(item => shipmentQty.get(item.sku) === item.quantity * input.boxCount)
    if (!consistent) return { facts: null, note: '货件里的商品数量与“箱数 × 每箱件数”对不上，无法确定箱内内容，SKU、品名、FNSKU、箱内件数不印' }
    return { facts: { items: perBox.map(item => enrich(item.sku, item.quantity)) }, note: null }
  }
  const skus = new Set(rows.flatMap(row => row.items.map(item => item.sku)))
  if (skus.size === 1 && rows.every(row => row.items.length === 1)) {
    const sku = [...skus][0]!
    const shipmentSkus = new Set(input.shipmentItems.map(item => item.sku))
    if (shipmentSkus.size > 0 && !(shipmentSkus.size === 1 && shipmentSkus.has(sku))) return { facts: null, note: '货件里的商品与装箱记录不一致，无法确定箱内内容，SKU、品名、FNSKU、箱内件数不印' }
    return { facts: { items: [enrich(sku, null)] }, note: '各箱的件数不同，无法确定哪一箱对应亚马逊的哪一个标签，箱内件数不印' }
  }
  return { facts: null, note: '各箱内容不同，无法确定亚马逊标签上的每个箱子对应我方哪个箱子，SKU、品名、FNSKU、箱内件数都不印；需要印的话请让所有箱子的内容保持一致' }
}

/** 一个箱子的标签附加文字（每行一项；固定文字用英文，不依赖字体）。 */
export function boxLabelLines(options: LabelOptions, boxNo: string, facts: BoxContentFacts | null): string[] {
  const lines: string[] = []
  if (options.showBoxNo) lines.push(`Box No: ${boxNo}`)
  if (options.showOrigin && options.originText.trim()) lines.push(`Origin: ${options.originText.trim()}`)
  const items = facts?.items ?? []
  if (options.showSku) for (const item of items) lines.push(items.length > 1 && item.quantity !== null ? `SKU: ${item.sku} x ${item.quantity}` : `SKU: ${item.sku}`)
  if (options.showProductName) for (const item of items) if (item.productName) lines.push(`Item: ${item.productName}`)
  if (options.showFnsku && items.length === 1 && items[0]!.fnsku) lines.push(`FNSKU: ${items[0]!.fnsku}`)
  if (options.showUnits && items.length > 0 && items.every(item => item.quantity !== null)) lines.push(`Units per box: ${items.reduce((sum, item) => sum + (item.quantity ?? 0), 0)}`)
  return lines
}

// ---------------------------------------------------------------- 任务载荷
export interface BoxLabelJob {
  planId: string
  shipmentRowId: string
  /** 亚马逊货件编号（或确认号），印在任务名称页上。 */
  shipmentLabel: string
  destinationFc: string | null
  planName: string
  /** 箱号规则里“计划号”部分用的值。 */
  planNo: string
  /** 作为底的亚马逊箱标签文件（LabelPrintJob 编号）。 */
  baseLabelJobId: string
  templateId: string | null
  templateName: string
  paper: LabelPaper
  options: LabelOptions
  boxNoRule: BoxNoRule
  boxCount: number
  startNumber: number
  facts: BoxContentFacts | null
  /** 不能确定的内容及原因，写进任务说明。 */
  notes: string[]
}
export interface ItemLabelLine {
  sku: string
  fnsku: string
  title: string | null
  quantity: number
}
export interface ItemLabelJob {
  planId: string
  shipmentRowId: string | null
  size: ItemLabelSize
  showTitle: boolean
  showCondition: boolean
  lines: ItemLabelLine[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
const posInt = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)

function factsOf(value: unknown): BoxContentFacts | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  const items: BoxFactsItem[] = []
  for (const raw of value.items) {
    if (!isRecord(raw)) return null
    const sku = str(raw.sku)
    if (!sku) return null
    items.push({ sku, quantity: posInt(raw.quantity), productName: str(raw.productName), fnsku: str(raw.fnsku) })
  }
  return { items }
}

/** 读取存在导出任务里的箱标签任务载荷；任何字段不对返回 null（worker 当作“任务内容已损坏”失败，不猜）。 */
export function parseBoxLabelJob(value: unknown): BoxLabelJob | null {
  if (!isRecord(value)) return null
  const paper = LABEL_PAPERS.find(item => item === value.paper)
  const planId = str(value.planId)
  const shipmentRowId = str(value.shipmentRowId)
  const baseLabelJobId = str(value.baseLabelJobId)
  const boxCount = posInt(value.boxCount)
  const startNumber = posInt(value.startNumber)
  if (!paper || !planId || !shipmentRowId || !baseLabelJobId || boxCount === null || boxCount < 1 || boxCount > LABEL_MAX_BOXES || startNumber === null) return null
  return {
    planId,
    shipmentRowId,
    shipmentLabel: str(value.shipmentLabel) ?? '',
    destinationFc: str(value.destinationFc),
    planName: str(value.planName) ?? '',
    planNo: str(value.planNo) ?? '',
    baseLabelJobId,
    templateId: str(value.templateId),
    templateName: str(value.templateName) ?? '默认设置',
    paper,
    options: normalizeLabelOptions(value.options),
    boxNoRule: normalizeBoxNoRule(value.boxNoRule),
    boxCount,
    startNumber,
    facts: factsOf(value.facts),
    notes: Array.isArray(value.notes) ? value.notes.filter((note): note is string => typeof note === 'string') : [],
  }
}

export function parseItemLabelJob(value: unknown): ItemLabelJob | null {
  if (!isRecord(value) || !Array.isArray(value.lines)) return null
  const size = ITEM_LABEL_SIZES.find(item => item === value.size)
  const planId = str(value.planId)
  if (!size || !planId || value.lines.length === 0 || value.lines.length > ITEM_LABEL_MAX_SKUS) return null
  const lines: ItemLabelLine[] = []
  for (const raw of value.lines) {
    if (!isRecord(raw)) return null
    const sku = str(raw.sku)
    const fnsku = str(raw.fnsku)
    const quantity = posInt(raw.quantity)
    if (!sku || !fnsku || quantity === null || quantity < 1) return null
    lines.push({ sku, fnsku, title: str(raw.title), quantity })
  }
  return { planId, shipmentRowId: str(value.shipmentRowId), size, showTitle: value.showTitle === true, showCondition: value.showCondition === true, lines }
}

// ---------------------------------------------------------------- 商品标签纸
const MM = 72 / 25.4
export const mmToPt = (mm: number) => mm * MM

export const ITEM_LABEL_SIZES = ['THERMAL_60X40', 'THERMAL_50X30', 'THERMAL_40X30', 'A4_21', 'A4_65'] as const
export type ItemLabelSize = (typeof ITEM_LABEL_SIZES)[number]
export interface ItemLabelSizeSpec {
  label: string
  /** 页面宽高（pt）。热敏标签纸一页一张，页面就是标签大小。 */
  pageWidthPt: number
  pageHeightPt: number
  /** 单张标签宽高（pt）。 */
  widthPt: number
  heightPt: number
  cols: number
  rows: number
  /** 第一张标签左上角离页面左上角的距离（pt）。 */
  marginLeftPt: number
  marginTopPt: number
  /** 相邻标签左上角之间的水平、垂直间距（pt）。 */
  pitchXPt: number
  pitchYPt: number
}
const thermal = (label: string, widthMm: number, heightMm: number): ItemLabelSizeSpec => ({
  label,
  pageWidthPt: mmToPt(widthMm),
  pageHeightPt: mmToPt(heightMm),
  widthPt: mmToPt(widthMm),
  heightPt: mmToPt(heightMm),
  cols: 1,
  rows: 1,
  marginLeftPt: 0,
  marginTopPt: 0,
  pitchXPt: mmToPt(widthMm),
  pitchYPt: mmToPt(heightMm),
})
const sheet = (label: string, o: { widthMm: number; heightMm: number; cols: number; rows: number; leftMm: number; topMm: number; pitchXMm: number; pitchYMm: number }): ItemLabelSizeSpec => ({
  label,
  pageWidthPt: mmToPt(210),
  pageHeightPt: mmToPt(297),
  widthPt: mmToPt(o.widthMm),
  heightPt: mmToPt(o.heightMm),
  cols: o.cols,
  rows: o.rows,
  marginLeftPt: mmToPt(o.leftMm),
  marginTopPt: mmToPt(o.topMm),
  pitchXPt: mmToPt(o.pitchXMm),
  pitchYPt: mmToPt(o.pitchYMm),
})
/** 常见标签纸规格；A4 的两种是常见的 21 格（63.5×38.1 毫米）与 65 格（38.1×21.2 毫米）不干胶标签纸版式，实际纸张边距以你买的标签纸为准。 */
export const ITEM_LABEL_SIZE_SPEC: Record<ItemLabelSize, ItemLabelSizeSpec> = {
  THERMAL_60X40: thermal('热敏标签纸 60×40 毫米', 60, 40),
  THERMAL_50X30: thermal('热敏标签纸 50×30 毫米', 50, 30),
  THERMAL_40X30: thermal('热敏标签纸 40×30 毫米', 40, 30),
  A4_21: sheet('A4 不干胶 21 格（63.5×38.1 毫米）', { widthMm: 63.5, heightMm: 38.1, cols: 3, rows: 7, leftMm: 7.2, topMm: 15.1, pitchXMm: 66, pitchYMm: 38.1 }),
  A4_65: sheet('A4 不干胶 65 格（38.1×21.2 毫米）', { widthMm: 38.1, heightMm: 21.2, cols: 5, rows: 13, leftMm: 4.7, topMm: 10.7, pitchXMm: 40.64, pitchYMm: 21.2 }),
}
export const itemLabelsTotal = (lines: ReadonlyArray<Pick<ItemLabelLine, 'quantity'>>) => lines.reduce((sum, line) => sum + line.quantity, 0)

// ---------------------------------------------------------------- 接口响应
export interface LabelGenerateResponse {
  /** 导出任务编号：在导出中心（LABEL_EXPORT_PATH）里看进度并下载。 */
  exportId: string
  status: string
  statusLabel: string
  kindLabel: string
  /** 需要让用户知道的说明（例如哪些内容因为不能确定而没有印）。 */
  notes: string[]
}

/** 页面里“箱号规则”预览用：同 boxNoPreview，带上提示文字。 */
export const boxNoPreviewText = (rule: BoxNoRule, planNo = 'PLAN') => boxNoPreview(rule, planNo, 3).join('、')
