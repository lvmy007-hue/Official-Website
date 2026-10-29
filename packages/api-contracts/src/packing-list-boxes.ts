import type { InboundBoxInput } from './inbound.js'
import { PACKING_MAX_BOXES } from './packing-list.js'
import type { PackingSourceRow } from './packing-list-rows.js'

// 装箱单合并成箱子（P6-11）：同一个箱号的多行合并成一个箱子，规格相同的箱子用“相同箱数”表示；再按人工决定（选 SKU、忽略、记住对应关系）得出能写进装箱草稿的箱子。
// 纯函数，不带 zod：预览与应用共用，页面提示的问题与服务端校验的问题一致。

/** 装箱单里没有箱规时用的默认箱规（已经是英寸与磅）。 */
export interface PackingDefaults {
  weightLb?: number | null
  lengthIn?: number | null
  widthIn?: number | null
  heightIn?: number | null
}

/** 人工决定：按行号。sku 是人工选的（必须在计划里）；ignore 表示这一行不装箱；remember 表示把“外部货号 → SKU”记进映射表。 */
export interface PackingDecision {
  line: number
  sku?: string | null
  ignore?: boolean
  remember?: boolean
}

export interface PackingBoxRow extends PackingSourceRow {
  /** 这一行最终用的 SKU。 */
  sku: string
}

const SPEC_FIELDS = [
  ['weightLb', '重量'],
  ['lengthIn', '长'],
  ['widthIn', '宽'],
  ['heightIn', '高'],
] as const

export interface PackingBoxBuild {
  boxes: InboundBoxInput[]
  /** 整份的问题（箱型超过上限等）。 */
  errors: string[]
  /** 按行号的问题：同箱规格不一致、缺箱规、同箱 SKU 重复等（写在这个箱子里的第一行上）。 */
  rowIssues: Map<number, string[]>
}

