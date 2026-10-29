import { DAYPARTING_GRID_SIZE } from './dayparting'
import type { CursorPageInfo } from './query'

// ---- 冲突检查 ----

export const ADS_CONFLICT_FIELDS = ['state', 'bid', 'budget'] as const
export type AdsConflictField = (typeof ADS_CONFLICT_FIELDS)[number]
export const ADS_CONFLICT_FIELD_LABEL: Record<AdsConflictField, string> = { state: '启停状态', bid: '默认竞价', budget: '日预算' }
export const ADS_CONFLICT_KINDS = ['DAYPARTING_OVERLAP', 'RULE_VS_DAYPARTING', 'RULE_OVERLAP'] as const
export type AdsConflictKind = (typeof ADS_CONFLICT_KINDS)[number]
export const ADS_CONFLICT_KIND_LABEL: Record<AdsConflictKind, string> = {
  DAYPARTING_OVERLAP: '分时策略之间时段重叠',
  RULE_VS_DAYPARTING: '自动规则与分时策略作用同一对象',
  RULE_OVERLAP: '多条自动规则作用同一对象',
}
/** 冲突里“谁生效”的规则说明（写在页面上）。 */
export const ADS_CONFLICT_RULE_NOTE =
  '生效规则：分时策略每小时执行一次，所以它覆盖同一对象上自动规则的修改；分时策略之间，同一小时里编号大的后执行、最终生效；自动规则之间按编号升序执行，编号大的后执行、最终生效。只有“自动执行”模式、已启用的规则才会写入，建议模式的规则不参与冲突'

export interface ConflictStrategyInput {
  id: string
  name: string
  adsProfileId: string
  status: string
  kind: string
  level: string
  grid: readonly number[]
  targetIds: readonly string[]
}

export interface ConflictRuleInput {
  id: string
  name: string
  adsProfileId: string
  status: string
  mode: string
  level: string
  actionType: string
  /** 系统编号；空数组表示这个广告账户下的全部活动。 */
  campaignIds: readonly string[]
}

export interface ConflictObjectInput {
  id: string
  name: string
  adsProfileId: string
}

export interface AdsConflictParty {
  type: 'DAYPARTING' | 'RULE'
  id: string
  name: string
  effective: boolean
  /** 分时策略：在冲突小时里最终生效的小时数；规则是 null。 */
  effectiveHours: number | null
  note: string
}

