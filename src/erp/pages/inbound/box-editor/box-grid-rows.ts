import { boxUnitsPerBox, boxVolumeCubicInches, type BoxDraft } from '@nova/api-contracts'

// 装箱编辑器表格的行（P6-10）：每个箱型一行，箱内商品作为它的子行（表格的“行内展开”）。
// 数字没填的格子保持 null，由表格显示成“—”，不会写成 0。

export type BoxGridRow = {
  id: string
  kind: 'box' | 'item'
  boxKey: string
  /** 箱子行显示箱号，商品行显示 SKU。 */
  name: string
  /** 相同箱数（只有箱子行有）。 */
  boxCount: number | null
  /** 每箱件数：箱子行是箱内合计，商品行是这个商品每箱的数量。 */
  unitsPerBox: number | null
  /** 合计件数 = 每箱件数 × 相同箱数。 */
  units: number | null
  weightLb: number | null
  dims: string
  /** 单个箱子的体积（立方英尺）。 */
  volumeCuFt: number | null
  status: string
  children?: BoxGridRow[]
}

const CUBIC_INCHES_PER_CUBIC_FOOT = 1728
const times = (left: number | null, right: number | null) => (left === null || right === null ? null : left * right)

function statusOf(box: BoxDraft, unknown: ReadonlySet<string>): string {
  if (box.items.length === 0) return '没有商品'
  if (box.items.some(item => item.sku && unknown.has(item.sku))) return '含计划外 SKU'
  if (box.quantity === null || box.weightLb === null || boxVolumeCubicInches(box) === null || box.items.some(item => !item.sku || item.quantity === null)) return '未填全'
  return '完整'
}

export function boxGridRows(boxes: readonly BoxDraft[], planSkus: ReadonlySet<string>): BoxGridRow[] {
  const unknown = new Set<string>()
  for (const box of boxes) for (const item of box.items) if (item.sku && !planSkus.has(item.sku)) unknown.add(item.sku)
  return boxes.map(box => {
    const cubic = boxVolumeCubicInches(box)
    const children = box.items.map<BoxGridRow>((item, index) => ({
      id: `${box.key}:${index}:${item.sku}`,
      kind: 'item',
      boxKey: box.key,
      name: item.sku || '（未选 SKU）',
      boxCount: null,
      unitsPerBox: item.quantity,
      units: times(item.quantity, box.quantity),
      weightLb: null,
      dims: '',
      volumeCuFt: null,
      status: item.sku && unknown.has(item.sku) ? '不在计划内' : '',
    }))
    return {
      id: box.key,
      kind: 'box',
      boxKey: box.key,
      name: box.boxId || '（未填箱号）',
      boxCount: box.quantity,
      unitsPerBox: boxUnitsPerBox(box),
      units: times(boxUnitsPerBox(box), box.quantity),
      weightLb: box.weightLb,
      dims: box.lengthIn !== null && box.widthIn !== null && box.heightIn !== null ? `${box.lengthIn}×${box.widthIn}×${box.heightIn}` : '',
      volumeCuFt: cubic === null ? null : Math.round((cubic / CUBIC_INCHES_PER_CUBIC_FOOT) * 1000) / 1000,
      status: statusOf(box, unknown),
      children,
    }
  })
}
