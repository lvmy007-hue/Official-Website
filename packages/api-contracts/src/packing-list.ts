// 供应商装箱单的列识别（P6-11，16 章 5.1）：把表头认成标准列（箱号、货号、品名、数量、每箱件数、箱数、尺寸、重量），并识别尺寸与重量的单位。
// 纯函数，不带 zod：服务端预览与应用、页面显示共用同一份规则。表头认中英文别名；识别不了的列让用户手动指定。

export const PACKING_FIELDS = ['boxNo', 'code', 'name', 'totalQty', 'perBox', 'boxCount', 'dimensions', 'length', 'width', 'height', 'weight'] as const
export type PackingField = (typeof PACKING_FIELDS)[number]

export const PACKING_FIELD_LABEL: Record<PackingField, string> = {
  boxNo: '箱号',
  code: '货号',
  name: '品名',
  totalQty: '数量（总数）',
  perBox: '每箱件数',
  boxCount: '箱数',
  dimensions: '尺寸（长×宽×高 写在一格）',
  length: '长',
  width: '宽',
  height: '高',
  weight: '重量（每箱）',
}
export const PACKING_FIELD_HINT: Record<PackingField, string> = {
  boxNo: '同一箱号的多行合并成一个箱子；写成“1-5”表示第 1 到第 5 箱规格相同；这一列可以没有',
  code: '供应商自己的货号，也可以是条码；货号与品名至少要有一列',
  name: '没有货号时用品名去匹配',
  totalQty: '这一行商品的数量；没有“每箱件数”时，按这个数量算',
  perBox: '每个箱子里装多少件',
  boxCount: '这种箱子有几箱',
  dimensions: '例如 60*40*30；与长、宽、高二选一',
  length: '外箱长',
  width: '外箱宽',
  height: '外箱高',
  weight: '每箱毛重；没有时可以在页面上填默认箱规',
}

/** 列的位置：列序号（从 0 起）；null 表示明确“没有这一列”（不要再自动识别）。没有出现的字段按自动识别。 */
export type PackingColumns = Partial<Record<PackingField, number | null>>

export const LENGTH_UNITS = ['CM', 'IN'] as const
export const WEIGHT_UNITS = ['KG', 'LB'] as const
export type LengthUnit = (typeof LENGTH_UNITS)[number]
export type WeightUnit = (typeof WEIGHT_UNITS)[number]
export interface PackingUnits {
  length: LengthUnit
  weight: WeightUnit
}
/** 国内供应商的装箱单默认是厘米与千克；表头里写了单位（例如“毛重(kg)”“长(in)”）就按表头。 */
export const DEFAULT_PACKING_UNITS: PackingUnits = { length: 'CM', weight: 'KG' }
export const LENGTH_UNIT_LABEL: Record<LengthUnit, string> = { CM: '厘米', IN: '英寸' }
export const WEIGHT_UNIT_LABEL: Record<WeightUnit, string> = { KG: '千克', LB: '磅' }
export type PackingUnitsSource = 'REQUEST' | 'SAVED' | 'HEADER' | 'DEFAULT'
export const PACKING_UNITS_SOURCE_LABEL: Record<PackingUnitsSource, string> = { REQUEST: '本次选择', SAVED: '该供应商保存的设置', HEADER: '装箱单表头里写的单位', DEFAULT: '默认（厘米、千克）' }

/** 入仓接口用英寸与磅：换算后保留两位小数。 */
export const CM_PER_INCH = 2.54
export const LB_PER_KG = 2.2046226218
export const toInches = (value: number, unit: LengthUnit): number => Math.round((unit === 'CM' ? value / CM_PER_INCH : value) * 100) / 100
export const toPounds = (value: number, unit: WeightUnit): number => Math.round((unit === 'KG' ? value * LB_PER_KG : value) * 100) / 100

export const PACKING_MAX_ROWS = 2000
export const PACKING_MAX_COLUMNS = 60
export const PACKING_MAX_BOXES = 500
/** 表头最多往下找多少行（装箱单顶部常有公司名、标题、日期）。 */
export const PACKING_HEADER_SCAN_ROWS = 30
export const PACKING_SPEC_MAX = 100_000

