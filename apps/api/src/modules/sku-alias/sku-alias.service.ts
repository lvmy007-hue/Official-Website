import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  SKU_ALIAS_ACTIONS,
  SKU_ALIAS_BLOCKED_NO_PERMISSION,
  SKU_ALIAS_GENERAL,
  SKU_ALIAS_MANAGE,
  SKU_ALIAS_READ,
  SKU_ALIAS_TENANT_LIMIT,
  SkuAliasCreateBodySchema,
  SkuAliasListQuerySchema,
  SkuAliasUpdateBodySchema,
  type AliasRef,
  type SkuAliasListResponse,
  type SkuAliasRow,
  type SkuAliasSource,
} from '@nova/api-contracts'
import type { Prisma, SkuAlias } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'

const LABEL = '外部货号映射'
const DUPLICATE = '这个供应商已经有同名的外部货号映射（通用映射也不能重名），请直接修改原来的那条'
const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'

type Tx = Prisma.TransactionClient
type AliasWithSupplier = SkuAlias & { supplier: { code: string; name: string } | null }

/** 审计里记映射本身（没有敏感字段）。 */
export const aliasAudit = (row: Pick<SkuAlias, 'supplierId' | 'externalCode' | 'sku'>) => ({ supplierId: row.supplierId, externalCode: row.externalCode, sku: row.sku })

