import { batchTermsIssue, parseBatchTerms, type GridFilterValue } from '@nova/api-contracts'

// 筛选栏的纯函数（P6-04，15 章第 7 节）：筛选条件是一组“键 → 文字”，写在地址栏里；这里负责认出哪些键归筛选栏管、
// 把地址栏或保存方案里的值清洗成合法值（认不出的丢掉并计数）、生成“已生效条件”标签。不碰界面状态，便于单测。

export type FilterOption = { value: string; label: string }

export type FilterField = {
  key: string
  label: string
  kind: 'select' | 'text'
  options?: readonly FilterOption[]
  /** main：常驻区；more：收进“更多筛选”。 */
  placement?: 'main' | 'more'
  width?: number
  /** 不在筛选栏里显示、也不出标签，但仍由地址栏管理（例如页面上方的页签），重置时一并清掉。 */
  hidden?: boolean
  /** 下拉的取值必须在 options 里才算有效（默认是）；选项来自接口、可能还没读到时设为 false。 */
  strict?: boolean
}

/** 搜索框的“按什么搜”。同一个键可以有多种方式（例如名称“包含”与“不包含”共用 q，靠 with 区分）。 */
export type SearchMode = {
  id: string
  label: string
  /** 单项搜索写入的键。 */
  key: string
  /** 选这种方式时一并写入的键值（例如 qMode=excludes）。 */
  with?: Readonly<Record<string, string>>
  /** 支持批量粘贴时，批量词（精确匹配、最多 500 个）写入的键。 */
  batchKey?: string
  /** 输入框的占位文字，不写就是“搜索 + label”。 */
  placeholder?: string
  /** 批量词标签的名称（批量精确匹配的字段可能比单项搜索少）；不写用 label。 */
  batchLabel?: string
}

export type FilterValues = Record<string, string>
export type FilterPatch = Record<string, string | undefined>
export type FilterTag = { id: string; label: string; text: string; keys: string[] }

/** 筛选栏管理的全部键。 */
export function managedKeys(fields: readonly FilterField[], modes: readonly SearchMode[]): string[] {
  const keys = new Set<string>()
  for (const field of fields) keys.add(field.key)
  for (const mode of modes) {
    keys.add(mode.key)
    if (mode.batchKey) keys.add(mode.batchKey)
    for (const key of Object.keys(mode.with ?? {})) keys.add(key)
  }
  return [...keys]
}

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.length > 0 ? value.join(',') : null
  return null
}

/**
 * 把地址栏或保存方案里的值清洗成合法筛选值。认不出的键、下拉里没有的取值、批量词不合规，都丢掉并计入 ignored。
 * 不在管理范围内的键（范围参数、分页）既不保留也不计数——它们不是筛选条件。
 */
export function sanitizeFilterValues(
  fields: readonly FilterField[],
  modes: readonly SearchMode[],
  raw: Readonly<Record<string, unknown>>,
  options: { countUnknown?: boolean } = {},
): { values: FilterValues; ignored: number } {
  const keys = new Set(managedKeys(fields, modes))
  const batchKeys = new Set(modes.flatMap(mode => (mode.batchKey ? [mode.batchKey] : [])))
  const values: FilterValues = {}
  let ignored = 0
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.has(key)) {
      if (options.countUnknown && textOf(value) !== null) ignored += 1
      continue
    }
    const text = textOf(value)
    if (text === null) continue
    const field = fields.find(item => item.key === key)
    if (field?.kind === 'select' && field.options && field.strict !== false && !field.options.some(option => option.value === text)) {
      ignored += 1
      continue
    }
    if (batchKeys.has(key) && (batchTermsIssue(text) !== null || parseBatchTerms(text).items.length === 0)) {
      ignored += 1
      continue
    }
    values[key] = text
  }
  // with 里的键（如 qMode）只在对应的搜索词存在时才有意义
  for (const mode of modes) {
    for (const withKey of Object.keys(mode.with ?? {})) {
      if (values[withKey] !== undefined && values[mode.key] === undefined && !fields.some(field => field.key === withKey)) delete values[withKey]
    }
  }
  return { values, ignored }
}

/** 当前搜索词对应哪种搜索方式：搜索词存在且 with 全部吻合的第一种；没有时返回 null。 */
export function activeMode(modes: readonly SearchMode[], values: FilterValues): SearchMode | null {
  const matching = modes.filter(mode => values[mode.key] !== undefined && Object.entries(mode.with ?? {}).every(([key, expected]) => values[key] === expected))
  // with 更多的优先（“不包含”比“包含”更具体）
  matching.sort((a, b) => Object.keys(b.with ?? {}).length - Object.keys(a.with ?? {}).length)
  return matching[0] ?? null
}

/** 提交一个搜索词：写入该方式的键与 with，清掉同一个键下其他方式留下的附加键；空词表示清除。 */
export function searchPatch(modes: readonly SearchMode[], mode: SearchMode, text: string): FilterPatch {
  const patch: FilterPatch = {}
  for (const other of modes) for (const key of Object.keys(other.with ?? {})) if (other.key === mode.key) patch[key] = undefined
  const term = text.trim()
  patch[mode.key] = term === '' ? undefined : term
  if (term !== '') Object.assign(patch, mode.with ?? {})
  return patch
}

/** 已生效条件标签：下拉与文本一项一个，搜索词一个（含“不包含”之类的方式），批量词一个（显示个数）。 */
export function appliedTags(fields: readonly FilterField[], modes: readonly SearchMode[], values: FilterValues): FilterTag[] {
  const tags: FilterTag[] = []
  const used = new Set<string>()
  for (const field of fields) {
    const value = values[field.key]
    if (value === undefined || field.hidden) continue
    used.add(field.key)
    const label = field.kind === 'select' ? (field.options?.find(option => option.value === value)?.label ?? value) : value
    tags.push({ id: field.key, label: field.label, text: label, keys: [field.key] })
  }
  const mode = activeMode(modes, values)
  if (mode && !used.has(mode.key)) {
    tags.push({ id: `search:${mode.id}`, label: mode.label, text: values[mode.key]!, keys: [mode.key, ...Object.keys(mode.with ?? {})] })
  }
  for (const entry of modes) {
    const batch = entry.batchKey ? values[entry.batchKey] : undefined
    if (!entry.batchKey || batch === undefined || used.has(entry.batchKey)) continue
    used.add(entry.batchKey)
    tags.push({ id: `batch:${entry.id}`, label: `${entry.batchLabel ?? entry.label}（批量精确）`, text: `${parseBatchTerms(batch).items.length} 项`, keys: [entry.batchKey] })
  }
  return tags
}

/** 已生效的条件个数：标签数，加上不显示标签的隐藏字段（页签）里有值的个数。 */
export function appliedCount(fields: readonly FilterField[], modes: readonly SearchMode[], values: FilterValues): number {
  return appliedTags(fields, modes, values).length + fields.filter(field => field.hidden && values[field.key] !== undefined).length
}

/** 把一组筛选值整体换成另一组（套用筛选方案时用）：没出现的键清空。 */
export function replacePatch(keys: readonly string[], next: FilterValues): FilterPatch {
  return Object.fromEntries(keys.map(key => [key, next[key]]))
}

/** 在地址栏参数上应用筛选变化：筛选变了要回到第一页，所以去掉页码与游标；空值删除键。 */
export function nextFilterSearch(prev: Record<string, unknown>, patch: FilterPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev }
  delete next.page
  delete next.cursor
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  return next
}

/** 筛选值存进视图或方案时的写法（只存非空值）。 */
export const toViewFilters = (values: FilterValues): Record<string, GridFilterValue> => ({ ...values })
