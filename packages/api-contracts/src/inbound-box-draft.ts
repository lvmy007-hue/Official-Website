import { INBOUND_MAX_BOXES, type InboundBoxInput } from './inbound.js'

// 装箱可视编辑器的纯函数（P6-10）：箱子草稿、加箱与复制与批量设箱规、底部实时合计、保存前的本地校验。
// 编辑中的箱子允许还没填完（数字为 null），所以草稿类型与提交给服务端的 `InboundBoxInput` 分开；保存前先用 `boxDraftIssues` 在本地拦下。
// 本文件不带 zod：前端与服务端共用。

export interface BoxDraftItem {
  sku: string
  quantity: number | null
}
export interface BoxDraft {
  /** 编辑器里的稳定标识（箱号可以改，所以不用箱号当键）。 */
  key: string
  boxId: string
  packingGroupId: string | null
  /** 相同箱数：同样尺寸与内容的箱子有几个。 */
  quantity: number | null
  weightLb: number | null
  lengthIn: number | null
  widthIn: number | null
  heightIn: number | null
  items: BoxDraftItem[]
}

export const BOX_SPEC_KEYS = ['weightLb', 'lengthIn', 'widthIn', 'heightIn'] as const
export type BoxSpecKey = (typeof BOX_SPEC_KEYS)[number]
export type BoxSpecs = Partial<Record<BoxSpecKey, number>>
export const BOX_SPEC_LABEL: Record<BoxSpecKey, string> = { weightLb: '重量（磅）', lengthIn: '长（英寸）', widthIn: '宽（英寸）', heightIn: '高（英寸）' }
export const BOX_SPEC_MAX = 100_000
export const BOX_COUNT_MAX = 10_000
export const BOX_ITEMS_MAX = 100
export const BOX_ITEM_QTY_MAX = 1_000_000
const CUBIC_INCHES_PER_CUBIC_FOOT = 1728
export const CUBIC_FEET_TO_CUBIC_METERS = 0.0283168

let sequence = 0
const uid = () => `box-${++sequence}`

/** 取一个没被占用的箱号：BOX-001、BOX-002……（和服务端自动编号的格式一致）。 */
export function nextBoxId(boxes: ReadonlyArray<Pick<BoxDraft, 'boxId'>>): string {
  const used = new Set(boxes.map(box => box.boxId))
  let counter = 1
  while (used.has(`BOX-${String(counter).padStart(3, '0')}`)) counter += 1
  return `BOX-${String(counter).padStart(3, '0')}`
}

/** 服务端读回来的箱子 → 草稿。 */
export function draftsFromServer(boxes: ReadonlyArray<Omit<BoxDraft, 'key'> & { items: BoxDraftItem[] }>): BoxDraft[] {
  return boxes.map(box => ({ ...box, key: uid(), items: box.items.map(item => ({ ...item })) }))
}

/** 新箱：尺寸与重量沿用最后一个箱子（同批货的箱规通常一样），箱内物品留空等用户添加。 */
export function newBoxDraft(boxes: readonly BoxDraft[]): BoxDraft {
  const last = boxes[boxes.length - 1]
  return {
    key: uid(),
    boxId: nextBoxId(boxes),
    packingGroupId: last?.packingGroupId ?? null,
    quantity: 1,
    weightLb: last?.weightLb ?? null,
    lengthIn: last?.lengthIn ?? null,
    widthIn: last?.widthIn ?? null,
    heightIn: last?.heightIn ?? null,
    items: [],
  }
}

/** 复制一个箱子：插在原箱子后面，换新箱号，箱规与箱内物品照抄。找不到原箱子时原样返回。 */
export function copyBoxDraft(boxes: readonly BoxDraft[], key: string): BoxDraft[] {
  const index = boxes.findIndex(box => box.key === key)
  if (index < 0) return [...boxes]
  const source = boxes[index]
  const copy: BoxDraft = { ...source, key: uid(), boxId: nextBoxId(boxes), items: source.items.map(item => ({ ...item })) }
  return [...boxes.slice(0, index + 1), copy, ...boxes.slice(index + 1)]
}

/** 批量设箱规：只改给了值的项，其余保持不变。 */
export function applyBoxSpecs(boxes: readonly BoxDraft[], keys: ReadonlySet<string>, specs: BoxSpecs): BoxDraft[] {
  return boxes.map(box => {
    if (!keys.has(box.key)) return box
    const next = { ...box }
    for (const spec of BOX_SPEC_KEYS) if (specs[spec] !== undefined) next[spec] = specs[spec]!
    return next
  })
}

/** 一个箱子（含相同箱数）的体积，立方英寸；尺寸没填全为 null。 */
export const boxVolumeCubicInches = (box: Pick<BoxDraft, 'lengthIn' | 'widthIn' | 'heightIn'>): number | null =>
  box.lengthIn !== null && box.widthIn !== null && box.heightIn !== null ? box.lengthIn * box.widthIn * box.heightIn : null

/** 一个箱子里一箱装的件数。 */
export const boxUnitsPerBox = (box: Pick<BoxDraft, 'items'>): number => box.items.reduce((sum, item) => sum + (item.quantity ?? 0), 0)

export interface BoxTotalsSku {
  sku: string
  planned: number
  packed: number
  /** 已装减计划：不为 0 的标红。 */
  diff: number
}
export interface BoxTotals {
  /** 箱子总数（相同箱数相加）与箱型数（草稿里的行数）。 */
  boxCount: number
  boxTypes: number
  packedUnits: number
  plannedUnits: number
  skuRows: BoxTotalsSku[]
  /** 装了但不在计划里的 SKU。 */
  unknownSkus: string[]
  /** 重量、体积只合计已填全的箱子；`incompleteBoxes` 是没填全的箱型数，页面据此提示“合计不完整”。 */
  totalWeightLb: number | null
  totalVolumeCubicFeet: number | null
  incompleteBoxes: number
  /** 每个 SKU 的已装数与计划数都一致，且没有未知 SKU。 */
  matched: boolean
}