// 外部货号映射（P6-11，16 章 5.1；freeze/api.md `/sku-aliases*`）：供应商装箱单里的“外部货号”对应到我们的 SKU。
// 规则：
//   - 读取要 inbound.read，新增、修改、删除、导入要 skualias.manage（在服务里先于参数校验检查）；
//   - 供应商为空是“通用映射”，所有供应商的装箱单都可用；同一个（供应商，外部货号）只能有一条，通用映射同样不能重名（部分唯一索引兜底）；
//   - SKU 必须是商品目录里已有的卖家 SKU；每个企业最多 50000 条；
//   - 修改带乐观锁版本号；供应商不能改（换供应商请新建）；所有写操作写审计。
@Injectable()
export class SkuAliasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  /** 目录里存在的 SKU 及标题（SKU 在多个店铺里重复时取任意一条标题）。 */
  async catalogTitles(tenantId: string, skus: readonly string[], client: Pick<Tx, 'fbaProduct'> = this.prisma): Promise<Map<string, string>> {
    const wanted = [...new Set(skus)]
    if (wanted.length === 0) return new Map()
    const rows = await client.fbaProduct.findMany({ where: { tenantId, sellerSku: { in: wanted } }, select: { sellerSku: true, title: true }, distinct: ['sellerSku'], take: wanted.length })
    return new Map(rows.map(row => [row.sellerSku, row.title]))
  }

  private async rowsOf(tenantId: string, rows: AliasWithSupplier[]): Promise<SkuAliasRow[]> {
    const titles = await this.catalogTitles(
      tenantId,
      rows.map(row => row.sku),
    )
    return rows.map(row => ({
      id: row.id,
      supplierId: row.supplierId,
      supplierCode: row.supplier?.code ?? null,
      supplierName: row.supplier?.name ?? null,
      externalCode: row.externalCode,
      sku: row.sku,
      skuTitle: titles.get(row.sku) ?? null,
      source: row.source as SkuAliasSource,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }))
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<SkuAliasListResponse> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_READ, {})
    const query = SkuAliasListQuerySchema.parse(rawQuery)
    const base: Prisma.SkuAliasWhereInput = { tenantId: context.tenantId }
    const where: Prisma.SkuAliasWhereInput = {
      ...base,
      ...(query.supplierId ? { supplierId: query.supplierId === SKU_ALIAS_GENERAL ? null : query.supplierId } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.q ? { OR: [{ externalCode: contains(query.q) }, { sku: contains(query.q) }] } : {}),
    }
    const order: Prisma.SkuAliasOrderByWithRelationInput[] = [{ [query.sort.field]: query.sort.dir }, { id: 'asc' }]
    const [rows, total, all, general] = await Promise.all([
      this.prisma.skuAlias.findMany({ where, orderBy: order, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { supplier: { select: { code: true, name: true } } } }),
      this.prisma.skuAlias.count({ where }),
      this.prisma.skuAlias.count({ where: base }),
      this.prisma.skuAlias.count({ where: { ...base, supplierId: null } }),
    ])
    const canManage = hasPermission(context.permissions, SKU_ALIAS_MANAGE)
    return {
      items: await this.rowsOf(context.tenantId, rows),
      page: query.page,
      pageSize: query.pageSize,
      total,
      summary: { total: all, general, supplier: all - general },
      canManage,
      manageBlockedReason: canManage ? null : SKU_ALIAS_BLOCKED_NO_PERMISSION,
    }
  }

  /** 装箱单匹配用：这些外部货号在该供应商（以及通用）下的映射，一次查出（供应商专属与通用并存时，由匹配逻辑让专属的优先）。 */
  async lookup(tenantId: string, supplierId: string | null, keys: readonly string[], client: Pick<Tx, 'skuAlias'> = this.prisma): Promise<AliasRef[]> {
    const wanted = [...new Set(keys)].filter(key => key.length > 0 && key.length <= 120)
    if (wanted.length === 0) return []
    const rows = await client.skuAlias.findMany({
      where: { tenantId, externalCode: { in: wanted }, OR: supplierId ? [{ supplierId }, { supplierId: null }] : [{ supplierId: null }] },
      select: { supplierId: true, externalCode: true, sku: true },
      take: wanted.length * 2,
    })
    return rows
  }

  /** 在调用方的事务里把“外部货号 → SKU”记进映射表：已有同名的按新 SKU 更新（版本加一），没有的新增；返回新增与更新的条数。批量一次查、一次建、按目标 SKU 分组更新。 */
  async remember(tx: Tx, tenantId: string, userId: string, supplierId: string | null, items: ReadonlyArray<{ externalCode: string; sku: string }>, source: SkuAliasSource = 'MANUAL') {
    const wanted = new Map(items.map(item => [item.externalCode, item.sku]))
    if (wanted.size === 0) return { created: 0, updated: 0 }
    const existing = await tx.skuAlias.findMany({ where: { tenantId, supplierId, externalCode: { in: [...wanted.keys()] } }, select: { id: true, externalCode: true, sku: true }, take: wanted.size })
    const known = new Map(existing.map(row => [row.externalCode, row]))
    const toCreate = [...wanted].filter(([code]) => !known.has(code))
    if (toCreate.length > 0) {
      const total = await tx.skuAlias.count({ where: { tenantId } })
      if (total + toCreate.length > SKU_ALIAS_TENANT_LIMIT) throw appError('CONFLICT', `外部货号映射已接近上限（每个企业最多 ${SKU_ALIAS_TENANT_LIMIT} 条），请先清理不用的映射`)
      await tx.skuAlias.createMany({ data: toCreate.map(([externalCode, sku]) => ({ tenantId, supplierId, externalCode, sku, source, createdBy: userId })) })
    }
    const bySku = new Map<string, string[]>()
    for (const [code, sku] of wanted) {
      const row = known.get(code)
      if (row && row.sku !== sku) bySku.set(sku, [...(bySku.get(sku) ?? []), row.id])
    }
    let updated = 0
    for (const [sku, ids] of bySku) {
      const result = await tx.skuAlias.updateMany({ where: { tenantId, id: { in: ids } }, data: { sku, source, version: { increment: 1 } } })
      updated += result.count
    }
    return { created: toCreate.length, updated }
  }

  private async assertTargets(tenantId: string, supplierId: string | null, sku: string | null) {
    const fieldErrors: Record<string, string[]> = {}
    if (supplierId) {
      const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } })
      if (!supplier) fieldErrors.supplierId = ['供应商不存在']
    }
    if (sku) {
      const titles = await this.catalogTitles(tenantId, [sku])
      if (!titles.has(sku)) fieldErrors.sku = [`商品目录里没有 SKU ${sku}`]
    }
    if (Object.keys(fieldErrors).length > 0) throw appError('VALIDATION_FAILED', '请检查填写的内容', { fieldErrors })
  }

  private async load(tenantId: string, id: string): Promise<AliasWithSupplier> {
    const row = await this.prisma.skuAlias.findFirst({ where: { id, tenantId }, include: { supplier: { select: { code: true, name: true } } } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    return row
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<SkuAliasRow> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_MANAGE, {})
    const body = SkuAliasCreateBodySchema.parse(rawBody)
    const supplierId = body.supplierId ?? null
    await this.assertTargets(context.tenantId, supplierId, body.sku)
    try {
      const created = await this.prisma.$transaction(async tx => {
        if ((await tx.skuAlias.count({ where: { tenantId: context.tenantId } })) >= SKU_ALIAS_TENANT_LIMIT)
          throw appError('CONFLICT', `外部货号映射已达上限（每个企业最多 ${SKU_ALIAS_TENANT_LIMIT} 条），请先清理不用的映射`)
        const row = await tx.skuAlias.create({
          data: { tenantId: context.tenantId, supplierId, externalCode: body.externalCode, sku: body.sku, source: 'MANUAL', createdBy: context.userId },
          include: { supplier: { select: { code: true, name: true } } },
        })
        await this.audit.record(req, { action: SKU_ALIAS_ACTIONS.created, resourceType: 'SkuAlias', resourceId: row.id, after: aliasAudit(row) }, { client: tx })
        return row
      })
      return (await this.rowsOf(context.tenantId, [created]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', DUPLICATE, { fieldErrors: { externalCode: ['已有同名映射'] } })
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<SkuAliasRow> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_MANAGE, {})
    const body = SkuAliasUpdateBodySchema.parse(rawBody)
    const current = await this.load(context.tenantId, id)
    if (body.sku !== undefined && body.sku !== current.sku) await this.assertTargets(context.tenantId, null, body.sku)
    const data = { ...(body.externalCode !== undefined ? { externalCode: body.externalCode } : {}), ...(body.sku !== undefined ? { sku: body.sku } : {}), source: 'MANUAL' }
    try {
      const next = await this.prisma.$transaction(async tx => {
        const saved = await updateWithVersion(tx.skuAlias, { id: current.id, tenantId: context.tenantId }, body.version, data, { label: LABEL })
        await this.audit.record(req, { action: SKU_ALIAS_ACTIONS.updated, resourceType: 'SkuAlias', resourceId: current.id, before: aliasAudit(current), after: aliasAudit(saved) }, { client: tx })
        return saved
      })
      return (await this.rowsOf(context.tenantId, [{ ...next, supplier: current.supplier }]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', DUPLICATE, { fieldErrors: { externalCode: ['已有同名映射'] } })
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string): Promise<{ id: string }> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_MANAGE, {})
    const current = await this.load(context.tenantId, id)
    await this.prisma.$transaction(async tx => {
      await tx.skuAlias.deleteMany({ where: { id: current.id, tenantId: context.tenantId } })
      await this.audit.record(req, { action: SKU_ALIAS_ACTIONS.deleted, resourceType: 'SkuAlias', resourceId: current.id, before: aliasAudit(current) }, { client: tx })
    })
    return { id: current.id }
  }
}
