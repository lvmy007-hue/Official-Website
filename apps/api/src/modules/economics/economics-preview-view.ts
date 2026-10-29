import { ECONOMICS_OURS_CURRENCY, ECONOMICS_PREVIEW_STALE_DAYS, previewImpact, type EconomicsPreviewFeeGroup, type EconomicsPreviewResponse, type EconomicsPreviewRow } from '@nova/api-contracts'
import type { EconomicsPreview } from '@prisma/client'
import { dateText } from '../overview'
import { compareText } from './economics-page'

// 费用预览的行装配、排序与汇总（P2b-11 费用预览页与 P2b-17 商品页签共用，口径只在一处）。

export const PREVIEW_NO_DATA_NOTE = '官方费用预览尚无记录：店铺授权卖家账号并开通“卖家洞察”角色后，亚马逊数据中心的费用预览每天同步一次（未来 119 天）；没有同步到数据之前不显示费用，也不会显示成 0'
export const PREVIEW_STALE_NOTE = `官方费用预览已超过 ${ECONOMICS_PREVIEW_STALE_DAYS} 天没有更新，不再展示；请到同步中心查看“官方费用预览”的同步状态`

export const IMPACT_NOTE = '利润影响 = −单件费用变化 × 官方预估数量（费用变高为负）。官方没给预估数量的调整只列出单件变化，不估算影响；没有费用调整的行不显示影响。'
export const ESTIMATE_NOTE = '费用预览是官方对未来费用的估算，不是实际发生的账单；区间内有亚马逊费用调整日时，官方把区间拆成调整前后两段。'

const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

export function previewRowOf(row: EconomicsPreview, storeName: string): EconomicsPreviewRow {
  const delta = num(row.amountPerUnitDelta)
  const quantity = num(row.quantity)
  const { impact, state } = previewImpact(delta, quantity)
  return {
    key: row.id,
    sellerAccountId: row.sellerAccountId,
    storeName,
    msku: row.msku,
    asin: row.asin,
    feeType: row.feeType,
    rangeStart: dateText(row.rangeStart),
    rangeEnd: dateText(row.rangeEnd),
    estimatedAmount: num(row.estimatedAmount) ?? 0,
    quantity,
    amountPerUnit: num(row.amountPerUnit),
    amountPerUnitDelta: delta,
    currency: row.currency,
    impact,
    impactState: state,
  }
}

const rankOf = (row: EconomicsPreviewRow) => (row.impact !== null ? Math.abs(row.impact) : row.impactState === 'UNKNOWN_QUANTITY' ? 0 : -1)
const tieOf = (row: EconomicsPreviewRow) => `${row.sellerAccountId}|${row.msku}|${row.feeType}|${row.rangeStart}`

/** 有费用调整的排前面（能算出影响的按影响绝对值大的在前，调整了但没有预估数量的次之），其余按店铺、SKU、费用类型、区间稳定排序。 */
export function sortPreviewRows(items: EconomicsPreviewRow[]): EconomicsPreviewRow[] {
  return [...items].sort((a, b) => (rankOf(a) === rankOf(b) ? compareText(tieOf(a), tieOf(b)) : rankOf(b) - rankOf(a)))
}

/** 汇总只算美元的行（和我方利润口径一致，不换算别的币种）。 */
export function summarizePreview(items: EconomicsPreviewRow[]): EconomicsPreviewResponse['summary'] {
  const usd = items.filter(row => row.currency === ECONOMICS_OURS_CURRENCY)
  const groups = new Map<string, EconomicsPreviewFeeGroup>()
  for (const row of usd) {
    const group = groups.get(row.feeType) ?? { feeType: row.feeType, rows: 0, estimated: 0, impact: null }
    group.rows += 1
    group.estimated = round6(group.estimated + row.estimatedAmount)
    if (row.impact !== null) group.impact = round6((group.impact ?? 0) + row.impact)
    groups.set(row.feeType, group)
  }
  const impacts = usd.flatMap(row => (row.impact === null ? [] : [row.impact]))
  return {
    products: new Set(items.map(row => `${row.sellerAccountId}|${row.msku}`)).size,
    rows: items.length,
    changedRows: items.filter(row => row.impactState !== 'NO_CHANGE').length,
    unknownRows: items.filter(row => row.impactState === 'UNKNOWN_QUANTITY').length,
    totalImpact: impacts.length === 0 ? null : round6(impacts.reduce((a, b) => a + b, 0)),
    byFeeType: [...groups.values()].sort((a, b) => Math.abs(b.estimated) - Math.abs(a.estimated) || compareText(a.feeType, b.feeType)),
  }
}

export function previewHorizon(items: EconomicsPreviewRow[]): { from: string; to: string } | null {
  if (items.length === 0) return null
  return { from: items.map(row => row.rangeStart).reduce((a, b) => (a < b ? a : b)), to: items.map(row => row.rangeEnd).reduce((a, b) => (a > b ? a : b)) }
}

export const previewNotes = (items: EconomicsPreviewRow[], truncated: boolean, truncatedNote: string): string[] => [
  ESTIMATE_NOTE,
  IMPACT_NOTE,
  ...(items.some(row => row.currency !== ECONOMICS_OURS_CURRENCY) ? ['有的行币种不是美元：只列出，不计入汇总，也不换算'] : []),
  ...(truncated ? [truncatedNote] : []),
]
