import type { InboundBoxInput } from './inbound.js'

// 箱内物品批量导入的文本解析（P2a-12）：纯函数，页面预览与服务端校验共用。

/**
 * 解析批量导入的箱内物品文本（逗号或制表符分隔，可带表头）。列：箱号、SKU、每箱数量、重量(磅)、长(英寸)、宽、高、相同箱数（可省略，默认 1）。
 * 同一箱号的多行合并成一个箱子（装多种商品），箱子的尺寸与重量取第一行，后面的行必须一致或留空。出错的行整份拒绝，逐行给出原因。
 */
export function parseBoxLines(text: string): { boxes: InboundBoxInput[]; errors: Array<{ line: number; message: string }> } {
  const errors: Array<{ line: number; message: string }> = []
  const boxes = new Map<string, InboundBoxInput>()
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = index + 1
    if (!raw.trim()) return
    const cells = raw.split(/[,\t]/).map(cell => cell.trim())
    // 第一行是表头才跳过：表头里数量、重量、尺寸都是文字；SKU 名字里带 “sku” 的数据行不能被当成表头丢掉。
    if (index === 0 && /sku|商品|箱号/i.test(cells.join(',')) && cells.slice(2, 7).every(cell => !Number.isFinite(Number(cell)) || cell === '')) return
    if (cells.length < 7) return void errors.push({ line, message: '列数不够：需要 箱号、SKU、每箱数量、重量、长、宽、高（相同箱数可省略）' })
    const [boxId, sku, qty, weight, length, width, height, count] = cells
    const number = (value: string | undefined) => (value === undefined || value === '' ? NaN : Number(value))
    const quantity = number(qty)
    if (!boxId || !sku) return void errors.push({ line, message: '箱号与 SKU 必填' })
    if (!Number.isInteger(quantity) || quantity < 1) return void errors.push({ line, message: '每箱数量必须是大于 0 的整数' })
    const dims = [number(weight), number(length), number(width), number(height)]
    const repeat = count ? number(count) : 1
    if (dims.some(value => !(value > 0))) return void errors.push({ line, message: '重量、长、宽、高必须是大于 0 的数字' })
    if (!Number.isInteger(repeat) || repeat < 1) return void errors.push({ line, message: '相同箱数必须是大于 0 的整数' })
    const existing = boxes.get(boxId)
    if (!existing) return void boxes.set(boxId, { boxId, quantity: repeat, weightLb: dims[0], lengthIn: dims[1], widthIn: dims[2], heightIn: dims[3], items: [{ sku, quantity }] })
    if (existing.weightLb !== dims[0] || existing.lengthIn !== dims[1] || existing.widthIn !== dims[2] || existing.heightIn !== dims[3] || existing.quantity !== repeat)
      return void errors.push({ line, message: `箱 ${boxId} 的重量、尺寸或相同箱数与前面的行不一致` })
    if (existing.items.some(item => item.sku === sku)) return void errors.push({ line, message: `箱 ${boxId} 里 ${sku} 重复` })
    existing.items.push({ sku, quantity })
  })
  return { boxes: errors.length ? [] : [...boxes.values()], errors }
}
