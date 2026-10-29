import { z } from 'zod'
import { COMPARE_MODES, DISPLAY_CURRENCIES, SCOPE_MAX_DAYS, US_MARKETPLACE_ID } from './scope-search.js'

// 统一查询契约（P1-11，依据 10 章 10.4、12 章 12.2）。
// 前端地址栏参数、表格数据源、后端接口三方共用这一份定义。
// 只用纯 TypeScript 与 zod，不依赖任何 Node 专有能力，前端可直接引用。

// ---- 常量 ----

// 站点、时间范围上限、对比模式、币种口径与范围参数键名在 scope-search.ts（不依赖 zod，前端首屏用）。
export const PAGE_SIZE_DEFAULT = 50
export const PAGE_SIZE_MAX = 200
/** 表格无限滚动每块行数；前端最多缓存 10 块。 */
export const GRID_BLOCK_SIZE = 100
export const GRID_MAX_CACHED_BLOCKS = 10
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// ---- 范围参数（全局范围栏）----

// 接口收到的是逗号分隔的字符串；前端路由会把已校验的结果（数组）再交给下一层路由校验，所以数组也接受。
const idList = z
  .union([
    z
      .string()
      .max(2000)
      .transform(value =>
        value
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
      ),
    z.array(z.string().max(64)).max(100),
  ])
  .pipe(z.array(z.string().regex(ID_PATTERN, '编号格式不正确')).max(100, '一次最多选择 100 个'))

const businessDate = z
  .string()
  .regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD')
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), '日期不存在')

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
}

const scopeShape = {
  legalEntityIds: idList.optional(),
  storeIds: idList.optional(),
  marketplaceId: z.literal(US_MARKETPLACE_ID, { error: '站点只支持亚马逊美国站' }).default(US_MARKETPLACE_ID),
  from: businessDate.optional(),
  to: businessDate.optional(),
  compare: z.enum(COMPARE_MODES).default('none'),
  compareFrom: businessDate.optional(),
  compareTo: businessDate.optional(),
  displayCurrency: z.enum(DISPLAY_CURRENCIES).default('USD'),
}

type ScopeShape = typeof scopeShape

function refineScope(value: z.infer<z.ZodObject<ScopeShape>>, ctx: z.RefinementCtx) {
  if ((value.from && !value.to) || (!value.from && value.to)) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: '开始日期与结束日期需要同时提供' })
    return
  }
  if (value.from && value.to) {
    const span = daysBetween(value.from, value.to)
    if (span < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: '结束日期不能早于开始日期' })
    else if (span + 1 > SCOPE_MAX_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `时间范围不能超过 ${SCOPE_MAX_DAYS} 天` })
  }
  if (value.compare === 'custom') {
    if (!value.compareFrom || !value.compareTo) ctx.addIssue({ code: 'custom', path: ['compareFrom'], message: '自定义对比期需要同时提供开始与结束日期' })
    else if (daysBetween(value.compareFrom, value.compareTo) < 0) ctx.addIssue({ code: 'custom', path: ['compareTo'], message: '对比期结束日期不能早于开始日期' })
  } else if (value.compareFrom || value.compareTo) {
    ctx.addIssue({ code: 'custom', path: ['compare'], message: '只有自定义对比才需要对比期日期' })
  }
  if (value.compare !== 'none' && !value.from) {
    ctx.addIssue({ code: 'custom', path: ['compare'], message: '选择对比期前需要先选择时间范围' })
  }
}

/**
 * 范围选择（只取主体、店铺、站点三项，其余参数忽略）：服务端数据范围解析使用。
 * 站点只接受亚马逊美国站，其他站点按 422 拒绝。
 */
export const ScopeSelectionSchema = z.object({
  legalEntityIds: scopeShape.legalEntityIds,
  storeIds: scopeShape.storeIds,
  marketplaceId: z.literal(US_MARKETPLACE_ID, { error: '站点只支持亚马逊美国站' }).optional(),
})
export type ScopeSelection = z.infer<typeof ScopeSelectionSchema>

/** 全局范围栏参数：法律主体、店铺、站点（固定美国站）、时间范围、对比期、币种口径。 */
export const ScopeQuerySchema = z.object(scopeShape).strict().superRefine(refineScope)
export type ScopeQuery = z.infer<typeof ScopeQuerySchema>

/** 地址栏使用：范围参数规则与 ScopeQuerySchema 完全相同，但允许页面自己的筛选参数共存（由页面各自校验）。 */
export const ScopeSearchSchema = z.object(scopeShape).passthrough().superRefine(refineScope)
// ---- 排序 ----

export type SortDirection = 'asc' | 'desc'
export type SortSpec = { field: string; dir: SortDirection }

/** 排序参数写法：`field` 或 `field:asc` / `field:desc`；缺省方向为升序。 */
export function parseSortParam(raw: string): SortSpec | null {
  const match = /^([A-Za-z][A-Za-z0-9_]{0,63})(?::(asc|desc))?$/.exec(raw.trim())
  return match ? { field: match[1], dir: (match[2] as SortDirection | undefined) ?? 'asc' } : null
}

export function formatSortParam(sort: SortSpec): string {
  return `${sort.field}:${sort.dir}`
}

/** 只接受白名单字段（有索引支撑），其他字段一律拒绝。 */
export function sortSchema<const F extends readonly string[]>(whitelist: F, fallback: SortSpec & { field: F[number] }) {
  return z
    .string()
    .max(80)
    .optional()
    .transform((raw, ctx): SortSpec => {
      if (raw === undefined || raw === '') return fallback
      const parsed = parseSortParam(raw)
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: '排序参数格式应为“字段:asc”或“字段:desc”' })
        return fallback
      }
      if (!whitelist.includes(parsed.field)) {
        ctx.addIssue({ code: 'custom', message: `不支持按“${parsed.field}”排序，可用字段：${whitelist.join('、')}` })
        return fallback
      }
      return parsed
    })
}