const round3 = (value: number) => Math.round(value * 1000) / 1000

/** 底部实时合计：已装件数与计划件数按 SKU 对比，箱数、总重、总体积。 */
export function boxDraftTotals(boxes: readonly BoxDraft[], planItems: ReadonlyArray<{ sku: string; quantity: number }>): BoxTotals {
  const packed = new Map<string, number>()
  const known = new Set(planItems.map(item => item.sku))
  const unknown = new Set<string>()
  let boxCount = 0
  let weight = 0
  let volume = 0
  let weighed = 0
  let measured = 0
  let incomplete = 0
  for (const box of boxes) {
    const count = box.quantity ?? 0
    boxCount += count
    for (const item of box.items) {
      if (!item.sku) continue
      if (!known.has(item.sku)) unknown.add(item.sku)
      packed.set(item.sku, (packed.get(item.sku) ?? 0) + (item.quantity ?? 0) * count)
    }
    const cubic = boxVolumeCubicInches(box)
    if (box.weightLb === null || cubic === null || box.quantity === null) incomplete += 1
    if (box.weightLb !== null && box.quantity !== null) {
      weight += box.weightLb * count
      weighed += 1
    }
    if (cubic !== null && box.quantity !== null) {
      volume += cubic * count
      measured += 1
    }
  }
  const skuRows = planItems.map(item => ({ sku: item.sku, planned: item.quantity, packed: packed.get(item.sku) ?? 0, diff: (packed.get(item.sku) ?? 0) - item.quantity }))
  return {
    boxCount,
    boxTypes: boxes.length,
    packedUnits: [...packed.values()].reduce((sum, value) => sum + value, 0),
    plannedUnits: planItems.reduce((sum, item) => sum + item.quantity, 0),
    skuRows,
    unknownSkus: [...unknown],
    totalWeightLb: weighed > 0 ? round3(weight) : null,
    totalVolumeCubicFeet: measured > 0 ? round3(volume / CUBIC_INCHES_PER_CUBIC_FOOT) : null,
    incompleteBoxes: incomplete,
    matched: unknown.size === 0 && skuRows.every(row => row.diff === 0),
  }
}

const positive = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 && value <= BOX_SPEC_MAX

/**
 * 保存前的本地校验：返回会被服务端拒绝的问题（空数组表示可以保存）。
 * 数量与计划不一致不在这里拦——草稿允许先存着，提交给亚马逊前才强制对齐，页面用 `boxDraftTotals` 标红提示。
 */
export function boxDraftIssues(boxes: readonly BoxDraft[], planItems: ReadonlyArray<{ sku: string }>): string[] {
  const issues: string[] = []
  if (boxes.length === 0) return ['至少添加一个箱子']
  if (boxes.length > INBOUND_MAX_BOXES) issues.push(`箱型最多 ${INBOUND_MAX_BOXES} 个，现在有 ${boxes.length} 个`)
  const known = new Set(planItems.map(item => item.sku))
  const seen = new Set<string>()
  boxes.forEach((box, index) => {
    const label = box.boxId.trim() || `第 ${index + 1} 箱`
    if (!box.boxId.trim()) issues.push(`第 ${index + 1} 箱没有箱号`)
    else if (box.boxId.length > 40) issues.push(`${label} 的箱号太长（最多 40 个字）`)
    else if (seen.has(box.boxId.trim())) issues.push(`箱号 ${label} 重复`)
    seen.add(box.boxId.trim())
    if (box.quantity === null || !Number.isInteger(box.quantity) || box.quantity < 1 || box.quantity > BOX_COUNT_MAX) issues.push(`${label} 的相同箱数要是 1 到 ${BOX_COUNT_MAX} 的整数`)
    for (const spec of BOX_SPEC_KEYS) if (!positive(box[spec])) issues.push(`${label} 的${BOX_SPEC_LABEL[spec]}要填大于 0 的数字`)
    if (box.items.length === 0) issues.push(`${label} 里还没有商品`)
    if (box.items.length > BOX_ITEMS_MAX) issues.push(`${label} 里的商品最多 ${BOX_ITEMS_MAX} 种`)
    const skus = new Set<string>()
    for (const item of box.items) {
      if (!item.sku) issues.push(`${label} 里有商品没选 SKU`)
      else if (!known.has(item.sku)) issues.push(`${label} 里的 ${item.sku} 不在这个计划里`)
      else if (skus.has(item.sku)) issues.push(`${label} 里 ${item.sku} 重复`)
      skus.add(item.sku)
      if (item.quantity === null || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > BOX_ITEM_QTY_MAX) issues.push(`${label} 里 ${item.sku || '商品'} 的数量要是大于 0 的整数`)
    }
  })
  return issues
}

/** 通过 `boxDraftIssues` 之后，把草稿转成提交给服务端的箱子（调用前必须已校验）。 */
export function boxDraftsToInputs(boxes: readonly BoxDraft[]): InboundBoxInput[] {
  return boxes.map(box => ({
    boxId: box.boxId.trim(),
    ...(box.packingGroupId ? { packingGroupId: box.packingGroupId } : {}),
    quantity: box.quantity as number,
    weightLb: box.weightLb as number,
    lengthIn: box.lengthIn as number,
    widthIn: box.widthIn as number,
    heightIn: box.heightIn as number,
    items: box.items.map(item => ({ sku: item.sku, quantity: item.quantity as number })),
  }))
}