/** 表头别名：按重要程度排序，同一个字段有多列都认得时取排在前面的（例如“毛重”优先于“重量”）。写法已是归一化后的样子。 */
const ALIASES: Record<PackingField, readonly string[]> = {
  boxNo: ['箱号', '箱子编号', '箱编号', '箱子号', '纸箱号', '外箱号', '箱序号', 'ctnno', 'ctnnumber', 'cartonno', 'cartonnumber', 'cartonid', 'boxno', 'boxid', 'boxnumber', 'box'],
  code: [
    '货号',
    '商品货号',
    '产品货号',
    '款号',
    '型号',
    '料号',
    '物料编码',
    '产品编码',
    '商品编码',
    '编码',
    '商品条码',
    '产品条码',
    '条形码',
    '条码',
    'sku',
    '卖家sku',
    'sellersku',
    '商品sku',
    'itemno',
    'itemcode',
    'itemnumber',
    'partno',
    'partnumber',
    'productcode',
    'modelno',
    'model',
    'articleno',
    'article',
    'styleno',
    'style',
    'barcode',
    'upc',
    'ean',
    'fnsku',
    'asin',
    'suppliersku',
  ],
  name: ['品名', '商品名称', '产品名称', '货物名称', '商品名', '产品名', '品名规格', '名称', '商品描述', '产品描述', '描述', 'productname', 'itemname', 'goodsname', 'description', 'name', 'title'],
  totalQty: ['总数量', '数量', '总数', '总件数', '合计数量', '订购数量', '发货数量', '总数量pcs', '数量pcs', '数量件', 'totalqty', 'totalquantity', 'totalunits', 'quantity', 'qty', 'pcs', 'units'],
  perBox: [
    '每箱数量',
    '每箱件数',
    '每箱装',
    '每箱装量',
    '装箱数',
    '装箱量',
    '单箱数量',
    '箱入数',
    '入数',
    '每箱pcs',
    'unitspercarton',
    'unitsperbox',
    'qtyperctn',
    'qtypercarton',
    'qtyperbox',
    'pcsperctn',
    'pcsperbox',
    'perbox',
  ],
  boxCount: [
    '箱数',
    '总箱数',
    '相同箱数',
    '整箱数',
    '纸箱数',
    '外箱数',
    '件数',
    '箱量',
    'ctns',
    'cartons',
    'numberofcartons',
    'numberofboxes',
    'noofcartons',
    'nofcartons',
    'noofctns',
    'noofboxes',
    'totalcartons',
    'totalctns',
    'cartoncount',
    'boxcount',
    'boxes',
    'cases',
    'ctnqty',
  ],
  dimensions: ['外箱尺寸', '箱子尺寸', '纸箱尺寸', '包装尺寸', '尺寸', '外箱规格', '箱规', 'dimensions', 'dimension', 'cartonsize', 'cartondimension', 'boxsize', 'size', 'measurement', 'meas'],
  length: ['外箱长', '外箱长度', '箱长', '长度', '长', 'length', 'len', 'l'],
  width: ['外箱宽', '外箱宽度', '箱宽', '宽度', '宽', 'width', 'wid', 'w'],
  height: ['外箱高', '外箱高度', '箱高', '高度', '高', 'height', 'hgt', 'h'],
  weight: ['毛重', '单箱毛重', '每箱毛重', '单箱重量', '每箱重量', '箱重', '重量', '外箱重量', 'grossweight', 'gweight', 'gw', 'weight', 'wt'],
}

