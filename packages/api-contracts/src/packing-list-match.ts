// 装箱单的 SKU 匹配（P6-11，16 章 5.1）：纯函数，不带 zod。顺序固定：
//   1. 精确匹配：货号（没有货号时用品名）与计划里某个商品的 SKU、FNSKU、ASIN 完全一致；
//   2. 外部货号映射：该供应商自己的映射优先，其次是通用映射（目标 SKU 必须在这个计划里）；
//   3. 相似候选：按货号和品名的相似度排序，最多 5 个，只作提示，**永远不自动采用**。
// 商品条码（UPC、EAN）：商品目录里还没有这类数据，所以不能直接按条码精确匹配；把条码记到外部货号映射里就能匹配。

export interface PlanItemRef {
  sku: string
  fnsku: string | null
  asin: string | null
  productName: string | null
}
export interface AliasRef {
  supplierId: string | null
  externalCode: string
  sku: string
}

export type PackingMatchBasis = 'SKU' | 'FNSKU' | 'ASIN' | 'ALIAS'
export const PACKING_BASIS_LABEL: Record<PackingMatchBasis, string> = {
  SKU: '与 SKU 完全一致',
  FNSKU: '与 FNSKU 完全一致',
  ASIN: '与 ASIN 完全一致',
  ALIAS: '外部货号映射',
}
export type PackingMatchStatus = 'MATCHED' | 'CANDIDATE' | 'UNMATCHED'
export const PACKING_STATUS_LABEL: Record<PackingMatchStatus, string> = { MATCHED: '已匹配', CANDIDATE: '候选', UNMATCHED: '未匹配' }

export interface PackingCandidate {
  sku: string
  productName: string | null
  /** 相似度 0 到 1，保留两位小数。 */
  score: number
}
export interface PackingMatch {
  status: PackingMatchStatus
  basis: PackingMatchBasis | null
  sku: string | null
  candidates: PackingCandidate[]
  /** 需要让人知道的说明（例如映射的 SKU 不在这个计划里、同一个 FNSKU 对应多个 SKU）。 */
  note: string | null
}

export const PACKING_CANDIDATE_LIMIT = 5
export const PACKING_CANDIDATE_MIN_SCORE = 0.35

const clean = (text: string): string => text.toLowerCase().replace(/[\s\-_./\\()（）【】[\]#,，、:：]+/g, '')

function bigrams(text: string): Map<string, number> {
  const result = new Map<string, number>()
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2)
    result.set(pair, (result.get(pair) ?? 0) + 1)
  }
  return result
}

/** 文字相似度 0 到 1：忽略大小写、空白与连接符；两边都有 3 个字以上且一边包含另一边时至少 0.85，否则按相邻两字的 Dice 系数。 */
export function textSimilarity(left: string, right: string): number {
  const a = clean(left)
  const b = clean(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  let best = 0
  if ((a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b))) best = 0.85 + 0.1 * (Math.min(a.length, b.length) / Math.max(a.length, b.length))
  const left2 = bigrams(a)
  const right2 = bigrams(b)
  let shared = 0
  for (const [pair, count] of left2) shared += Math.min(count, right2.get(pair) ?? 0)
  const dice = (2 * shared) / (a.length - 1 + (b.length - 1))
  return Math.max(best, dice)
}

const round2 = (value: number) => Math.round(value * 100) / 100

/** 相似候选：货号对 SKU 与 FNSKU、品名对商品名称，取较高的一个（两个都有就再加一点），按分数从高到低，最多 5 个。 */
export function rankCandidates(row: { code: string | null; name: string | null }, items: readonly PlanItemRef[], limit = PACKING_CANDIDATE_LIMIT): PackingCandidate[] {
  const scored: PackingCandidate[] = []
  for (const item of items) {
    const byCode = row.code
      ? Math.max(textSimilarity(row.code, item.sku), item.fnsku ? textSimilarity(row.code, item.fnsku) : 0, item.productName ? textSimilarity(row.code, item.productName) * 0.8 : 0)
      : 0
    const byName = row.name ? Math.max(item.productName ? textSimilarity(row.name, item.productName) : 0, textSimilarity(row.name, item.sku) * 0.9) : 0
    const score = Math.min(1, Math.max(byCode, byName) + 0.1 * Math.min(byCode, byName))
    if (score >= PACKING_CANDIDATE_MIN_SCORE) scored.push({ sku: item.sku, productName: item.productName, score: round2(score) })
  }
  return scored.sort((x, y) => y.score - x.score || x.sku.localeCompare(y.sku)).slice(0, limit)
}

/** 把一批映射收成“外部货号 → SKU”：该供应商自己的映射优先于通用映射。 */
export function aliasLookup(aliases: readonly AliasRef[], supplierId: string | null): Map<string, string> {
  const result = new Map<string, string>()
  for (const alias of aliases) if (alias.supplierId === null && !result.has(alias.externalCode)) result.set(alias.externalCode, alias.sku)
  if (supplierId) for (const alias of aliases) if (alias.supplierId === supplierId) result.set(alias.externalCode, alias.sku)
  return result
}

/** 这一行用来匹配的键：货号在前，品名在后（去重）。 */
export const matchKeys = (row: { code: string | null; name: string | null }): string[] => [...new Set([row.code, row.name].filter((key): key is string => !!key))]

export function matchPackingRow(row: { code: string | null; name: string | null }, items: readonly PlanItemRef[], aliases: ReadonlyMap<string, string>): PackingMatch {
  const keys = matchKeys(row)
  const done = (sku: string, basis: PackingMatchBasis): PackingMatch => ({ status: 'MATCHED', basis, sku, candidates: [], note: null })
  let note: string | null = null
  for (const key of keys) {
    const bySku = items.find(item => item.sku === key)
    if (bySku) return done(bySku.sku, 'SKU')
  }
  for (const [basis, pick] of [
    ['FNSKU', (item: PlanItemRef) => item.fnsku],
    ['ASIN', (item: PlanItemRef) => item.asin],
  ] as const) {
    for (const key of keys) {
      const hits = items.filter(item => pick(item) === key)
      if (hits.length === 1) return done(hits[0]!.sku, basis)
      if (hits.length > 1) {
        note = `${key} 对应 ${hits.length} 个 SKU（${hits.map(item => item.sku).join('、')}），请自己选`
        return { status: 'CANDIDATE', basis: null, sku: null, candidates: hits.map(item => ({ sku: item.sku, productName: item.productName, score: 1 })).slice(0, PACKING_CANDIDATE_LIMIT), note }
      }
    }
  }
  for (const key of keys) {
    const target = aliases.get(key)
    if (target === undefined) continue
    if (items.some(item => item.sku === target)) return done(target, 'ALIAS')
    note = `外部货号映射里 ${key} 对应 ${target}，但它不在这个计划里`
  }
  const candidates = rankCandidates(row, items)
  return { status: candidates.length > 0 ? 'CANDIDATE' : 'UNMATCHED', basis: null, sku: null, candidates, note }
}
