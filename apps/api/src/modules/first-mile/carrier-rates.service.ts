import { Injectable } from '@nestjs/common'
import {
  BILLING_MODE_LABEL,
  CARRIER_ACTIONS,
  RateCreateBodySchema,
  RateListQuerySchema,
  RateUpdateBodySchema,
  ratesConflict,
  type BillingMode,
  type RateListResponse,
  type RateRow,
} from '@nova/api-contracts'
import type { ChannelRate, Prisma } from '@prisma/client'
import { CARRIER_RATE_RULES, stripSensitiveFields } from '../../platform/field-filter'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { dayText, FM_READ, FM_WRITE, isUniqueViolation, parseDay } from './first-mile-common'

const OVERLAP = '同一地区里，重量段重叠的报价生效区间不能重叠；请调整重量段或生效日期（相邻的段、截止日的下一天起生效的新价不算重叠）'
const SAME_KEY = '这个渠道在同一地区、同一重量下限、同一起始日已经有一条报价'
const toNumber = (value: { toString(): string } | null) => (value === null ? null : Number(value))

const rangeOf = (row: Pick<ChannelRate, 'weightFrom' | 'weightTo' | 'effectiveFrom' | 'effectiveTo'>) => ({
  weightFrom: Number(row.weightFrom),
  weightTo: toNumber(row.weightTo),
  effectiveFrom: dayText(row.effectiveFrom) as string,
  effectiveTo: dayText(row.effectiveTo),
})
const rateView = (row: ChannelRate) => ({ region: row.region, ...rangeOf(row), unitPrice: row.unitPrice.toString(), currency: row.currency, billingMode: row.billingMode })

