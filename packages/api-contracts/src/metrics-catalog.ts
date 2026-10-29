import { z } from 'zod'
import { METRIC_DEFINITIONS } from './metric-definitions.generated.js'
import type { RuleUse } from './rule-conditions.js'

// 指标口径目录（P1-28-8）：数据来自冻结字典 docs/erp-plan/freeze/metrics.md（由脚本生成，不手工维护）。
// 同名指标只有一个口径；口径版本任一变化即升版并保留历史（目前全部为初始口径 @1，没有变更记录）。

export const METRIC_TYPES = ['官方', '我方计算', '模型估算', '导入', '无官方来源', '自定义'] as const
export type MetricType = (typeof METRIC_TYPES)[number]

/** 指向站内页面的链接：对账页面、可配置口径的设置页 */
export interface MetricLink {
  label: string
  /** 站内路径，如 /app/profit；必须在路由清单（freeze/routes.md）里存在 */
  route: string
}

export interface MetricDefinition {
  id: string
  name: string
  type: MetricType
  /** 所属板块，如“全局与经营” */
  group: string
  definition: string
  source: string
  refresh: string
  /** 口径版本；“无官方来源、不设指标”的条目没有版本 */
  version: number | null
  /** 使用该指标的页面名称（与路由清单中的页面标题对应） */
  pages: readonly string[]
  /** 口径字典三字段（P6-03，14 章 §14.3）：和哪些页面的同一指标应该对得上 */
  reconcileWith: readonly MetricLink[]
  /** 数字对不上时的常见原因，每条一句话；空数组表示没有已知原因 */
  mismatchReasons: readonly string[]
  /** 能改变这个口径的设置位置；null 表示口径固定、不可配置 */
  configurableAt: MetricLink | null
  /** 能否用于规则条件（P6-07，metrics.md 10.8）：可以就写明所属域、数值单位与允许的聚合方式；不能就是 null */
  ruleUse: RuleUse | null
}

/** 一次按编号最多取的指标数 */
export const METRIC_IDS_MAX = 50

export const MetricSearchQuerySchema = z.object({
  q: z.string().trim().max(60).optional(),
  type: z.enum(METRIC_TYPES).optional(),
  group: z.string().trim().max(40).optional(),
  /** 按编号取（逗号分隔，最多 50 个）：列头问号只取自己要的几条 */
  ids: z.string().trim().max(400).optional(),
  /** 只要可用于规则条件的指标（P6-07：条件构造器的指标级联用） */
  ruleUsable: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
})
export type MetricSearchQuery = z.infer<typeof MetricSearchQuerySchema>

export const metricGroups = (extra: readonly MetricDefinition[] = []): string[] => [...new Set([...METRIC_DEFINITIONS, ...extra].map(item => item.group))]

/** 关键字同时匹配编号、名称、公式、来源与使用页面；多个词之间为“并且”。extra 是本企业的自定义指标。 */
export function searchMetrics(query: MetricSearchQuery, extra: readonly MetricDefinition[] = []) {
  const wanted = query.ids
    ? new Set(
        query.ids
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
          .slice(0, METRIC_IDS_MAX),
      )
    : null
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const matched = [...METRIC_DEFINITIONS, ...extra].filter(item => {
    if (query.type && item.type !== query.type) return false
    if (query.group && item.group !== query.group) return false
    if (query.ruleUsable && !item.ruleUse) return false
    if (wanted && !wanted.has(item.id)) return false
    const haystack = `${item.id} ${item.name} ${item.definition} ${item.source} ${item.pages.join(' ')}`.toLowerCase()
    return words.every(word => haystack.includes(word))
  })
  const start = (query.page - 1) * query.pageSize
  return { items: matched.slice(start, start + query.pageSize), total: matched.length }
}
export { METRIC_DEFINITIONS }
