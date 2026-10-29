import { PROFIT_ITEM_GROUPS, PROFIT_ITEM_LIMITS, SYSTEM_ITEM_BY_KEY, effectiveTargetOf, type ProfitItemGroup, type ProfitItemNode } from './profit-items.js'

// 利润项目字典整树保存的校验（P6-18）：纯函数，不碰数据库。接口服务与前端（保存前的即时提示）共用。
// 规则：系统项目必须都在、不能挪位置、不能改分组与正负方向（可以改名）；最多三级；同一父项目下名称不能重复；
// 自定义项目的分组跟随所在的一级项目；映射只能指向接收交易明细的项目；每个交易类型只能映射一次。

export interface StoredProfitItem extends ProfitItemNode {
  level: number
  name: string
  sign: number
  isSystem: boolean
  sort: number
}
export interface BodyProfitItem {
  id: string
  parentId: string | null
  name: string
  /** 只有自定义的一级项目需要；其余项目的分组跟随所在的一级项目。 */
  group?: ProfitItemGroup | undefined
  /** 自定义项目的正负方向；系统项目不能改。 */
  sign?: 1 | -1 | undefined
  sort: number
}
export interface BodyProfitMapping {
  transactionType: string
  itemId: string
}

export interface PlannedItem {
  /** 已有项目是正式编号，新项目是请求里的临时编号（以 new: 开头）。 */
  id: string
  isNew: boolean
  parentId: string | null
  level: number
  name: string
  group: ProfitItemGroup
  sign: 1 | -1
  sort: number
  isSystem: boolean
  systemKey: string | null
}
export interface TreeIssue {
  path: string
  message: string
}
export type TreePlan = { ok: true; items: PlannedItem[]; deletedIds: string[]; mappings: BodyProfitMapping[] } | { ok: false; issues: TreeIssue[] }

export const NEW_ID_PREFIX = 'new:'
const GROUPS: ReadonlySet<string> = new Set(PROFIT_ITEM_GROUPS)

