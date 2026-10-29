import { Injectable } from '@nestjs/common'
import {
  PolicyListQuerySchema,
  PolicyUpsertBodySchema,
  REPLENISH_LEVEL_LABEL,
  type InboundKind,
  type PolicyListResponse,
  type ReplenishLevel,
  type ReplenishPolicy,
  type TransportOption,
  type TransportPreference,
} from '@nova/api-contracts'
import type { Prisma, ReplenishmentPolicy } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { InventoryPolicyService } from '../inventory'
import { latestEffective, levelOrder } from './replenishment-resolve'

// 补货策略（06 章 6.2）：企业 / 品类 / SKU 三级，每个对象独立版本（只增不改，乐观并发 409）。
// 企业级与库存规则（P2a-06）是同一张表同一条版本线：这里保存的企业级新版本，库存健康页同样立即生效。

const READ = 'replenishment.read'
const WRITE = 'replenishment.policy.write'
const dec = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const LIST_TAKE = 2000

export function toReplenishPolicy(row: ReplenishmentPolicy, names: ReadonlyMap<string, string>): ReplenishPolicy {
  return {
    versionNo: row.versionNo,
    level: row.level as ReplenishLevel,
    levelRef: row.levelRef,
    leadTimeDays: row.leadTimeDays,
    awdLeadTimeDays: row.awdLeadTimeDays,
    safetyDays: row.safetyDays,
    coverageDays: row.coverageDays,
    redundancyMultiplier: dec(row.redundancyMultiplier) as number,
    inboundCounted: row.inboundCounted as InboundKind[],
    agingFromDays: row.agingFromDays as ReplenishPolicy['agingFromDays'],
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    changeReason: row.changeReason,
    createdBy: nameOrFormer(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    productionDays: row.productionDays,
    domesticDays: row.domesticDays,
    receivingDays: row.receivingDays,
    serviceLevel: dec(row.serviceLevel),
    transportPreference: row.transportPreference as TransportPreference | null,
    transportOptions: Array.isArray(row.transportOptionsJson) ? (row.transportOptionsJson as unknown as TransportOption[]) : [],
    casePackQty: row.casePackQty,
    moq: row.moq,
    minOrderValue: dec(row.minOrderValue),
    includeUnavoidableShortage: row.includeUnavoidableShortage,
  }
}

const snapshot = (row: ReplenishmentPolicy) => ({
  versionNo: row.versionNo,
  level: row.level,
  levelRef: row.levelRef,
  leadTimeDays: row.leadTimeDays,
  safetyDays: row.safetyDays,
  coverageDays: row.coverageDays,
  serviceLevel: dec(row.serviceLevel),
  transportPreference: row.transportPreference,
  casePackQty: row.casePackQty,
  moq: row.moq,
  includeUnavoidableShortage: row.includeUnavoidableShortage,
  effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
})

@Injectable()
export class ReplenishmentPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly inventoryPolicies: InventoryPolicyService,
  ) {}

  /** 各对象“今天生效”的版本（内部使用，不做权限检查）。 */
  async effectiveOf(tenantId: string, today: string): Promise<ReplenishPolicy[]> {
    const rows = await this.prisma.replenishmentPolicy.findMany({
      where: { tenantId, effectiveFrom: { lte: asDate(today) } },
      orderBy: [{ level: 'asc' }, { levelRef: 'asc' }, { versionNo: 'desc' }],
      take: LIST_TAKE,
    })
    const names = await memberNames(
      this.prisma,
      tenantId,
      rows.map(row => row.createdBy),
    )
    return latestEffective(
      rows.map(row => toReplenishPolicy(row, names)),
      today,
    )
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<PolicyListResponse> {
    const context = await this.context.authorize(req, READ)
    const query = PolicyListQuerySchema.parse(rawQuery)
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const rows = await this.prisma.replenishmentPolicy.findMany({
      where: { tenantId: context.tenantId, ...(query.level ? { level: query.level } : {}), ...(query.q ? { levelRef: { contains: query.q, mode: 'insensitive' } } : {}) },
      orderBy: [{ level: 'asc' }, { levelRef: 'asc' }, { versionNo: 'desc' }],
      take: LIST_TAKE,
    })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.createdBy),
    )
    const all = rows.map(row => toReplenishPolicy(row, names))
    const sign = query.sort.dir === 'asc' ? 1 : -1
    all.sort((a, b) => {
      const primary = (query.sort.field === 'levelRef' ? a.levelRef.localeCompare(b.levelRef) : levelOrder(a.level) - levelOrder(b.level)) * sign
      return primary || levelOrder(a.level) - levelOrder(b.level) || a.levelRef.localeCompare(b.levelRef) || b.versionNo - a.versionNo
    })
    const start = (query.page - 1) * query.pageSize
    const tenantRow = await this.prisma.replenishmentPolicy.findMany({
      where: { tenantId: context.tenantId, level: 'TENANT', levelRef: 'ALL', effectiveFrom: { lte: asDate(today) } },
      orderBy: { versionNo: 'desc' },
      take: 1,
    })
    const categories = await this.prisma.fbaProduct.findMany({
      where: { tenantId: context.tenantId, productType: { not: null } },
      distinct: ['productType'],
      select: { productType: true },
      orderBy: { productType: 'asc' },
      take: 200,
    })
    return {
      items: all.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: all.length,
      tenantCurrent: tenantRow[0] ? toReplenishPolicy(tenantRow[0], names) : null,
      categories: categories.map(item => item.productType as string),
    }
  }

  /** 保存一个对象的新版本；返回新版本。 */
  async upsert(req: RequestWithContext, rawBody: unknown): Promise<ReplenishPolicy> {
    const context = await this.context.authorize(req, WRITE)
    const body = PolicyUpsertBodySchema.parse(rawBody)
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const effectiveFrom = body.effectiveFrom ?? today
    if (effectiveFrom < today) throw appError('VALIDATION_FAILED', '生效日期不能早于今天', { fieldErrors: { effectiveFrom: ['不能早于今天'] } })
    await this.assertTargetExists(context.tenantId, body.level, body.levelRef)
    const created = await this.prisma
      .$transaction(async tx => {
        const where = { tenantId: context.tenantId, level: body.level, levelRef: body.levelRef }
        const latest = await tx.replenishmentPolicy.findFirst({ where, orderBy: { versionNo: 'desc' } })
        const currentNo = latest?.versionNo ?? 0
        if (body.expectedVersionNo !== currentNo) {
          throw appError('CONFLICT', '该策略已被他人修改，请刷新后查看最新版本，再决定是否合并你的修改', { details: { currentVersion: currentNo, expectedVersion: body.expectedVersionNo } })
        }
        const row = await tx.replenishmentPolicy.create({
          data: {
            ...where,
            versionNo: currentNo + 1,
            leadTimeDays: body.leadTimeDays,
            awdLeadTimeDays: body.awdLeadTimeDays,
            safetyDays: body.safetyDays,
            coverageDays: body.coverageDays,
            redundancyMultiplier: body.redundancyMultiplier.toFixed(2),
            inboundCounted: body.inboundCounted,
            agingFromDays: body.agingFromDays,
            productionDays: body.productionDays,
            domesticDays: body.domesticDays,
            receivingDays: body.receivingDays,
            serviceLevel: body.serviceLevel.toFixed(4),
            transportPreference: body.transportPreference,
            transportOptionsJson: body.transportOptions as unknown as Prisma.InputJsonValue,
            casePackQty: body.casePackQty,
            moq: body.moq,
            minOrderValue: body.minOrderValue === null ? null : body.minOrderValue.toFixed(2),
            includeUnavoidableShortage: body.includeUnavoidableShortage,
            effectiveFrom: asDate(effectiveFrom),
            changeReason: body.changeReason,
            createdBy: context.userId,
          },
        })
        await this.audit.record(
          req,
          {
            action: 'REPLENISHMENT_POLICY_VERSIONED',
            resourceType: 'ReplenishmentPolicy',
            resourceId: row.id,
            before: latest ? snapshot(latest) : null,
            after: snapshot(row),
            detail: { level: row.level, levelRef: row.levelRef, versionNo: row.versionNo, effectiveFrom, reason: body.changeReason },
          },
          { client: tx },
        )
        await tx.entityEvent.create({
          data: {
            tenantId: context.tenantId,
            entityType: 'REPLENISHMENT_POLICY',
            entityId: `${row.level}:${row.levelRef}`,
            kind: 'rule',
            occurredAt: new Date(),
            title: `${REPLENISH_LEVEL_LABEL[body.level]}补货策略${body.level === 'TENANT' ? '' : ` ${body.levelRef}`}升级到第 ${row.versionNo} 版（${effectiveFrom} 起生效）：${body.changeReason}`,
            detailJson: snapshot(row) as unknown as Prisma.InputJsonValue,
            actorKind: 'USER',
            actorId: context.userId,
            sourceRef: `${row.id}:${row.versionNo}`,
          },
        })
        return row
      })
      .catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code === 'P2002') throw appError('CONFLICT', '该策略刚被他人修改，请刷新后重试', { details: { expectedVersion: body.expectedVersionNo } })
        throw error
      })
    const names = await memberNames(this.prisma, context.tenantId, [created.createdBy])
    return toReplenishPolicy(created, names)
  }

  /** 品类级必须是范围内真实存在的商品类型，SKU 级必须是真实存在的卖家 SKU：避免拼写错误的覆盖永远不生效。 */
  private async assertTargetExists(tenantId: string, level: ReplenishLevel, levelRef: string) {
    if (level === 'TENANT') return
    const found =
      level === 'CATEGORY'
        ? await this.prisma.fbaProduct.findFirst({ where: { tenantId, productType: levelRef }, select: { id: true } })
        : await this.prisma.fbaInventoryRecord.findFirst({ where: { tenantId, sellerSku: levelRef }, select: { id: true } })
    if (!found)
      throw appError('VALIDATION_FAILED', level === 'CATEGORY' ? '没有找到这个商品类型' : '没有找到这个 SKU', { fieldErrors: { levelRef: [level === 'CATEGORY' ? '商品类型不存在' : 'SKU 不存在'] } })
  }
}
