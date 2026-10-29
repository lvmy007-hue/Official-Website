import { Injectable } from '@nestjs/common'
import {
  CUSTOM_METRIC_MAX,
  evalMetricExpr,
  expressionAst,
  gatesOfRefs,
  rangeTooLong,
  REPORT_PAGE_MAX,
  REPORT_QUERY_TIMEOUT_MS,
  REPORTS_READ,
  ReportQuerySchema,
  sourceByCode,
  type ReportQueryResult,
  type ReportSourceSpec,
  type SourceColumn,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { ReportAdapters } from './report-adapters'

// 数据源查询（P6-32）：先 reports.read，再数据源自己的权限，最后才校验参数。
// 自定义指标按查看人的字段权限整列去掉。每次查询有行数上限（沿用数据源的页大小）和 8 秒超时。

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT')), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

@Injectable()
export class ReportQueryService {
  constructor(
    private readonly context: ContextService,
    private readonly prisma: PrismaService,
    private readonly adapters: ReportAdapters,
  ) {}

  async query(req: RequestWithContext, code: string, rawQuery: Record<string, string>, rawBody: unknown): Promise<ReportQueryResult> {
    await this.context.authorize(req, REPORTS_READ)
    const source = sourceByCode(code)
    if (!source) throw appError('RESOURCE_NOT_FOUND', '没有这个数据源')
    const context = await this.context.authorize(req, source.permission)
    const merged = { from: rawQuery.from, to: rawQuery.to, ...(rawBody && typeof rawBody === 'object' ? rawBody : {}) }
    const body = ReportQuerySchema.parse(merged)
    if (rangeTooLong(body.from, body.to)) throw appError('VALIDATION_FAILED', `日期范围最长 ${366} 天`, { fieldErrors: { to: ['日期范围最长 366 天'] } })
    if (!source.dimensions.some(item => item.code === body.dimension)) throw appError('VALIDATION_FAILED', '这个数据源没有这个维度', { fieldErrors: { dimension: ['维度不适用于这个数据源'] } })
    return this.execute(req, source, context.tenantId, context.permissions, rawQuery, body)
  }

  async execute(
    req: RequestWithContext,
    source: ReportSourceSpec,
    tenantId: string,
    permissions: readonly string[],
    rawQuery: Record<string, string>,
    body: { dimension: string; metrics: string[]; cursor?: string; pageSize?: number; q?: string; from?: string; to?: string },
  ): Promise<ReportQueryResult> {
    const started = Date.now()
    const pageSize = body.pageSize ?? 50
    if (pageSize > REPORT_PAGE_MAX) throw appError('VALIDATION_FAILED', `每页最多 ${REPORT_PAGE_MAX} 行`, { fieldErrors: { pageSize: [`每页最多 ${REPORT_PAGE_MAX} 行`] } })
    const byKey = new Map(source.columns.map(column => [column.key, column]))
    const customKeys = body.metrics.filter(key => !byKey.has(key))
    const tenantCustoms = customKeys.length ? await this.prisma.customMetric.findMany({ where: { tenantId }, take: CUSTOM_METRIC_MAX }) : []
    const customByKey = new Map(tenantCustoms.map(row => [row.key, row]))
    if (customKeys.some(key => !customByKey.has(key))) {
      throw appError('VALIDATION_FAILED', '有指标不在这个数据源或自定义指标里', { fieldErrors: { metrics: customKeys.filter(key => !customByKey.has(key)) } })
    }
    const restrictions: string[] = []
    const hidden = new Set<string>()
    const customColumns: Array<{ key: string; label: string; format: SourceColumn['format']; ast: NonNullable<ReturnType<typeof expressionAst>> }> = []
    // 公式可以引用别的自定义指标：门要沿引用链一直查下去，否则能借一层自定义指标绕过字段权限。
    const closure = (key: string, seen: Set<string>) => {
      if (seen.has(key)) return
      seen.add(key)
      const ast = expressionAst(customByKey.get(key)?.expression)
      if (!ast) return
      for (const ref of refsOf(ast)) if (customByKey.has(ref)) closure(ref, seen)
    }
    const computed = new Set<string>()
    for (const key of customKeys) {
      const row = customByKey.get(key)!
      if (!row.dimensions.includes(body.dimension)) {
        restrictions.push(`自定义指标 ${row.name} 不适用于维度 ${body.dimension}`)
        hidden.add(row.key)
        continue
      }
      const chain = new Set<string>()
      closure(key, chain)
      const refs = [...chain].flatMap(item => {
        const ast = expressionAst(customByKey.get(item)?.expression)
        return ast ? refsOf(ast).filter(ref => !customByKey.has(ref)) : []
      })
      const broken = [...chain].some(item => !expressionAst(customByKey.get(item)?.expression))
      const missing = gatesOfRefs(refs).filter(gate => !hasPermission(permissions, gate))
      if (broken || missing.length) {
        restrictions.push(missing.length ? `自定义指标 ${row.name} 需要权限：${missing.join('、')}` : `自定义指标 ${row.name} 的公式无法计算`)
        hidden.add(row.key)
        continue
      }
      for (const item of chain) computed.add(item)
    }
    // 参与计算的自定义指标（含被引用的）都求值，但只有被点名且未隐藏的才进入列。
    for (const key of computed) {
      const row = customByKey.get(key)!
      const ast = expressionAst(row.expression)!
      const format = row.format && typeof row.format === 'object' && 'kind' in row.format ? String((row.format as { kind: unknown }).kind) : 'number'
      customColumns.push({ key: row.key, label: row.name, format: format as SourceColumn['format'], ast })
    }
    const shown = new Set(customKeys.filter(key => !hidden.has(key)))
    let page
    try {
      page = await withTimeout(
        this.adapters.load(source, req, rawQuery, { dimension: body.dimension, pageSize, cursor: body.cursor, q: body.q, from: body.from, to: body.to }),
        REPORT_QUERY_TIMEOUT_MS,
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'TIMEOUT') throw appError('QUERY_TIMEOUT', '查询超时，请缩小日期范围或减少指标')
      throw error
    }
    for (const key of page.hiddenKeys) hidden.add(key)
    const columns = [
      ...body.metrics.filter(key => byKey.has(key) && !hidden.has(key)).map(key => byKey.get(key)!),
      ...customColumns.filter(column => shown.has(column.key)).map(column => ({ key: column.key, label: column.label, metricId: column.key, format: column.format })),
    ]
    const blocked = source.columns.filter(column => hidden.has(column.key))
    const rows = page.rows.map(row => {
      const working: Record<string, number | null> = { ...row.values }
      // 查看人看不到的列，即使服务返回了值也不能参与公式。
      for (const column of blocked) {
        working[column.key] = null
        if (column.metricId) working[column.metricId] = null
      }
      for (let pass = 0; pass < customColumns.length; pass += 1) {
        for (const column of customColumns) working[column.key] = evalMetricExpr(column.ast, working)
      }
      const values: Record<string, number | null> = {}
      for (const column of columns) values[column.key] = working[column.key] ?? null
      return { id: row.id, label: row.label, values }
    })
    return {
      columns,
      rows,
      pageInfo: { nextCursor: page.nextCursor, hasMore: page.hasMore, pageSize },
      restrictions: [...restrictions, ...page.restrictions],
      truncated: page.truncated,
      elapsedMs: Date.now() - started,
    }
  }
}

function refsOf(ast: NonNullable<ReturnType<typeof expressionAst>>): string[] {
  const refs: string[] = []
  const walk = (node: typeof ast) => {
    if (node.t === 'ref') refs.push(node.id)
    else if (node.t === 'neg') walk(node.x)
    else if (node.t === 'bin') {
      walk(node.l)
      walk(node.r)
    }
  }
  walk(ast)
  return refs
}