export interface AdsConflict {
  /** 稳定的行键：对象层级、对象编号、字段。 */
  key: string
  kind: AdsConflictKind
  kindLabel: string
  objectLevel: 'CAMPAIGN' | 'AD_GROUP'
  objectId: string
  objectName: string | null
  field: AdsConflictField
  fieldLabel: string
  /** 分时策略之间取值不同的小时格数（一周 168 格）；没有分时策略参与比较时是 null。 */
  overlapHours: number | null
  parties: AdsConflictParty[]
  reason: string
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

interface StrategyActor {
  type: 'DAYPARTING'
  input: ConflictStrategyInput
}
interface RuleActor {
  type: 'RULE'
  input: ConflictRuleInput
}
type Actor = StrategyActor | RuleActor

/** 分时策略会写的字段：启停写状态；竞价系数只有广告组级会写（活动级的系数策略执行器只记跳过，不写）。 */
function strategyField(strategy: ConflictStrategyInput): { level: 'CAMPAIGN' | 'AD_GROUP'; field: AdsConflictField } | null {
  const level = strategy.level === 'AD_GROUP' ? 'AD_GROUP' : strategy.level === 'CAMPAIGN' ? 'CAMPAIGN' : null
  if (!level) return null
  if (strategy.kind === 'ON_OFF') return { level, field: 'state' }
  return level === 'AD_GROUP' ? { level, field: 'bid' } : null
}

/** 自动规则会写的字段：只有活动层级的“自动执行”规则（暂停、启用写状态，调预算写预算）。 */
function ruleField(rule: ConflictRuleInput): AdsConflictField | null {
  if (rule.level !== 'CAMPAIGN' || rule.mode !== 'AUTO') return null
  if (rule.actionType === 'PAUSE' || rule.actionType === 'ENABLE') return 'state'
  return rule.actionType === 'ADJUST_BUDGET' ? 'budget' : null
}

/** 这个格子策略会不会动手：启停每格都会写；竞价系数只有不等于 1 的格子才会改。 */
const acts = (strategy: ConflictStrategyInput, cell: number): boolean => (strategy.kind === 'ON_OFF' ? true : (strategy.grid[cell] ?? 1) !== 1)

/**
 * 找出被多个“会写入”的角色同时作用的对象。分时策略之间要看时段：同一小时格里取值不同才算冲突；
 * 分时策略与自动规则、自动规则之间只要作用到同一对象的同一字段就算。已暂停的策略与规则、建议模式的规则、
 * 范围里找不到的对象（已被同步删除）不参与。结果按对象层级、对象编号、字段排序，输出稳定。
 */
export function adsConflicts(input: {
  strategies: readonly ConflictStrategyInput[]
  rules: readonly ConflictRuleInput[]
  campaigns: readonly ConflictObjectInput[]
  adGroups: readonly ConflictObjectInput[]
}): AdsConflict[] {
  const groups = new Map<string, { level: 'CAMPAIGN' | 'AD_GROUP'; objectId: string; field: AdsConflictField; actors: Actor[] }>()
  const add = (level: 'CAMPAIGN' | 'AD_GROUP', objectId: string, field: AdsConflictField, actor: Actor) => {
    const key = `${level}|${objectId}|${field}`
    const group = groups.get(key) ?? { level, objectId, field, actors: [] }
    group.actors.push(actor)
    groups.set(key, group)
  }
  const campaignName = new Map(input.campaigns.map(item => [item.id, item.name]))
  const groupName = new Map(input.adGroups.map(item => [item.id, item.name]))
  for (const strategy of input.strategies) {
    const target = strategy.status === 'ACTIVE' ? strategyField(strategy) : null
    if (!target) continue
    const known = target.level === 'CAMPAIGN' ? campaignName : groupName
    for (const id of new Set(strategy.targetIds)) if (known.has(id)) add(target.level, id, target.field, { type: 'DAYPARTING', input: strategy })
  }
  for (const rule of input.rules) {
    const field = rule.status === 'ACTIVE' ? ruleField(rule) : null
    if (!field) continue
    const ids = rule.campaignIds.length > 0 ? rule.campaignIds : input.campaigns.filter(item => item.adsProfileId === rule.adsProfileId).map(item => item.id)
    for (const id of new Set(ids)) if (campaignName.has(id)) add('CAMPAIGN', id, field, { type: 'RULE', input: rule })
  }

  const out: AdsConflict[] = []
  for (const group of groups.values()) {
    if (group.actors.length < 2) continue
    const strategies = group.actors
      .filter((actor): actor is StrategyActor => actor.type === 'DAYPARTING')
      .map(actor => actor.input)
      .sort(byId)
    const rules = group.actors
      .filter((actor): actor is RuleActor => actor.type === 'RULE')
      .map(actor => actor.input)
      .sort(byId)

    // 分时策略之间：逐格比较会动手的策略的取值，不同才算冲突；同一格里编号最大的策略生效
    const wins = new Map<string, number>(strategies.map(strategy => [strategy.id, 0]))
    let overlapHours = 0
    for (let cell = 0; cell < DAYPARTING_GRID_SIZE; cell += 1) {
      const active = strategies.filter(strategy => acts(strategy, cell))
      if (active.length < 2 || new Set(active.map(strategy => strategy.grid[cell])).size < 2) continue
      overlapHours += 1
      const winner = active[active.length - 1]!
      wins.set(winner.id, (wins.get(winner.id) ?? 0) + 1)
    }
    const strategyConflict = strategies.length >= 2 && overlapHours > 0
    // 没有取值冲突的多个分时策略不算；有规则参与时，同一对象同一字段被两个及以上会写入的角色作用就算（本组至少有两个角色）
    if (!strategyConflict && rules.length === 0) continue

    const kind: AdsConflictKind = rules.length === 0 ? 'DAYPARTING_OVERLAP' : strategies.length > 0 ? 'RULE_VS_DAYPARTING' : 'RULE_OVERLAP'
    const lastRule = rules[rules.length - 1]
    const parties: AdsConflictParty[] = [
      ...strategies.map((strategy): AdsConflictParty => {
        const effectiveHours = strategyConflict ? (wins.get(strategy.id) ?? 0) : null
        return {
          type: 'DAYPARTING',
          id: strategy.id,
          name: strategy.name,
          effective: strategyConflict ? (effectiveHours ?? 0) > 0 : true,
          effectiveHours,
          note: strategyConflict ? ((effectiveHours ?? 0) > 0 ? `在 ${effectiveHours} 个冲突小时格里最终生效` : '冲突小时格里都被编号更大的策略覆盖，被忽略') : '每小时执行，生效',
        }
      }),
      ...rules.map((rule): AdsConflictParty => {
        const effective = strategies.length === 0 && rule === lastRule
        return {
          type: 'RULE',
          id: rule.id,
          name: rule.name,
          effective,
          effectiveHours: null,
          note: effective ? '编号最大，最后执行，最终生效' : strategies.length > 0 ? '会被分时策略每小时的写入覆盖，被忽略' : '会被编号更大的规则覆盖，被忽略',
        }
      }),
    ]
    const objectName = (group.level === 'CAMPAIGN' ? campaignName : groupName).get(group.objectId) ?? null
    out.push({
      key: `${group.level}|${group.objectId}|${group.field}`,
      kind,
      kindLabel: ADS_CONFLICT_KIND_LABEL[kind],
      objectLevel: group.level,
      objectId: group.objectId,
      objectName,
      field: group.field,
      fieldLabel: ADS_CONFLICT_FIELD_LABEL[group.field],
      overlapHours: strategies.length >= 2 ? overlapHours : null,
      parties,
      reason: `${parties.length} 个${kind === 'RULE_OVERLAP' ? '自动规则' : kind === 'DAYPARTING_OVERLAP' ? '分时策略' : '分时策略与自动规则'}同时修改这个${group.level === 'CAMPAIGN' ? '活动' : '广告组'}的${ADS_CONFLICT_FIELD_LABEL[group.field]}`,
    })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 每个策略或规则牵涉的冲突数（规则列表的冲突标记用）；键是策略或规则编号。 */
export function conflictCounts(conflicts: readonly AdsConflict[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const conflict of conflicts) for (const party of conflict.parties) counts[party.id] = (counts[party.id] ?? 0) + 1
  return counts
}

export interface AdsConflictsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  ruleNote: string
  items: AdsConflict[]
  pageInfo: CursorPageInfo
  /** 范围内全部冲突里每个策略或规则牵涉的数量（不随翻页变化）。 */
  counts: Record<string, number>
  total: number
  truncated: boolean
}