export function buildPackingBoxes(rows: readonly PackingBoxRow[], defaults: PackingDefaults | null = null): PackingBoxBuild {
  const groups = new Map<string, PackingBoxRow[]>()
  for (const row of rows) {
    const key = row.boxNo ? `box:${row.boxNo}` : `line:${row.line}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const rowIssues = new Map<number, string[]>()
  const errors: string[] = []
  const boxes: InboundBoxInput[] = []
  const complain = (line: number, message: string) => rowIssues.set(line, [...(rowIssues.get(line) ?? []), message])

  for (const members of groups.values()) {
    const first = members[0]!
    const label = first.boxNo ? `箱 ${first.boxNo}` : `第 ${first.line} 行`
    const count = first.boxCount ?? 1
    for (const member of members.slice(1)) if ((member.boxCount ?? 1) !== count) complain(member.line, `${label}的箱数 ${member.boxCount} 与第 ${first.line} 行的 ${count} 不一致`)

    const spec: Record<(typeof SPEC_FIELDS)[number][0], number | null> = { weightLb: null, lengthIn: null, widthIn: null, heightIn: null }
    const missing: string[] = []
    for (const [field, text] of SPEC_FIELDS) {
      const given = members.find(member => member[field] !== null)
      const value = given ? given[field] : null
      for (const member of members) if (member[field] !== null && value !== null && member[field] !== value) complain(member.line, `${label}的${text}与第 ${given!.line} 行不一致`)
      const fallback = defaults?.[field] ?? null
      spec[field] = value ?? fallback
      if (spec[field] === null) missing.push(text)
    }
    if (missing.length > 0) complain(first.line, `${label}缺少${missing.join('、')}（装箱单里没有，也没填默认箱规）`)

    const seen = new Map<string, number>()
    const items: InboundBoxInput['items'] = []
    for (const member of members) {
      const earlier = seen.get(member.sku)
      if (earlier !== undefined) {
        complain(member.line, `${label}里 ${member.sku} 重复（第 ${earlier} 行与第 ${member.line} 行），请合并或忽略其中一行`)
        continue
      }
      seen.set(member.sku, member.line)
      items.push({ sku: member.sku, quantity: member.perBox ?? 0 })
    }
    if (items.length > 100) errors.push(`${label}里的商品超过 100 种`)
    const boxId = first.boxNo && !first.boxRange ? first.boxNo : undefined
    if (boxId && boxId.length > 40) complain(first.line, `箱号 ${boxId} 太长（最多 40 个字）`)
    if (spec.weightLb === null || spec.lengthIn === null || spec.widthIn === null || spec.heightIn === null) continue
    boxes.push({ ...(boxId ? { boxId } : {}), quantity: count, weightLb: spec.weightLb, lengthIn: spec.lengthIn, widthIn: spec.widthIn, heightIn: spec.heightIn, items })
  }
  if (groups.size > PACKING_MAX_BOXES) errors.push(`箱型最多 ${PACKING_MAX_BOXES} 个，现在有 ${groups.size} 个：请把相同的箱子合并，用箱号范围或箱数表示`)
  return { boxes, errors, rowIssues }
}

/** 一行的匹配结果（预览行里的这几项就够做决定）。 */
export interface PackingDecidable extends PackingSourceRow {
  status: 'MATCHED' | 'CANDIDATE' | 'UNMATCHED'
  sku: string | null
}

export interface PackingResolution {
  boxes: InboundBoxInput[]
  /** 不解决就不能应用的问题（逐条写明行号）。 */
  blockers: string[]
  /** 要记进映射表的对应关系。 */
  remember: Array<{ externalCode: string; sku: string; line: number }>
  ignoredLines: number[]
}

export const PACKING_BLOCKER_MAX = 50

/**
 * 按人工决定把预览行落成箱子：被忽略的行不装箱；其余行必须有 SKU（自动匹配的，或人工选的、且在计划里），并且自己没有数据问题；
 * 合并成箱子后的问题（箱规不一致、缺箱规、同箱 SKU 重复）也算阻止项。有任何阻止项就不能应用（boxes 为空）。
 */
export function resolvePacking(rows: readonly PackingDecidable[], decisions: readonly PackingDecision[], planSkus: ReadonlySet<string>, defaults: PackingDefaults | null): PackingResolution {
  const byLine = new Map(decisions.map(decision => [decision.line, decision]))
  const blockers: string[] = []
  const remember: PackingResolution['remember'] = []
  const ignoredLines: number[] = []
  const used: PackingBoxRow[] = []
  const block = (message: string) => {
    if (blockers.length < PACKING_BLOCKER_MAX) blockers.push(message)
  }
  const knownLines = new Set(rows.map(row => row.line))
  for (const decision of decisions) if (!knownLines.has(decision.line)) block(`决定里的第 ${decision.line} 行不在这份文件里（文件可能换过，请重新预览）`)

  for (const row of rows) {
    const decision = byLine.get(row.line)
    const label = `第 ${row.line} 行${row.code || row.name ? `（${row.code ?? row.name}）` : ''}`
    if (decision?.ignore) {
      ignoredLines.push(row.line)
      continue
    }
    if (row.issues.length > 0) {
      block(`${label}：${row.issues[0]}（修改文件后重新预览，或忽略这一行）`)
      continue
    }
    const chosen = decision?.sku ?? null
    if (chosen !== null && !planSkus.has(chosen)) {
      block(`${label}：选的 SKU ${chosen} 不在这个计划里`)
      continue
    }
    const sku = chosen ?? row.sku
    if (!sku) {
      block(`${label}还没有选 SKU，也没有标记忽略`)
      continue
    }
    if (decision?.remember && !(row.status === 'MATCHED' && row.sku === sku)) {
      const externalCode = row.code ?? row.name
      if (externalCode) {
        const clash = remember.find(item => item.externalCode === externalCode && item.sku !== sku)
        if (clash) block(`${label}：外部货号 ${externalCode} 在第 ${clash.line} 行已选 ${clash.sku}，同一个货号不能同时记成两个 SKU`)
        else if (!remember.some(item => item.externalCode === externalCode)) remember.push({ externalCode, sku, line: row.line })
      }
    }
    used.push({ ...row, sku })
  }
  const built = buildPackingBoxes(used, defaults)
  for (const message of built.errors) block(message)
  for (const [line, messages] of built.rowIssues) for (const message of messages) block(`第 ${line} 行：${message}`)
  if (used.length === 0 && blockers.length === 0) block('没有可以装箱的行（全部被忽略了）')
  return { boxes: blockers.length === 0 ? built.boxes : [], blockers, remember: blockers.length === 0 ? remember : [], ignoredLines }
}
