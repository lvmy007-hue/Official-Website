import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  CARRIER_ACTIONS,
  CARRIER_BLOCKED_NO_PERMISSION,
  CarrierCreateBodySchema,
  CarrierListQuerySchema,
  CarrierUpdateBodySchema,
  ChannelCreateBodySchema,
  ChannelUpdateBodySchema,
  type CarrierListResponse,
  type CarrierRow,
  type CarrierStatus,
  type ChannelRow,
} from '@nova/api-contracts'
import type { Carrier, CarrierChannel, Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { FM_READ, FM_WRITE, isUniqueViolation } from './first-mile-common'

const CODE_TAKEN = '这个代码已被使用，请换一个'
const IN_USE = '已有头程运单按这个渠道做了预估，不能删除；可以改为停用，停用后新运单不会再选它'
const isForeignKeyViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2003'
const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })

type ChannelWithCounts = CarrierChannel & { carrier: { name: string }; _count: { rates: number; shipments: number } }

const carrierView = (row: Carrier) => ({ name: row.name, code: row.code, status: row.status })
const channelView = (row: CarrierChannel) => ({ name: row.name, code: row.code, volumetricDivisor: Number(row.volumetricDivisor), splitFactor: Number(row.splitFactor), status: row.status })

/** 物流商与渠道（P6-26，16 章第 5.2 节）：增删改查；停用后不能被新运单选用，被运单用过的渠道删不掉只能停用；写入带版本号并写审计。 */
@Injectable()
export class CarriersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async channelRows(tenantId: string, channels: ChannelWithCounts[]): Promise<ChannelRow[]> {
    if (channels.length === 0) return []
    const regions = await this.prisma.channelRate.groupBy({
      by: ['channelId', 'region'],
      where: { tenantId, channelId: { in: channels.map(channel => channel.id) } },
      orderBy: [{ channelId: 'asc' }, { region: 'asc' }],
      take: 5000,
    })
    return channels.map(channel => ({
      kind: 'CHANNEL',
      id: channel.id,
      carrierId: channel.carrierId,
      carrierName: channel.carrier.name,
      name: channel.name,
      code: channel.code,
      volumetricDivisor: Number(channel.volumetricDivisor),
      splitFactor: Number(channel.splitFactor),
      status: channel.status as CarrierStatus,
      version: channel.version,
      rateCount: channel._count.rates,
      regions: regions.filter(row => row.channelId === channel.id).map(row => row.region),
      shipmentCount: channel._count.shipments,
    }))
  }

  private async rowsOf(tenantId: string, rows: Array<Carrier & { channels: ChannelWithCounts[] }>): Promise<CarrierRow[]> {
    const channels = await this.channelRows(
      tenantId,
      rows.flatMap(row => row.channels),
    )
    return rows.map(row => {
      const own = channels.filter(channel => channel.carrierId === row.id)
      return { kind: 'CARRIER', id: row.id, name: row.name, code: row.code, status: row.status as CarrierStatus, version: row.version, channelCount: own.length, channels: own }
    })
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<CarrierListResponse> {
    const context = await this.context.authorize(req, FM_READ)
    const query = CarrierListQuerySchema.parse(rawQuery)
    const where: Prisma.CarrierWhereInput = {
      tenantId: context.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ name: contains(query.q) }, { code: contains(query.q) }, { channels: { some: { OR: [{ name: contains(query.q) }, { code: contains(query.q) }] } } }] } : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.carrier.findMany({
        where,
        include: {
          channels: { include: { carrier: { select: { name: true } }, _count: { select: { rates: true, shipments: true } } }, orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }], take: 200 },
        },
        orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.carrier.count({ where }),
    ])
    const canManage = hasPermission(context.permissions, FM_WRITE)
    return { items: await this.rowsOf(context.tenantId, rows), total, page: query.page, pageSize: query.pageSize, canManage, manageBlockedReason: canManage ? null : CARRIER_BLOCKED_NO_PERMISSION }
  }

  async createCarrier(req: RequestWithContext, rawBody: unknown): Promise<{ id: string; version: number }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = CarrierCreateBodySchema.parse(rawBody)
    try {
      return await this.prisma.$transaction(async tx => {
        const row = await tx.carrier.create({ data: { tenantId: context.tenantId, name: body.name, code: body.code, createdBy: context.userId } })
        await this.audit.record(req, { action: CARRIER_ACTIONS.carrierCreated, resourceType: 'Carrier', resourceId: row.id, after: carrierView(row) }, { client: tx })
        return { id: row.id, version: row.version }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', CODE_TAKEN, { fieldErrors: { code: [CODE_TAKEN] } })
      throw error
    }
  }

  async updateCarrier(req: RequestWithContext, id: string, rawBody: unknown): Promise<{ id: string; version: number }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version, ...changes } = CarrierUpdateBodySchema.parse(rawBody)
    const before = await this.prisma.carrier.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '物流商不存在')
    try {
      return await this.prisma.$transaction(async tx => {
        const after = await updateWithVersion(tx.carrier, { id, tenantId: context.tenantId }, version, changes, { label: '物流商' })
        await this.audit.record(req, { action: CARRIER_ACTIONS.carrierUpdated, resourceType: 'Carrier', resourceId: id, before: carrierView(before), after: carrierView(after) }, { client: tx })
        return { id, version: after.version }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', CODE_TAKEN, { fieldErrors: { code: [CODE_TAKEN] } })
      throw error
    }
  }

  async deleteCarrier(req: RequestWithContext, id: string): Promise<{ id: string }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const tenantId = context.tenantId
    const before = await this.prisma.carrier.findFirst({ where: { id, tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '物流商不存在')
    const used = await this.prisma.firstMileShipment.count({ where: { tenantId, carrierChannel: { carrierId: id } } })
    if (used > 0) throw appError('CONFLICT', IN_USE, { details: { shipmentCount: used } })
    try {
      await this.prisma.$transaction(async tx => {
        await tx.carrier.deleteMany({ where: { id, tenantId } })
        await this.audit.record(req, { action: CARRIER_ACTIONS.carrierDeleted, resourceType: 'Carrier', resourceId: id, before: carrierView(before) }, { client: tx })
      })
    } catch (error) {
      if (isForeignKeyViolation(error)) throw appError('CONFLICT', IN_USE)
      throw error
    }
    return { id }
  }

  private async loadChannel(tenantId: string, carrierId: string, channelId: string): Promise<CarrierChannel> {
    const channel = await this.prisma.carrierChannel.findFirst({ where: { id: channelId, carrierId, tenantId } })
    if (!channel) throw appError('RESOURCE_NOT_FOUND', '渠道不存在')
    return channel
  }

  async createChannel(req: RequestWithContext, carrierId: string, rawBody: unknown): Promise<{ id: string; version: number }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = ChannelCreateBodySchema.parse(rawBody)
    const carrier = await this.prisma.carrier.findFirst({ where: { id: carrierId, tenantId: context.tenantId }, select: { status: true } })
    if (!carrier) throw appError('RESOURCE_NOT_FOUND', '物流商不存在')
    if (carrier.status !== 'ACTIVE') throw appError('CONFLICT', '这个物流商已停用，请先启用再添加渠道')
    try {
      return await this.prisma.$transaction(async tx => {
        const row = await tx.carrierChannel.create({ data: { tenantId: context.tenantId, carrierId, ...body, createdBy: context.userId } })
        await this.audit.record(req, { action: CARRIER_ACTIONS.channelCreated, resourceType: 'CarrierChannel', resourceId: row.id, after: channelView(row), detail: { carrierId } }, { client: tx })
        return { id: row.id, version: row.version }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', CODE_TAKEN, { fieldErrors: { code: [CODE_TAKEN] } })
      throw error
    }
  }

  async updateChannel(req: RequestWithContext, carrierId: string, channelId: string, rawBody: unknown): Promise<{ id: string; version: number }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version, ...changes } = ChannelUpdateBodySchema.parse(rawBody)
    const before = await this.loadChannel(context.tenantId, carrierId, channelId)
    try {
      return await this.prisma.$transaction(async tx => {
        const after = await updateWithVersion(tx.carrierChannel, { id: channelId, tenantId: context.tenantId }, version, changes, { label: '渠道' })
        await this.audit.record(
          req,
          { action: CARRIER_ACTIONS.channelUpdated, resourceType: 'CarrierChannel', resourceId: channelId, before: channelView(before), after: channelView(after), detail: { carrierId } },
          { client: tx },
        )
        return { id: channelId, version: after.version }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', CODE_TAKEN, { fieldErrors: { code: [CODE_TAKEN] } })
      throw error
    }
  }

  async deleteChannel(req: RequestWithContext, carrierId: string, channelId: string): Promise<{ id: string }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const tenantId = context.tenantId
    const before = await this.loadChannel(tenantId, carrierId, channelId)
    const used = await this.prisma.firstMileShipment.count({ where: { tenantId, carrierChannelId: channelId } })
    if (used > 0) throw appError('CONFLICT', IN_USE, { details: { shipmentCount: used } })
    try {
      await this.prisma.$transaction(async tx => {
        await tx.carrierChannel.deleteMany({ where: { id: channelId, tenantId } })
        await this.audit.record(
          req,
          { action: CARRIER_ACTIONS.channelDeleted, resourceType: 'CarrierChannel', resourceId: channelId, before: channelView(before), detail: { carrierId } },
          { client: tx },
        )
      })
    } catch (error) {
      if (isForeignKeyViolation(error)) throw appError('CONFLICT', IN_USE)
      throw error
    }
    return { id: channelId }
  }
}