export function planProfitItemTree(stored: readonly StoredProfitItem[], body: { items: readonly BodyProfitItem[]; mappings: readonly BodyProfitMapping[] }): TreePlan {
  const issues: TreeIssue[] = []
  const fail = (path: string, message: string) => issues.push({ path, message })
  const storedById = new Map(stored.map(item => [item.id, item]))
  if (body.items.length > PROFIT_ITEM_LIMITS.maxItems) fail('items', `项目最多 ${PROFIT_ITEM_LIMITS.maxItems} 个`)
  const byId = new Map<string, BodyProfitItem>()
  body.items.forEach((item, index) => {
    if (byId.has(item.id)) fail(`items[${index}].id`, '项目编号重复')
    byId.set(item.id, item)
    const known = storedById.has(item.id)
    if (!known && !item.id.startsWith(NEW_ID_PREFIX)) fail(`items[${index}].id`, '新项目的编号必须以 new: 开头，已有项目的编号必须是系统里存在的')
  })
  for (const item of stored) {
    if (item.isSystem && !byId.has(item.id)) fail('items', `系统项目「${item.name}」不能删除`)
  }

  // 层级与分组：从一级项目往下算；有环或超过三级都报错
  const levels = new Map<string, number>()
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = levels.get(id)
    if (cached !== undefined) return cached
    const item = byId.get(id)
    if (!item) return 0
    if (seen.has(id)) return Number.POSITIVE_INFINITY
    seen.add(id)
    const depth = item.parentId === null ? 1 : depthOf(item.parentId, seen) + 1
    levels.set(id, depth)
    return depth
  }
  body.items.forEach((item, index) => {
    if (item.parentId !== null && !byId.has(item.parentId)) fail(`items[${index}].parentId`, '上级项目不存在')
    const depth = depthOf(item.id, new Set())
    if (!Number.isFinite(depth)) fail(`items[${index}].parentId`, '项目之间形成了循环')
    else if (depth > PROFIT_ITEM_LIMITS.maxDepth) fail(`items[${index}].parentId`, `项目最多 ${PROFIT_ITEM_LIMITS.maxDepth} 级`)
  })
  if (issues.length > 0) return { ok: false, issues }

  const planned = new Map<string, PlannedItem>()
  const resolve = (item: BodyProfitItem, index: number): PlannedItem | null => {
    const done = planned.get(item.id)
    if (done) return done
    const current = storedById.get(item.id)
    const parent = item.parentId === null ? null : byId.get(item.parentId)
    const parentPlan = parent ? resolve(parent, body.items.indexOf(parent)) : null
    const name = item.name.trim()
    if (name.length < 1 || name.length > PROFIT_ITEM_LIMITS.nameMax) fail(`items[${index}].name`, `项目名称是 1 到 ${PROFIT_ITEM_LIMITS.nameMax} 个字`)
    let group: ProfitItemGroup
    let sign: 1 | -1
    if (current?.isSystem) {
      const system = current.systemKey ? SYSTEM_ITEM_BY_KEY.get(current.systemKey) : undefined
      if (item.parentId !== current.parentId) fail(`items[${index}].parentId`, `系统项目「${current.name}」不能挪动位置`)
      if (item.group !== undefined && item.group !== current.group) fail(`items[${index}].group`, `系统项目「${current.name}」不能改分组`)
      if (item.sign !== undefined && item.sign !== current.sign) fail(`items[${index}].sign`, `系统项目「${current.name}」不能改正负方向`)
      group = (system?.group ?? current.group) as ProfitItemGroup
      sign = current.sign === -1 ? -1 : 1
    } else {
      if (parentPlan) group = parentPlan.group
      else if (item.group !== undefined && GROUPS.has(item.group)) group = item.group
      else {
        fail(`items[${index}].group`, '自定义的一级项目需要选择分组')
        group = 'OTHER'
      }
      if (parentPlan && parentPlan.systemKey === 'EXCLUDED') fail(`items[${index}].parentId`, '代收代缴税下面不能再建项目')
      sign = item.sign ?? (current?.sign === -1 ? -1 : current?.sign === 1 ? 1 : group === 'REVENUE' || group === 'OTHER' ? 1 : -1)
    }
    const plan: PlannedItem = {
      id: item.id,
      isNew: current === undefined,
      parentId: item.parentId,
      level: levels.get(item.id) ?? 1,
      name,
      group,
      sign,
      sort: item.sort,
      isSystem: current?.isSystem ?? false,
      systemKey: current?.systemKey ?? null,
    }
    planned.set(item.id, plan)
    return plan
  }
  body.items.forEach((item, index) => resolve(item, index))

  // 同级名称不能重复
  const seenNames = new Map<string, string>()
  for (const plan of planned.values()) {
    const key = `${plan.parentId ?? ''}\u0000${plan.name}`
    if (seenNames.has(key)) fail('items', `「${plan.name}」在同一级下重复了`)
    seenNames.set(key, plan.id)
  }

  // 映射
  const nodes = new Map<string, ProfitItemNode>([...planned.values()].map(plan => [plan.id, { id: plan.id, parentId: plan.parentId, group: plan.group, systemKey: plan.systemKey }]))
  if (body.mappings.length > PROFIT_ITEM_LIMITS.maxMappings) fail('mappings', `映射最多 ${PROFIT_ITEM_LIMITS.maxMappings} 条`)
  const seenTypes = new Set<string>()
  body.mappings.forEach((mapping, index) => {
    if (seenTypes.has(mapping.transactionType)) fail(`mappings[${index}].transactionType`, `交易类型 ${mapping.transactionType} 重复映射`)
    seenTypes.add(mapping.transactionType)
    const node = nodes.get(mapping.itemId)
    const plan = planned.get(mapping.itemId)
    if (!node || !plan) fail(`mappings[${index}].itemId`, '映射指向的项目不存在')
    else if (effectiveTargetOf(node, nodes) === null) fail(`mappings[${index}].itemId`, `项目「${plan.name}」的金额来自广告、采购成本等非交易数据，不能映射交易类型`)
  })
  if (issues.length > 0) return { ok: false, issues }

  const deletedIds = stored.filter(item => !byId.has(item.id)).map(item => item.id)
  const items = [...planned.values()].sort((a, b) => a.level - b.level)
  return { ok: true, items, deletedIds, mappings: [...body.mappings] }
}
