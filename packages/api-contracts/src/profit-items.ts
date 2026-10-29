import { FEE_CATEGORY_LABEL, feeSubtypeLabel, type FeeCategory } from './fee-events.js'
import { BRIDGE_DEFS, type BridgeKey } from './profit.js'
import { bridgeTargetOfLine, type LineTarget } from './profit-math.js'

// 利润项目字典（P6-18，16 章第 7 节；freeze/models.md `ProfitItem`、`ProfitItemMapping`）：三层“原始交易类型 → 二级项目 → 一级项目”。
// 纯类型、常量与纯函数（零 zod，前端可引用）；请求校验在 profit-items-query.ts，整树校验在 profit-items-tree.ts。
//
// 口径：
//  - 交易类型 = 费用事件的“分类/子类型”（例如 COMMISSION/ReferralFee、NON_FEE/Principal），没有子类型时只有分类；
//  - 每个项目最终落到利润桥的某个项目上（系统项目自带；自定义项目沿用最近一个带 systemKey 的祖先，没有就按分组的默认口径），
//    所以改映射只在利润桥项目之间挪金额，净利润不变（税是例外：代收代缴税不计入利润，映射到它的明细不进利润日表）；
//  - 没有映射的交易类型仍按内置口径计入利润日表，不丢，同时单独列出提醒补全；
//  - 金额一律是对净利润的带符号贡献（收入为正、花费为负），与费用明细在表里的符号一致。

export const PROFIT_ITEM_READ = 'finance.read'
export const PROFIT_ITEM_MANAGE = 'finance.profititem.manage'
export const PROFIT_ITEM_ACTIONS = { saved: 'PROFIT_ITEMS_SAVED' } as const
export const PROFIT_DICTIONARY_KIND = 'PROFIT_DICTIONARY'
export const PROFIT_ITEM_LIMITS = { maxItems: 200, maxDepth: 3, nameMax: 40, maxMappings: 5000, pageSizeMax: 200, discoverDays: 90, countDays: 30, discoverMax: 5000 } as const

export const PROFIT_ITEM_GROUPS = ['REVENUE', 'PLATFORM_FEE', 'LOGISTICS_FEE', 'ADS', 'PRODUCT_COST', 'OTHER'] as const
export type ProfitItemGroup = (typeof PROFIT_ITEM_GROUPS)[number]
export const PROFIT_ITEM_GROUP_LABEL: Readonly<Record<ProfitItemGroup, string>> = {
  REVENUE: '收入',
  PLATFORM_FEE: '平台费用',
  LOGISTICS_FEE: '物流费用',
  ADS: '广告',
  PRODUCT_COST: '商品成本',
  OTHER: '其他',
}

/** 交易明细能映射到的利润桥项目（与 bridgeTargetOfLine 的返回值一致），EXCLUDED 是代收代缴税（不计入利润）。 */
export const LINE_TARGETS = [
  'REVENUE',
  'REFUNDS',
  'COMMISSION',
  'FULFILLMENT',
  'STORAGE',
  'AGED_SURCHARGE',
  'INBOUND_PLACEMENT',
  'OTHER_FEES',
  'PROMOTION',
  'REIMBURSEMENT',
  'EXCLUDED',
] as const satisfies readonly LineTarget[]
const LINE_TARGET_SET: ReadonlySet<string> = new Set(LINE_TARGETS)
export const isLineTarget = (value: string | null | undefined): value is LineTarget => value !== null && value !== undefined && LINE_TARGET_SET.has(value)

/** 分组的默认口径：自定义项目直接挂在一级项目下、自己没有 systemKey 时，计入的利润桥项目。广告与商品成本不接收交易明细。 */
export const GROUP_DEFAULT_TARGET: Readonly<Record<ProfitItemGroup, LineTarget | null>> = {
  REVENUE: 'REVENUE',
  PLATFORM_FEE: 'OTHER_FEES',
  LOGISTICS_FEE: 'OTHER_FEES',
  ADS: null,
  PRODUCT_COST: null,
  OTHER: 'OTHER_FEES',
}

export interface SystemItemDef {
  /** 写进 ProfitItem.systemKey：一级项目是 G_ 开头，二级项目是利润桥项目的键（BridgeKey）或 EXCLUDED。 */
  key: string
  parent: string | null
  name: string
  group: ProfitItemGroup
  sign: 1 | -1
  sort: number
}

const group = (key: string, name: string, groupKey: ProfitItemGroup, sign: 1 | -1, sort: number): SystemItemDef => ({ key, parent: null, name, group: groupKey, sign, sort })
const leaf = (key: string, parent: string, groupKey: ProfitItemGroup, sign: 1 | -1, sort: number, name?: string): SystemItemDef => ({
  key,
  parent,
  name: name ?? BRIDGE_DEFS[key as BridgeKey].label,
  group: groupKey,
  sign,
  sort,
})