// ---- 分页 ----

const pageSize = z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT)

/** 页码分页：中小表（成员、角色、规则、供应商、采购单、连接）。 */
export const PageParamsSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize,
})
export type PageParams = z.infer<typeof PageParamsSchema>

/** 游标分页：海量表（订单、订单行、费用事件、财务交易、库存台账、广告指标、词级数据、审计日志）。 */
export const CursorParamsSchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  pageSize,
})
export type CursorParams = z.infer<typeof CursorParamsSchema>

export type PageResult<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type CursorPageInfo = {
  pageSize: number
  /** 下一页游标；没有更多数据时为 null。游标由服务端签名，前端只原样回传。 */
  nextCursor: string | null
  hasMore: boolean
  /** 约数。来源为汇总表计数或统计估算；精确总数需要按需异步计算。 */
  approxTotal: number | null
}

export type CursorResult<T> = { items: T[]; pageInfo: CursorPageInfo }

// ---- 筛选 ----

export type FilterSpec =
  { type: 'text'; max?: number } | { type: 'enum'; values: readonly [string, ...string[]]; multiple?: boolean } | { type: 'bool' } | { type: 'number'; min?: number; max?: number }

export type FilterSpecs = Record<string, FilterSpec>

function filterField(spec: FilterSpec): z.ZodTypeAny {
  switch (spec.type) {
    case 'text':
      return z
        .string()
        .trim()
        .min(1)
        .max(spec.max ?? 200)
        .optional()
    case 'enum': {
      const one = z.enum(spec.values)
      return spec.multiple
        ? z
            .string()
            .transform(value =>
              value
                .split(',')
                .map(item => item.trim())
                .filter(Boolean),
            )
            .pipe(z.array(one).min(1).max(spec.values.length))
            .optional()
        : one.optional()
    }
    case 'bool':
      return z
        .enum(['true', 'false'])
        .transform(value => value === 'true')
        .optional()
    case 'number': {
      let n = z.coerce.number()
      if (spec.min !== undefined) n = n.min(spec.min)
      if (spec.max !== undefined) n = n.max(spec.max)
      return n.optional()
    }
  }
}

// ---- 列表查询（组合）----

export type ListQueryConfig<S extends readonly string[], F extends FilterSpecs> = {
  /** 允许排序的字段，必须有索引支撑。 */
  sortable: S
  defaultSort: SortSpec & { field: S[number] }
  /** 本页专属筛选；全局搜索词 `q` 固定存在。 */
  filters?: F
  /** 是否带全局范围参数，默认带。 */
  scope?: boolean
}

type FilterValue<S extends FilterSpec> = S extends { type: 'text' }
  ? string
  : S extends { type: 'enum'; values: infer V extends readonly string[]; multiple: true }
    ? V[number][]
    : S extends { type: 'enum'; values: infer V extends readonly string[] }
      ? V[number]
      : S extends { type: 'bool' }
        ? boolean
        : S extends { type: 'number' }
          ? number
          : never

type FilterOutput<F extends FilterSpecs> = { [K in keyof F]?: FilterValue<F[K]> }

function buildShape<S extends readonly string[], F extends FilterSpecs>(config: ListQueryConfig<S, F>) {
  const filters: Record<string, z.ZodTypeAny> = {}
  for (const [key, spec] of Object.entries(config.filters ?? {})) filters[key] = filterField(spec)
  return {
    ...(config.scope === false ? {} : scopeShape),
    q: z.string().trim().min(1).max(120).optional(),
    sort: sortSchema(config.sortable, config.defaultSort),
    ...filters,
  }
}

/** 页码分页的列表查询。未知参数一律拒绝，避免“以为生效实际被忽略”的筛选。 */
export function pageListQuery<const S extends readonly string[], const F extends FilterSpecs = Record<never, never>>(config: ListQueryConfig<S, F>) {
  return z
    .object({ ...PageParamsSchema.shape, ...buildShape(config) })
    .strict()
    .superRefine((value, ctx) => {
      if (config.scope !== false) refineScope(value as never, ctx)
    }) as unknown as z.ZodType<PageParams & Partial<ScopeQuery> & { q?: string; sort: SortSpec } & FilterOutput<F>, unknown>
}

/** 游标分页的列表查询。 */
export function cursorListQuery<const S extends readonly string[], const F extends FilterSpecs = Record<never, never>>(config: ListQueryConfig<S, F>) {
  return z
    .object({ ...CursorParamsSchema.shape, ...buildShape(config) })
    .strict()
    .superRefine((value, ctx) => {
      if (config.scope !== false) refineScope(value as never, ctx)
    }) as unknown as z.ZodType<CursorParams & Partial<ScopeQuery> & { q?: string; sort: SortSpec } & FilterOutput<F>, unknown>
}

// ---- 查询条件摘要（游标绑定与缓存键）----

/** 去掉分页与游标后的查询条件，用于生成游标绑定值与前端缓存键。 */
export function queryConditions(query: Record<string, unknown>): Record<string, unknown> {
  const { cursor: _cursor, page: _page, pageSize: _pageSize, ...rest } = query
  const entries = Object.entries(rest).filter(([, value]) => value !== undefined)
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** 稳定的字符串化：键按字典序排列，保证同一组条件得到同一串。 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const body = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    return `{${body.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
