import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  LENGTH_UNITS,
  PACKING_FIELDS,
  PackingListMappingBodySchema,
  SKU_ALIAS_ACTIONS,
  SKU_ALIAS_BLOCKED_NO_PERMISSION,
  SKU_ALIAS_MANAGE,
  SKU_ALIAS_READ,
  WEIGHT_UNITS,
  type PackingField,
  type PackingMappingListResponse,
  type PackingMappingOneResponse,
  type PackingMappingRow,
  type PackingUnits,
} from '@nova/api-contracts'
import { Prisma, type PackingListMapping } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'

const LABEL = '装箱单列映射'
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'
const MAX_ROWS = 500

type Supplier = { id: string; code: string; name: string }
export interface SavedPackingMapping {
  columns: Partial<Record<PackingField, string>>
  units: Partial<PackingUnits> | null
  version: number
}

const columnsOf = (value: unknown): Partial<Record<PackingField, string>> => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const result: Partial<Record<PackingField, string>> = {}
  for (const field of PACKING_FIELDS) {
    const item = source[field]
    if (typeof item === 'string' && item.trim() !== '') result[field] = item
  }
  return result
}
const unitsOf = (value: unknown): Partial<PackingUnits> | null => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  if (!source) return null
  const length = LENGTH_UNITS.find(unit => unit === source.length)
  const weight = WEIGHT_UNITS.find(unit => unit === source.weight)
  return length || weight ? { ...(length ? { length } : {}), ...(weight ? { weight } : {}) } : null
}
const auditView = (row: Pick<PackingListMapping, 'columns' | 'units'>) => ({ columns: columnsOf(row.columns), units: unitsOf(row.units) })

// 供应商装箱单的列映射（P6-11）：每个供应商一份，记“标准列 → 该供应商装箱单里的表头文字”与尺寸重量的单位；下次传同一供应商的装箱单自动套用。
// 读取要 inbound.read，保存与删除要 skualias.manage；保存已有映射必须带版本号（乐观锁），首次保存不带；写审计。
@Injectable()
export class PackingMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private rowOf(row: PackingListMapping, supplier: Supplier): PackingMappingRow {
    return {
      supplierId: supplier.id,
      supplierCode: supplier.code,
      supplierName: supplier.name,
      columns: columnsOf(row.columns),
      units: unitsOf(row.units),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private async supplierOf(tenantId: string, supplierId: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true, code: true, name: true } })
    if (!supplier) throw appError('RESOURCE_NOT_FOUND', '供应商不存在')
    return supplier
  }

  /** 供装箱单匹配用：该供应商保存的列映射（没有为 null）。 */
  async savedFor(tenantId: string, supplierId: string | null): Promise<SavedPackingMapping | null> {
    if (!supplierId) return null
    const row = await this.prisma.packingListMapping.findFirst({ where: { tenantId, supplierId } })
    return row ? { columns: columnsOf(row.columns), units: unitsOf(row.units), version: row.version } : null
  }

  async list(req: RequestWithContext): Promise<PackingMappingListResponse> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_READ, {})
    const rows = await this.prisma.packingListMapping.findMany({
      where: { tenantId: context.tenantId },
      include: { supplier: { select: { id: true, code: true, name: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: MAX_ROWS,
    })
    const canManage = hasPermission(context.permissions, SKU_ALIAS_MANAGE)
    return { items: rows.map(row => this.rowOf(row, row.supplier)), canManage, manageBlockedReason: canManage ? null : SKU_ALIAS_BLOCKED_NO_PERMISSION }
  }

  async one(req: RequestWithContext, supplierId: string): Promise<PackingMappingOneResponse> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_READ, {})
    const supplier = await this.supplierOf(context.tenantId, supplierId)
    const row = await this.prisma.packingListMapping.findFirst({ where: { tenantId: context.tenantId, supplierId } })
    const canManage = hasPermission(context.permissions, SKU_ALIAS_MANAGE)
    return { supplier, mapping: row ? this.rowOf(row, supplier) : null, canManage, manageBlockedReason: canManage ? null : SKU_ALIAS_BLOCKED_NO_PERMISSION }
  }

  async save(req: RequestWithContext, supplierId: string, rawBody: unknown): Promise<PackingMappingRow> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_MANAGE, {})
    const body = PackingListMappingBodySchema.parse(rawBody)
    const supplier = await this.supplierOf(context.tenantId, supplierId)
    const columns = columnsOf(body.columns)
    const units = unitsOf(body.units)
    const data = { columns: columns as Prisma.InputJsonValue, units: units ? (units as Prisma.InputJsonValue) : Prisma.DbNull }
    const existing = await this.prisma.packingListMapping.findFirst({ where: { tenantId: context.tenantId, supplierId } })
    if (existing && body.version === undefined) throw appError('CONFLICT', '这个供应商已经保存过列映射，请刷新后在原来的基础上修改', { details: { version: existing.version } })
    if (!existing && body.version !== undefined) throw appError('CONFLICT', '这个供应商的列映射已被别人删除，请刷新后重新保存')
    try {
      const saved = await this.prisma.$transaction(async tx => {
        const next = existing
          ? await updateWithVersion(tx.packingListMapping, { id: existing.id, tenantId: context.tenantId }, body.version!, { ...data, updatedBy: context.userId }, { label: LABEL })
          : await tx.packingListMapping.create({ data: { ...data, tenantId: context.tenantId, supplierId, updatedBy: context.userId } })
        await this.audit.record(
          req,
          {
            action: SKU_ALIAS_ACTIONS.mappingSaved,
            resourceType: 'PackingListMapping',
            resourceId: next.id,
            ...(existing ? { before: auditView(existing) } : {}),
            after: auditView(next),
            detail: { supplierId },
          },
          { client: tx },
        )
        return next
      })
      return this.rowOf(saved, supplier)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '这个供应商的列映射刚被别人保存过，请刷新后重试')
      throw error
    }
  }

  async remove(req: RequestWithContext, supplierId: string): Promise<{ supplierId: string }> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_MANAGE, {})
    const supplier = await this.supplierOf(context.tenantId, supplierId)
    const existing = await this.prisma.packingListMapping.findFirst({ where: { tenantId: context.tenantId, supplierId } })
    if (!existing) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    await this.prisma.$transaction(async tx => {
      await tx.packingListMapping.deleteMany({ where: { id: existing.id, tenantId: context.tenantId } })
      await this.audit.record(
        req,
        { action: SKU_ALIAS_ACTIONS.mappingDeleted, resourceType: 'PackingListMapping', resourceId: existing.id, before: auditView(existing), detail: { supplierId } },
        { client: tx },
      )
    })
    return { supplierId: supplier.id }
  }
}