/** 第一版系统字典：一级项目 6 个（分组），二级项目 = 利润桥各项（外加代收代缴税）。系统项目不能删除，可以改名。 */
export const SYSTEM_PROFIT_ITEMS: readonly SystemItemDef[] = [
  group('G_REVENUE', '收入', 'REVENUE', 1, 10),
  leaf('REVENUE', 'G_REVENUE', 'REVENUE', 1, 10),
  leaf('REFUNDS', 'G_REVENUE', 'REVENUE', -1, 20),
  leaf('PROMOTION', 'G_REVENUE', 'REVENUE', -1, 30),
  group('G_PLATFORM', '平台费用', 'PLATFORM_FEE', -1, 20),
  leaf('COMMISSION', 'G_PLATFORM', 'PLATFORM_FEE', -1, 10),
  leaf('OTHER_FEES', 'G_PLATFORM', 'PLATFORM_FEE', -1, 20),
  group('G_LOGISTICS', '物流费用', 'LOGISTICS_FEE', -1, 30),
  leaf('FULFILLMENT', 'G_LOGISTICS', 'LOGISTICS_FEE', -1, 10),
  leaf('STORAGE', 'G_LOGISTICS', 'LOGISTICS_FEE', -1, 20),
  leaf('AGED_SURCHARGE', 'G_LOGISTICS', 'LOGISTICS_FEE', -1, 30),
  leaf('INBOUND_PLACEMENT', 'G_LOGISTICS', 'LOGISTICS_FEE', -1, 40),
  leaf('FIRST_MILE', 'G_LOGISTICS', 'LOGISTICS_FEE', -1, 50),
  leaf('DUTY', 'G_LOGISTICS', 'LOGISTICS_FEE', -1, 60),
  group('G_ADS', '广告', 'ADS', -1, 40),
  leaf('ADS', 'G_ADS', 'ADS', -1, 10),
  group('G_COST', '商品成本', 'PRODUCT_COST', -1, 50),
  leaf('PRODUCT_COST', 'G_COST', 'PRODUCT_COST', -1, 10),
  group('G_OTHER', '其他', 'OTHER', 1, 60),
  leaf('REIMBURSEMENT', 'G_OTHER', 'OTHER', 1, 10),
  leaf('OTHER_COST', 'G_OTHER', 'OTHER', -1, 20),
  leaf('EXCLUDED', 'G_OTHER', 'OTHER', 1, 30, '代收代缴税（不计入利润）'),
]
export const SYSTEM_ITEM_BY_KEY: ReadonlyMap<string, SystemItemDef> = new Map(SYSTEM_PROFIT_ITEMS.map(item => [item.key, item]))

/** 数据来源不是交易明细的系统项目：金额来自利润日表的列（广告、采购成本、头程、关税、其他成本），不接收交易类型映射。 */
export const NON_TRANSACTION_KEYS: readonly string[] = ['ADS', 'PRODUCT_COST', 'FIRST_MILE', 'DUTY', 'OTHER_COST']

// ---- 交易类型 ----

export const transactionTypeKey = (category: string, subtype: string | null | undefined): string => (subtype ? `${category}/${subtype}` : category)
export function splitTransactionType(key: string): { category: string; subtype: string | null } {
  const index = key.indexOf('/')
  return index < 0 ? { category: key, subtype: null } : { category: key.slice(0, index), subtype: key.slice(index + 1) || null }
}
/** 交易类型的易读名称：分类中文名（认不出的分类原样显示）加子类型的易读写法。 */
export function transactionTypeLabel(key: string): string {
  const { category, subtype } = splitTransactionType(key)
  const base = category === 'NON_FEE' ? '非费用（销售收入、税、运费收入等）' : (FEE_CATEGORY_LABEL[category as FeeCategory] ?? category)
  const detail = feeSubtypeLabel(subtype)
  return detail ? `${base} · ${detail}` : base
}
/** 内置口径下这个交易类型归到的利润桥项目（第一版映射就是按它生成的）。 */
export const defaultTargetOfType = (key: string): LineTarget => bridgeTargetOfLine(splitTransactionType(key))

// ---- 项目与归属 ----

export interface ProfitItemNode {
  id: string
  parentId: string | null
  group: string
  systemKey: string | null
}

