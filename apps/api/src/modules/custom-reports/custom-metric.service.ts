import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  allDimensionCodes,
  CUSTOM_METRIC_MAX,
  CustomMetricBodySchema,
  CustomMetricValidateSchema,
  ReportListQuerySchema,
  expressionAst,
  expressionText,
  gatesOfRefs,
  METRIC_DEFINITIONS,
  metricCycle,
  parseMetricExpr,
  REPORTS_CUSTOM_WRITE,
  REPORTS_READ,
  type MetricName,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'

// 自定义指标（P6-32）：只能引用字典里已有的指标（含本企业其他自定义指标）。保存后由指标字典接口合并展示，类型为“自定义”。

const viewOf = (row: { id: string; key: string; name: string; expression: unknown; dimensions: string[]; format: unknown; version: number; createdBy: string; updatedAt: Date }) => ({
  id: row.id,
  key: row.key,
  name: row.name,
  expression: expressionText(row.expression),
  dimensions: row.dimensions,
  format: row.format && typeof row.format === 'object' && 'kind' in row.format ? String((row.format as { kind: unknown }).kind) : 'number',
  version: row.version,
  createdBy: row.createdBy,
  updatedAt: row.updatedAt.toISOString(),
})

@Injectable()
export class CustomMetricService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>) {
    const context = await this.context.authorize(req, REPORTS_READ)
    const query = ReportListQuerySchema.parse(rawQuery)
    const page = query.page
    const pageSize = query.pageSize
    const q = query.q
    const where = { tenantId: context.tenantId, ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}) }
    const [total, rows] = await Promise.all([
      this.prisma.customMetric.count({ where }),
      this.prisma.customMetric.findMany({ where, orderBy: { key: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ])
    return { items: rows.map(viewOf), total, page, pageSize }
  }

  async validate(req: RequestWithContext, raw: unknown) {
    const context = await this.context.authorize(req, REPORTS_READ)
    const body = CustomMetricValidateSchema.parse(raw)
    const checked = await this.check(context.tenantId, context.permissions, body.expression, body.key)
    return { ok: checked.issues.length === 0, issues: checked.issues, refs: checked.refs, gates: checked.gates }
  }

  async create(req: RequestWithContext, raw: unknown) {
    const context = await this.context.authorize(req, REPORTS_CUSTOM_WRITE)
    const body = CustomMetricBodySchema.parse(raw)
    this.assertDimensions(body.dimensions)
    const checked = await this.check(context.tenantId, context.permissions, body.expression, body.key)
    if (checked.issues.length) throw appError('VALIDATION_FAILED', checked.issues[0]!, { fieldErrors: { expression: checked.issues } })
    const count = await this.prisma.customMetric.count({ where: { tenantId: context.tenantId } })
    if (count >= CUSTOM_METRIC_MAX) throw appError('QUOTA_EXCEEDED', `每个企业最多 ${CUSTOM_METRIC_MAX} 个自定义指标`)
    try {
      const row = await this.prisma.customMetric.create({
        data: {
          tenantId: context.tenantId,
          key: body.key,
          name: body.name,
          expression: { text: body.expression, ast: checked.ast } as Prisma.InputJsonValue,
          dimensions: body.dimensions,
          format: { kind: body.format },
          createdBy: context.userId,
        },
      })
      if (req.params) req.params.id = row.id
      return viewOf(row)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw appError('CONFLICT', '这个编号已经有了')
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, raw: unknown) {
    const context = await this.context.authorize(req, REPORTS_CUSTOM_WRITE)
    const body = CustomMetricBodySchema.parse(raw)
    if (!body.version) throw appError('VALIDATION_FAILED', '更新必须带上当前看到的版本号 version', { fieldErrors: { version: ['必须是不小于 1 的整数'] } })
    this.assertDimensions(body.dimensions)
    const current = await this.prisma.customMetric.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '自定义指标不存在')
    if (current.key !== body.key) throw appError('VALIDATION_FAILED', '编号创建后不能修改', { fieldErrors: { key: ['编号创建后不能修改'] } })
    const checked = await this.check(context.tenantId, context.permissions, body.expression, body.key)
    if (checked.issues.length) throw appError('VALIDATION_FAILED', checked.issues[0]!, { fieldErrors: { expression: checked.issues } })
    const row = await updateWithVersion(
      this.prisma.customMetric,
      { id, tenantId: context.tenantId },
      body.version,
      {
        name: body.name,
        expression: { text: body.expression, ast: checked.ast },
        dimensions: body.dimensions,
        format: { kind: body.format },
      },
      { label: '自定义指标' },
    )
    return viewOf(row)
  }

  async remove(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, REPORTS_CUSTOM_WRITE)
    const result = await this.prisma.customMetric.deleteMany({ where: { id, tenantId: context.tenantId } })
    if (result.count === 0) throw appError('RESOURCE_NOT_FOUND', '自定义指标不存在')
    return { id }
  }

  private assertDimensions(dimensions: readonly string[]) {
    const allowed = allDimensionCodes()
    const bad = dimensions.filter(code => !allowed.has(code))
    if (bad.length) throw appError('VALIDATION_FAILED', '适用维度必须是数据源里已有的维度', { fieldErrors: { dimensions: bad.map(code => `${code} 不是数据源维度`) } })
  }

  private async check(tenantId: string, permissions: readonly string[], expression: string, key?: string) {
    const rows = await this.prisma.customMetric.findMany({ where: { tenantId }, select: { key: true, name: true, expression: true }, take: CUSTOM_METRIC_MAX })
    const known: MetricName[] = [...METRIC_DEFINITIONS.map(item => ({ id: item.id, name: item.name })), ...rows.map(row => ({ id: row.key, name: row.name }))]
    const parsed = parseMetricExpr(expression, known)
    const edges = new Map<string, string[]>()
    for (const row of rows) {
      const ast = expressionAst(row.expression)
      edges.set(row.key, ast ? parseMetricExpr(expressionText(row.expression), known).refs : [])
    }
    if (key) edges.set(key, parsed.refs)
    if (key && metricCycle(key, edges)) parsed.issues.push('公式循环引用了自定义指标')
    const gates = gatesOfRefs(parsed.refs)
    const missing = gates.filter(gate => !hasPermission(permissions, gate))
    if (missing.length) parsed.issues.push(`保存这个公式需要权限：${missing.join('、')}`)
    return { ...parsed, gates }
  }
}
