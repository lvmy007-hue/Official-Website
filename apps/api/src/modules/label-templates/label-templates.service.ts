import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  DEFAULT_BOX_NO_RULE,
  DEFAULT_LABEL_OPTIONS,
  LABEL_TEMPLATE_ACTIONS,
  LABEL_TEMPLATE_BLOCKED_NO_PERMISSION,
  LABEL_TEMPLATE_LIMIT,
  LABEL_TEMPLATE_MANAGE,
  LABEL_TEMPLATE_READ,
  LabelTemplateCreateBodySchema,
  LabelTemplateListQuerySchema,
  LabelTemplateUpdateBodySchema,
  normalizeBoxNoRule,
  normalizeLabelOptions,
  type BoxNoRule,
  type LabelOptions,
  type LabelPaper,
  type LabelTemplateListResponse,
  type LabelTemplateRow,
} from '@nova/api-contracts'
import type { LabelTemplate, Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'

const LABEL = '标签模板'
const NAME_CONFLICT = '已经有同名的标签模板，或默认模板刚被别人改过，请换个名称或刷新后重试'
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'
const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })

type Tx = Prisma.TransactionClient

/** 生成标签时用的一份“已解析的设置”：模板，或没有模板时的内置默认。 */
export interface ResolvedLabelTemplate {
  id: string | null
  name: string
  paper: LabelPaper
  options: LabelOptions
  boxNoRule: BoxNoRule
}
/** 企业没有设置任何模板时用的内置默认：热敏纸，原产地与 SKU、件数、箱号，附页。 */
export const BUILT_IN_TEMPLATE: ResolvedLabelTemplate = { id: null, name: '默认设置', paper: 'THERMAL_4X6', options: DEFAULT_LABEL_OPTIONS, boxNoRule: DEFAULT_BOX_NO_RULE }

const auditView = (row: Pick<LabelTemplate, 'name' | 'paper' | 'isDefault' | 'options' | 'boxNoRule'>) => ({
  name: row.name,
  paper: row.paper,
  isDefault: row.isDefault,
  options: row.options,
  boxNoRule: row.boxNoRule,
})