/** 一个项目计入的利润桥项目：自己或最近的祖先带 systemKey 时按它；系统一级项目与没有 systemKey 的链按分组默认；不接收交易明细的返回 null。 */
export function effectiveTargetOf(item: ProfitItemNode, byId: ReadonlyMap<string, ProfitItemNode>): LineTarget | null {
  let current: ProfitItemNode | undefined = item
  for (let depth = 0; current && depth < PROFIT_ITEM_LIMITS.maxDepth + 1; depth += 1) {
    const key = current.systemKey
    if (key !== null) {
      if (isLineTarget(key)) return key
      if (NON_TRANSACTION_KEYS.includes(key)) return null
      const system = SYSTEM_ITEM_BY_KEY.get(key)
      return GROUP_DEFAULT_TARGET[(system?.group ?? current.group) as ProfitItemGroup] ?? null
    }
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return GROUP_DEFAULT_TARGET[item.group as ProfitItemGroup] ?? null
}

/** 未映射的交易类型在 itemAmounts 里的键：按内置口径计入的利润桥项目。 */
export const UNMAPPED_PREFIX = '~:'
export const unmappedKeyOf = (target: LineTarget): string => `${UNMAPPED_PREFIX}${target}`
export const isUnmappedKey = (key: string): boolean => key.startsWith(UNMAPPED_PREFIX)

export interface DictionaryResolution {
  target: LineTarget
  /** 写进 itemAmounts 的键：映射到的项目编号，或未映射时的 `~:目标`。 */
  itemKey: string
  mapped: boolean
}
/** 利润日表派生任务用的解析器：映射了就按项目的口径，没映射（或映射到的项目已不接收交易）就按内置口径，并打上“未映射”键。 */
export function buildDictionaryResolver(
  items: readonly ProfitItemNode[],
  mappings: ReadonlyArray<{ transactionType: string; itemId: string }>,
): (category: string, subtype: string | null | undefined) => DictionaryResolution {
  const byId = new Map(items.map(item => [item.id, item]))
  const resolved = new Map<string, { target: LineTarget; itemId: string }>()
  for (const mapping of mappings) {
    const item = byId.get(mapping.itemId)
    const target = item ? effectiveTargetOf(item, byId) : null
    if (item && target) resolved.set(mapping.transactionType, { target, itemId: item.id })
  }
  return (category, subtype) => {
    const hit = resolved.get(transactionTypeKey(category, subtype))
    if (hit) return { target: hit.target, itemKey: hit.itemId, mapped: true }
    const target = bridgeTargetOfLine({ category, subtype })
    return { target, itemKey: unmappedKeyOf(target), mapped: false }
  }
}

// ---- 接口形状 ----

export interface ProfitItemRow {
  id: string
  parentId: string | null
  level: number
  name: string
  group: ProfitItemGroup
  groupLabel: string
  sign: 1 | -1
  isSystem: boolean
  systemKey: string | null
  sort: number
  /** 这个项目自己（不含子项目）最近 30 天涉及的交易笔数。 */
  txCount30d: number
  /** 这个项目自己映射了几种交易类型。 */
  mappedTypes: number
  /** 是否接收交易类型的映射（广告、采购成本等非交易来源的项目不接收）。 */
  acceptsMapping: boolean
}
export interface ProfitMappingRow {
  transactionType: string
  label: string
  itemId: string
  txCount30d: number
}
export interface ProfitItemsResponse {
  /** 字典版本号（MetricVersion.versionNo）；保存时原样带回，别人先保存会 409。 */
  version: number
  items: ProfitItemRow[]
  mappings: ProfitMappingRow[]
  /** 最近 90 天出现过、还没有映射的交易类型个数。 */
  unmappedCount: number
  /** 一级与二级项目合计的最近 30 天交易笔数（含子项目），键为项目编号。 */
  totalTxCount30d: number
  canManage: boolean
  manageBlockedReason: string | null
  limits: { maxItems: number; maxDepth: number; nameMax: number }
  /** 第一次打开时自动生成的第一版字典（按内置九类归并）。 */
  seeded: boolean
  note: string
}
export interface ProfitUnmappedRow {
  transactionType: string
  label: string
  txCount30d: number
  /** 按内置口径现在归到的项目（系统项目的名称）。 */
  defaultItemId: string | null
  defaultItemName: string
  lastPostedAt: string | null
}
export interface ProfitUnmappedResponse {
  items: ProfitUnmappedRow[]
  page: number
  pageSize: number
  total: number
  note: string
}
export interface ProfitItemsSaveResponse {
  version: number
  /** 新建项目的临时编号对应的正式编号。 */
  idMap: Record<string, string>
  items: number
  mappings: number
  recomputeNote: string
}

// ---- 利润页按字典渲染 ----

export interface ProfitDictionaryRow {
  id: string
  parentId: string | null
  level: number
  name: string
  group: ProfitItemGroup
  isSystem: boolean
  /** 项目自己的金额（对净利润的带符号贡献）；没有数据为 null。 */
  own: number | null
  /** 含子项目的合计；没有数据为 null。 */
  total: number | null
  /** 代收代缴税：只展示，不计入合计。 */
  excluded: boolean
  /** 来源：交易明细、利润日表的列，或二者之和。 */
  source: 'TRANSACTIONS' | 'COLUMN' | 'MIXED' | 'NONE'
  state: 'OK' | 'NO_DATA'
}
export interface ProfitDictionaryView {
  version: number
  rows: ProfitDictionaryRow[]
  /** 未映射的交易类型按内置口径计入的金额（单列显示，不并入任何项目）。 */
  unmappedAmount: number | null
  /** 按字典拆开后的合计（含未映射部分）。 */
  total: number | null
  /** 与净利润是否对得上（净利润算不出时为 null）。 */
  balanced: boolean | null
  rowsWithItems: number
  rowsTotal: number
  note: string | null
}