/** 表头归一化：去掉空白、括号、连接符、点号，转小写。 */
export const normalizeHeader = (text: string): string => text.toLowerCase().replace(/[\s_()（）[\]【】\-./\\:：*＊"'`]+/g, '')

/** 表头末尾的单位词（“长(cm)”归一化后是“长cm”），去掉后再认。 */
const UNIT_SUFFIX = /(cm|厘米|公分|inches|inch|in|英寸|英吋|kgs|kg|千克|公斤|lbs|lb|磅)$/

export const PACKING_ALIASES: Record<PackingField, readonly string[]> = Object.fromEntries(PACKING_FIELDS.map(field => [field, ALIASES[field].map(normalizeHeader)])) as unknown as Record<
  PackingField,
  readonly string[]
>

/** 一个表头对某个字段的匹配名次（越小越准，-1 表示不是这个字段）。 */
export function aliasRank(field: PackingField, header: string): number {
  const full = normalizeHeader(header)
  if (!full) return -1
  const stripped = full.replace(UNIT_SUFFIX, '')
  const aliases = PACKING_ALIASES[field]
  const hit = (text: string) => (text ? aliases.indexOf(text) : -1)
  const direct = hit(full)
  if (direct >= 0) return direct
  return stripped !== full ? hit(stripped) : -1
}

/** 表头里写的单位：厘米、英寸、千克、磅（认不出返回 null）。 */
export function unitOfHeader(header: string): { length?: LengthUnit; weight?: WeightUnit } {
  const text = header.toLowerCase()
  const unit: { length?: LengthUnit; weight?: WeightUnit } = {}
  if (/(^|[^a-z])cm([^a-z]|$)|厘米|公分/.test(text)) unit.length = 'CM'
  else if (/(^|[^a-z])in(ch(es)?)?([^a-z]|$)|英寸|英吋|"/.test(text)) unit.length = 'IN'
  if (/(^|[^a-z])kgs?([^a-z]|$)|千克|公斤/.test(text)) unit.weight = 'KG'
  else if (/(^|[^a-z])lbs?([^a-z]|$)|磅/.test(text)) unit.weight = 'LB'
  return unit
}

export interface DetectedColumns {
  columns: PackingColumns
  /** 表头里写了的单位（尺寸类列与重量列）。 */
  unitHints: { length?: LengthUnit; weight?: WeightUnit }
}

/** 按表头识别各字段所在的列：每一列最多归一个字段，字段按固定顺序认领，同字段多列取别名名次靠前的。 */
export function detectColumns(headers: readonly string[]): DetectedColumns {
  const columns: PackingColumns = {}
  const claimed = new Set<number>()
  for (const field of PACKING_FIELDS) {
    let bestIndex = -1
    let bestRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index] ?? ''
      if (claimed.has(index) || !header.trim()) continue
      const rank = aliasRank(field, header)
      if (rank >= 0 && rank < bestRank) {
        bestIndex = index
        bestRank = rank
      }
    }
    if (bestIndex >= 0) {
      columns[field] = bestIndex
      claimed.add(bestIndex)
    }
  }
  const unitHints: DetectedColumns['unitHints'] = {}
  for (const field of ['dimensions', 'length', 'width', 'height', 'weight'] as const) {
    const index = columns[field]
    if (typeof index !== 'number') continue
    const unit = unitOfHeader(headers[index] ?? '')
    if (field === 'weight' ? unit.weight : unit.length) Object.assign(unitHints, field === 'weight' ? { weight: unit.weight } : { length: unit.length })
  }
  return { columns, unitHints }
}

/** 一行表头认出了几个字段（找表头行时用）。 */
export const headerScore = (cells: readonly string[]): number => Object.keys(detectColumns(cells).columns).length

/**
 * 在表的前几行里找表头行（下标从 0 起）：认出字段最多的一行，并列取靠前的；
 * 至少要认出两个字段，认不出时返回 -1（调用方让用户指定表头在第几行）。
 */
export function detectHeaderRow(table: readonly (readonly string[])[]): number {
  let best = -1
  let bestScore = 1
  table.slice(0, PACKING_HEADER_SCAN_ROWS).forEach((cells, index) => {
    const score = headerScore(cells)
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  })
  return best
}

/** 保存的列映射（表头文字）换成这一份文件里的列序号；表头在这份文件里找不到的字段列在 missing 里。 */
export function columnsFromSaved(headers: readonly string[], saved: Partial<Record<PackingField, string>>): { columns: PackingColumns; missing: string[] } {
  const columns: PackingColumns = {}
  const missing: string[] = []
  const normalized = headers.map(normalizeHeader)
  for (const field of PACKING_FIELDS) {
    const header = saved[field]
    if (!header) continue
    const index = normalized.indexOf(normalizeHeader(header))
    if (index >= 0) columns[field] = index
    else missing.push(header)
  }
  return { columns, missing }
}

/** 最终生效的列换成表头文字（保存列映射用）。 */
export function savedFromColumns(headers: readonly string[], columns: PackingColumns): Partial<Record<PackingField, string>> {
  const saved: Partial<Record<PackingField, string>> = {}
  for (const field of PACKING_FIELDS) {
    const index = columns[field]
    const header = typeof index === 'number' ? headers[index]?.trim() : ''
    if (header) saved[field] = header
  }
  return saved
}

/** 缺哪些必需的字段：货号与品名至少一个；每箱件数、数量至少一个。 */
export function missingPackingFields(columns: PackingColumns): string[] {
  const has = (field: PackingField) => typeof columns[field] === 'number'
  const missing: string[] = []
  if (!has('code') && !has('name')) missing.push('货号或品名')
  if (!has('perBox') && !has('totalQty')) missing.push('每箱件数或数量')
  return missing
}