const rowOf = (row: LabelTemplate): LabelTemplateRow => ({
  id: row.id,
  name: row.name,
  paper: row.paper as LabelPaper,
  options: normalizeLabelOptions(row.options),
  boxNoRule: normalizeBoxNoRule(row.boxNoRule),
  isDefault: row.isDefault,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

// 标签模板（P6-12，16 章第 5.1 节；freeze/api.md `/label-templates*`）：自定义箱标签的勾选项、纸张规格、箱号规则，整份保存成模板。
// 规则：
//   - 读取要 inbound.read，新增、修改、删除要 labeltemplate.manage（在服务里先于参数校验检查）；模板属于整个企业，不按店铺划分；
//   - 同企业同名唯一；全企业至多一个默认模板（部分唯一索引兜底），设默认时同一事务里取消原默认；每个企业最多 50 个模板；
//   - 修改整份替换并带乐观锁版本号，冲突 409；纸张与选项的搭配、箱号规则的校验与页面共用同一份（label-template.ts）；
//   - 删除模板不影响已生成的标签与生成记录（记录里的模板置空）；所有写操作写审计。
@Injectable()
export class LabelTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<LabelTemplateListResponse> {
    const { context } = await this.context.authorizeScoped(req, LABEL_TEMPLATE_READ, {})
    const query = LabelTemplateListQuerySchema.parse(rawQuery)
    const base: Prisma.LabelTemplateWhereInput = { tenantId: context.tenantId }
    const where: Prisma.LabelTemplateWhereInput = { ...base, ...(query.q ? { name: contains(query.q) } : {}) }
    const order: Prisma.LabelTemplateOrderByWithRelationInput[] = [{ [query.sort.field]: query.sort.dir }, { id: 'asc' }]
    const [rows, total, all, defaultRow] = await Promise.all([
      this.prisma.labelTemplate.findMany({ where, orderBy: order, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.labelTemplate.count({ where }),
      this.prisma.labelTemplate.count({ where: base }),
      this.prisma.labelTemplate.findFirst({ where: { ...base, isDefault: true }, select: { name: true } }),
    ])
    const canManage = hasPermission(context.permissions, LABEL_TEMPLATE_MANAGE)
    return {
      items: rows.map(rowOf),
      page: query.page,
      pageSize: query.pageSize,
      total,
      summary: { total: all, defaultName: defaultRow?.name ?? null },
      canManage,
      manageBlockedReason: canManage ? null : LABEL_TEMPLATE_BLOCKED_NO_PERMISSION,
    }
  }

  /** 生成标签用：指定模板就用它（不存在 404），没指定用企业默认模板，都没有用内置默认。 */
  async resolve(tenantId: string, templateId: string | null | undefined, client: Pick<Tx, 'labelTemplate'> = this.prisma): Promise<ResolvedLabelTemplate> {
    const row = templateId ? await client.labelTemplate.findFirst({ where: { id: templateId, tenantId } }) : await client.labelTemplate.findFirst({ where: { tenantId, isDefault: true } })
    if (!row) {
      if (templateId) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在，可能已被删除，请刷新后重新选择`)
      return BUILT_IN_TEMPLATE
    }
    return { id: row.id, name: row.name, paper: row.paper as LabelPaper, options: normalizeLabelOptions(row.options), boxNoRule: normalizeBoxNoRule(row.boxNoRule) }
  }

  /** 取消现有的默认模板（版本号加一，让手里还是旧版本的人修改时得到冲突提示）。 */
  private async clearDefault(tx: Tx, tenantId: string, exceptId?: string) {
    await tx.labelTemplate.updateMany({ where: { tenantId, isDefault: true, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, data: { isDefault: false, version: { increment: 1 } } })
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<LabelTemplateRow> {
    const { context } = await this.context.authorizeScoped(req, LABEL_TEMPLATE_MANAGE, {})
    const body = LabelTemplateCreateBodySchema.parse(rawBody)
    try {
      const row = await this.prisma.$transaction(async tx => {
        const existing = await tx.labelTemplate.count({ where: { tenantId: context.tenantId } })
        if (existing >= LABEL_TEMPLATE_LIMIT) throw appError('CONFLICT', `每个企业最多保存 ${LABEL_TEMPLATE_LIMIT} 个标签模板，请先删除不用的`)
        // 第一个模板自动成为默认
        const makeDefault = body.isDefault || existing === 0
        if (makeDefault) await this.clearDefault(tx, context.tenantId)
        const created = await tx.labelTemplate.create({
          data: {
            tenantId: context.tenantId,
            name: body.name,
            paper: body.paper,
            options: body.options as unknown as Prisma.InputJsonValue,
            boxNoRule: body.boxNoRule as unknown as Prisma.InputJsonValue,
            isDefault: makeDefault,
            createdBy: context.userId,
          },
        })
        await this.audit.record(req, { action: LABEL_TEMPLATE_ACTIONS.created, resourceType: 'LabelTemplate', resourceId: created.id, after: auditView(created) }, { client: tx })
        return created
      })
      return rowOf(row)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT, { fieldErrors: { name: ['已有同名的标签模板'] } })
      throw error
    }
  }

  private async load(tenantId: string, id: string): Promise<LabelTemplate> {
    const row = await this.prisma.labelTemplate.findFirst({ where: { id, tenantId } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    return row
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<LabelTemplateRow> {
    const { context } = await this.context.authorizeScoped(req, LABEL_TEMPLATE_MANAGE, {})
    const body = LabelTemplateUpdateBodySchema.parse(rawBody)
    const current = await this.load(context.tenantId, id)
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.isDefault) await this.clearDefault(tx, context.tenantId, current.id)
        const next = await updateWithVersion(
          tx.labelTemplate,
          { id: current.id, tenantId: context.tenantId },
          body.version,
          { name: body.name, paper: body.paper, options: body.options as unknown as Prisma.InputJsonValue, boxNoRule: body.boxNoRule as unknown as Prisma.InputJsonValue, isDefault: body.isDefault },
          { label: LABEL },
        )
        await this.audit.record(
          req,
          { action: LABEL_TEMPLATE_ACTIONS.updated, resourceType: 'LabelTemplate', resourceId: current.id, before: auditView(current), after: auditView(next) },
          { client: tx },
        )
        return next
      })
      return rowOf(row)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT, { fieldErrors: { name: ['已有同名的标签模板'] } })
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string): Promise<{ id: string }> {
    const { context } = await this.context.authorizeScoped(req, LABEL_TEMPLATE_MANAGE, {})
    const current = await this.load(context.tenantId, id)
    await this.prisma.$transaction(async tx => {
      await tx.labelTemplate.deleteMany({ where: { id: current.id, tenantId: context.tenantId } })
      await this.audit.record(req, { action: LABEL_TEMPLATE_ACTIONS.deleted, resourceType: 'LabelTemplate', resourceId: current.id, before: auditView(current) }, { client: tx })
    })
    return { id: current.id }
  }
}
