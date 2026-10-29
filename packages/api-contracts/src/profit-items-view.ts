import { round6 } from './profit-math.js'
import type { BridgeKey } from './profit.js'
import {
  NON_TRANSACTION_KEYS,
  UNMAPPED_PREFIX,
  effectiveTargetOf,
  isLineTarget,
  isUnmappedKey,
  type ProfitDictionaryRow,
  type ProfitDictionaryView,
  type ProfitItemGroup,
  type ProfitItemNode,
} from './profit-items.js'

/** 利润桥每一项对净利润的贡献（来自已汇总的桥）：没有数据为 null。 */
export type BridgeContribution = Partial<Record<BridgeKey, number | null>>

export interface DictionaryViewInput {
  version: number
  items: ReadonlyArray<ProfitItemNode & { level: number; name: string; isSystem: boolean; sort: number }>
  /** itemAmounts 各键在范围内的合计（项目编号或 `~:目标`）。 */
  sums: ReadonlyMap<string, number>
  contribution: BridgeContribution
  netProfit: number | null
  rowsWithItems: number
  rowsTotal: number
}

/**
 * 把利润桥的各项与按项目拆开的交易金额合成字典视图。
 * 每个利润桥项目 K 的合计 = 映射到 K 的交易明细 + 未映射但按内置口径归到 K 的明细 + 余量；余量（订单销售额、广告、采购成本等不来自交易明细的部分）记在系统项目 K 上。
 * 所以全部项目加未映射部分，恰好等于利润桥各项之和（即净利润，汇兑损益尚未接入不计）。
 */
export function buildDictionaryView(input: DictionaryViewInput): ProfitDictionaryView {
  const byId = new Map<string, ProfitItemNode>(input.items.map(item => [item.id, item]))
  const sumOf = (key: string) => input.sums.get(key) ?? 0
  // 每个利润桥项目 K 上已被交易明细解释的金额
  const lineSums = new Map<string, number>()
  const addLine = (target: string, amount: number) => lineSums.set(target, (lineSums.get(target) ?? 0) + amount)
  for (const item of input.items) {
    const target = effectiveTargetOf(item, byId)
    const amount = sumOf(item.id)
    if (target && amount !== 0) addLine(target, amount)
  }
  let unmappedAmount = 0
  for (const [key, amount] of input.sums) {
    if (!isUnmappedKey(key)) continue
    unmappedAmount += amount
    addLine(key.slice(UNMAPPED_PREFIX.length), amount)
  }
  const own = new Map<string, number | null>()
  const sources = new Map<string, ProfitDictionaryRow['source']>()
  for (const item of input.items) {
    const key = item.systemKey
    const lines = sumOf(item.id)
    const hasLines = input.sums.has(item.id)
    if (key === 'EXCLUDED') {
      own.set(item.id, null)
      sources.set(item.id, 'NONE')
      continue
    }
    if (key !== null && NON_TRANSACTION_KEYS.includes(key)) {
      const value = input.contribution[key as BridgeKey]
      own.set(item.id, value === undefined || value === null ? null : round6(value))
      sources.set(item.id, value === undefined || value === null ? 'NONE' : 'COLUMN')
      continue
    }
    // 利润桥项目对应的系统项目（二级系统项目）：接收该项目的余量
    if (key !== null && isLineTarget(key)) {
      const contribution = input.contribution[key as BridgeKey]
      const remainder = contribution === undefined || contribution === null ? 0 : contribution - (lineSums.get(key) ?? 0)
      const value = lines + remainder
      const noData = !hasLines && (contribution === undefined || contribution === null)
      own.set(item.id, noData ? null : round6(value))
      sources.set(item.id, noData ? 'NONE' : hasLines && Math.abs(remainder) > 0.000001 ? 'MIXED' : hasLines ? 'TRANSACTIONS' : 'COLUMN')
      continue
    }
    own.set(item.id, hasLines ? round6(lines) : null)
    sources.set(item.id, hasLines ? 'TRANSACTIONS' : 'NONE')
  }
  // 合计：自己加子项目；代收代缴税不进合计
  const children = new Map<string | null, string[]>()
  for (const item of input.items) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id])
  const totals = new Map<string, number | null>()
  const totalOf = (id: string): number | null => {
    if (totals.has(id)) return totals.get(id) ?? null
    const item = byId.get(id) as ProfitItemNode
    let sum: number | null = item.systemKey === 'EXCLUDED' ? null : (own.get(id) ?? null)
    for (const child of children.get(id) ?? []) {
      const part = totalOf(child)
      if (part !== null) sum = (sum ?? 0) + part
    }
    const rounded = sum === null ? null : round6(sum)
    totals.set(id, rounded)
    return rounded
  }
  const order = [...input.items].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const rootTotals = order.filter(item => item.parentId === null).map(item => totalOf(item.id))
  const hasAny = rootTotals.some(value => value !== null) || unmappedAmount !== 0
  const total = hasAny ? round6(rootTotals.reduce<number>((sum, value) => sum + (value ?? 0), 0) + unmappedAmount) : null
  const bridgeSum = (Object.entries(input.contribution) as Array<[BridgeKey, number | null | undefined]>).reduce(
    (sum, [key, value]) => (key === 'FX_GAIN_LOSS' || key === 'NET_PROFIT' ? sum : sum + (value ?? 0)),
    0,
  )
  const balanced = input.netProfit === null || total === null ? null : Math.abs(total - input.netProfit) < 0.01 && Math.abs(bridgeSum - input.netProfit) < 0.01
  const rows: ProfitDictionaryRow[] = []
  const walk = (parent: string | null) => {
    const list = order.filter(item => item.parentId === parent)
    for (const item of list) {
      const value = own.get(item.id) ?? null
      const subtotal = totals.get(item.id) ?? totalOf(item.id)
      rows.push({
        id: item.id,
        parentId: item.parentId,
        level: item.level,
        name: item.name,
        group: item.group as ProfitItemGroup,
        isSystem: item.isSystem,
        own: value,
        total: subtotal,
        excluded: item.systemKey === 'EXCLUDED',
        source: sources.get(item.id) ?? 'NONE',
        state: subtotal === null && value === null ? 'NO_DATA' : 'OK',
      })
      walk(item.id)
    }
  }
  walk(null)
  const notes: string[] = []
  if (input.rowsTotal === 0) notes.push('所选范围内没有利润数据')
  else if (input.rowsWithItems === 0) notes.push('利润日表还没有按项目字典重算（下次定时重算后生成，最长约 6 小时）；现在每个项目的金额都记在对应的系统项目上')
  if (unmappedAmount !== 0) notes.push('有交易类型还没有映射，它们按内置口径计入利润，金额单列在“未映射”里，请在利润项目字典页补全')
  return {
    version: input.version,
    rows,
    unmappedAmount: unmappedAmount === 0 ? null : round6(unmappedAmount),
    total,
    balanced,
    rowsWithItems: input.rowsWithItems,
    rowsTotal: input.rowsTotal,
    note: notes.length > 0 ? notes.join('；') : null,
  }
}