/** 渠道阶梯报价（P6-26）：地区 × 重量段 × 生效区间；同渠道同地区重量段重叠的报价生效区间不得重叠；写入带版本号并写审计。报价金额属 field.cost。 */
@Injectable()
export class CarrierRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async loadChannel(tenantId: string, carrierId: string, channelId: string) {
    const channel = await this.prisma.carrierChannel.findFirst({ where: { id: channelId, carrierId, tenantId }, select: { id: true } })
    if (!channel) throw appError('RESOURCE_NOT_FOUND', '渠道不存在')
  }

  async list(req: RequestWithContext, carrierId: string, channelId: string, rawQuery: Record<string, string>): Promise<RateListResponse> {
    const context = await this.context.authorize(req, FM_READ)
    const query = RateListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    await this.loadChannel(tenantId, carrierId, channelId)
    const where: Prisma.ChannelRateWhereInput = { tenantId, channelId, ...(query.region ? { region: query.region } : {}) }
    const [rows, total, regions] = await Promise.all([
      this.prisma.channelRate.findMany({
        where,
        orderBy: [{ region: 'asc' }, { weightFrom: 'asc' }, { effectiveFrom: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.channelRate.count({ where }),
      this.prisma.channelRate.groupBy({ by: ['region'], where: { tenantId, channelId }, orderBy: { region: 'asc' }, take: 500 }),
    ])
    const items: RateRow[] = rows.map(row => ({
      id: row.id,
      region: row.region,
      weightFrom: Number(row.weightFrom),
      weightTo: toNumber(row.weightTo),
      unitPrice: row.unitPrice.toString(),
      currency: row.currency,
      billingMode: row.billingMode as BillingMode,
      billingModeLabel: BILLING_MODE_LABEL[row.billingMode as BillingMode] ?? row.billingMode,
      effectiveFrom: dayText(row.effectiveFrom) as string,
      effectiveTo: dayText(row.effectiveTo),
      version: row.version,
    }))
    return stripSensitiveFields({ items, total, page: query.page, pageSize: query.pageSize, regions: regions.map(row => row.region) }, context.permissions, CARRIER_RATE_RULES)
  }

  /** 同渠道同地区里和这条冲突的其他报价（重量段与生效区间都重叠）。 */
  private async assertNoOverlap(tx: Pick<Prisma.TransactionClient, 'channelRate'>, tenantId: string, channelId: string, candidate: ReturnType<typeof rangeOf> & { region: string }, exceptId?: string) {
    const others = await tx.channelRate.findMany({ where: { tenantId, channelId, region: candidate.region, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, take: 2000 })
    if (others.some(other => ratesConflict(rangeOf(other), candidate))) throw appError('CONFLICT', OVERLAP, { fieldErrors: { weightFrom: [OVERLAP] } })
  }

  async create(req: RequestWithContext, carrierId: string, channelId: string, rawBody: unknown): Promise<{ id: string; version: number }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = RateCreateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    await this.loadChannel(tenantId, carrierId, channelId)
    const candidate = { region: body.region, weightFrom: body.weightFrom, weightTo: body.weightTo ?? null, effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo ?? null }
    try {
      return await this.prisma.$transaction(async tx => {
        await this.assertNoOverlap(tx, tenantId, channelId, candidate)
        const row = await tx.channelRate.create({
          data: {
            tenantId,
            channelId,
            region: body.region,
            weightFrom: body.weightFrom,
            weightTo: body.weightTo ?? null,
            unitPrice: body.unitPrice,
            currency: body.currency,
            billingMode: body.billingMode,
            effectiveFrom: parseDay(body.effectiveFrom),
            effectiveTo: body.effectiveTo ? parseDay(body.effectiveTo) : null,
            createdBy: context.userId,
          },
        })
        await this.audit.record(req, { action: CARRIER_ACTIONS.rateCreated, resourceType: 'ChannelRate', resourceId: row.id, after: rateView(row), detail: { carrierId, channelId } }, { client: tx })
        return { id: row.id, version: row.version }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', SAME_KEY)
      throw error
    }
  }

  async update(req: RequestWithContext, carrierId: string, channelId: string, rateId: string, rawBody: unknown): Promise<{ id: string; version: number }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version, ...changes } = RateUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    await this.loadChannel(tenantId, carrierId, channelId)
    const before = await this.prisma.channelRate.findFirst({ where: { id: rateId, channelId, tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '报价不存在')
    const merged = {
      region: changes.region ?? before.region,
      weightFrom: changes.weightFrom ?? Number(before.weightFrom),
      weightTo: changes.weightTo === undefined ? toNumber(before.weightTo) : changes.weightTo,
      effectiveFrom: changes.effectiveFrom ?? (dayText(before.effectiveFrom) as string),
      effectiveTo: changes.effectiveTo === undefined ? dayText(before.effectiveTo) : changes.effectiveTo,
    }
    if (merged.weightTo !== null && merged.weightTo <= merged.weightFrom) throw appError('VALIDATION_FAILED', '重量上限必须大于下限', { fieldErrors: { weightTo: ['重量上限必须大于下限'] } })
    if (merged.effectiveTo !== null && merged.effectiveTo < merged.effectiveFrom)
      throw appError('VALIDATION_FAILED', '截止日不能早于起始日', { fieldErrors: { effectiveTo: ['截止日不能早于起始日'] } })
    const data: Prisma.ChannelRateUncheckedUpdateManyInput = {
      ...(changes.region !== undefined ? { region: changes.region } : {}),
      ...(changes.weightFrom !== undefined ? { weightFrom: changes.weightFrom } : {}),
      ...(changes.weightTo !== undefined ? { weightTo: changes.weightTo } : {}),
      ...(changes.unitPrice !== undefined ? { unitPrice: changes.unitPrice } : {}),
      ...(changes.currency !== undefined ? { currency: changes.currency } : {}),
      ...(changes.billingMode !== undefined ? { billingMode: changes.billingMode } : {}),
      ...(changes.effectiveFrom !== undefined ? { effectiveFrom: parseDay(changes.effectiveFrom) } : {}),
      ...(changes.effectiveTo !== undefined ? { effectiveTo: changes.effectiveTo ? parseDay(changes.effectiveTo) : null } : {}),
    }
    try {
      return await this.prisma.$transaction(async tx => {
        await this.assertNoOverlap(tx, tenantId, channelId, merged, rateId)
        const after = await updateWithVersion(tx.channelRate, { id: rateId, tenantId }, version, data as Record<string, unknown>, { label: '报价' })
        await this.audit.record(
          req,
          { action: CARRIER_ACTIONS.rateUpdated, resourceType: 'ChannelRate', resourceId: rateId, before: rateView(before), after: rateView(after), detail: { carrierId, channelId } },
          { client: tx },
        )
        return { id: rateId, version: after.version }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', SAME_KEY)
      throw error
    }
  }

  async remove(req: RequestWithContext, carrierId: string, channelId: string, rateId: string): Promise<{ id: string }> {
    const context = await this.context.authorize(req, FM_WRITE)
    const tenantId = context.tenantId
    await this.loadChannel(tenantId, carrierId, channelId)
    const before = await this.prisma.channelRate.findFirst({ where: { id: rateId, channelId, tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '报价不存在')
    await this.prisma.$transaction(async tx => {
      await tx.channelRate.deleteMany({ where: { id: rateId, tenantId } })
      await this.audit.record(req, { action: CARRIER_ACTIONS.rateDeleted, resourceType: 'ChannelRate', resourceId: rateId, before: rateView(before), detail: { carrierId, channelId } }, { client: tx })
    })
    return { id: rateId }
  }
}
