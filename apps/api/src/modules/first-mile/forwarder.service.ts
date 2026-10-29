import { Injectable } from '@nestjs/common'
import { ForwarderCreateBodySchema, ForwarderListQuerySchema, ForwarderUpdateBodySchema, type FirstMileMode, type ForwarderListResponse, type ForwarderRow } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { FM_READ, FM_WRITE, isUniqueViolation } from './first-mile-common'

type ForwarderWithCount = Prisma.FreightForwarderGetPayload<{ include: { _count: { select: { shipments: true } } } }>

const rowOf = (row: ForwarderWithCount): ForwarderRow => ({
  id: row.id,
  name: row.name,
  contact: row.contact,
  defaultMode: row.defaultMode as FirstMileMode | null,
  status: row.status,
  version: row.version,
  shipmentCount: row._count.shipments,
})
const snapshot = (row: { name: string; contact: string | null; defaultMode: string | null; status: string }) => ({
  name: row.name,
  contact: row.contact,
  defaultMode: row.defaultMode,
  status: row.status,
})
const duplicate = (error: unknown): never => {
  if (isUniqueViolation(error)) throw appError('CONFLICT', '已经有同名的货代', { fieldErrors: { name: ['名称已被使用'] } })
  throw error
}

// 货代档案（06 章 6.10）：名称唯一；停用后不能再用于新运单，历史运单保留。
@Injectable()
export class ForwarderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ForwarderListResponse> {
    const context = await this.context.authorize(req, FM_READ)
    const query = ForwarderListQuerySchema.parse(rawQuery)
    const where: Prisma.FreightForwarderWhereInput = {
      tenantId: context.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { contact: { contains: query.q, mode: 'insensitive' } }] } : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.freightForwarder.findMany({
        where,
        include: { _count: { select: { shipments: true } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.freightForwarder.count({ where }),
    ])
    return { items: rows.map(rowOf), total, page: query.page, pageSize: query.pageSize }
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<ForwarderRow> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = ForwarderCreateBodySchema.parse(rawBody)
    try {
      return await this.prisma.$transaction(async tx => {
        const row = await tx.freightForwarder.create({
          data: { tenantId: context.tenantId, name: body.name, contact: body.contact || null, defaultMode: body.defaultMode ?? null },
          include: { _count: { select: { shipments: true } } },
        })
        await this.audit.record(req, { action: 'FREIGHT_FORWARDER_CREATED', resourceType: 'FreightForwarder', resourceId: row.id, after: snapshot(row) }, { client: tx })
        return rowOf(row)
      })
    } catch (error) {
      return duplicate(error)
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<ForwarderRow> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version, ...changes } = ForwarderUpdateBodySchema.parse(rawBody)
    const before = await this.prisma.freightForwarder.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '货代不存在')
    const data = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.contact !== undefined ? { contact: changes.contact || null } : {}),
      ...(changes.defaultMode !== undefined ? { defaultMode: changes.defaultMode } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
    }
    try {
      return await this.prisma.$transaction(async tx => {
        const after = await updateWithVersion(tx.freightForwarder, { id, tenantId: context.tenantId }, version, data, { label: '货代' })
        await this.audit.record(req, { action: 'FREIGHT_FORWARDER_UPDATED', resourceType: 'FreightForwarder', resourceId: id, before: snapshot(before), after: snapshot(after) }, { client: tx })
        const shipments = await tx.firstMileShipment.count({ where: { tenantId: context.tenantId, forwarderId: id } })
        return rowOf({ ...after, _count: { shipments } })
      })
    } catch (error) {
      return duplicate(error)
    }
  }
}
