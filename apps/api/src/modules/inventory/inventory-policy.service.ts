import { Injectable } from '@nestjs/common'
import { InventoryPolicyWriteSchema, POLICY_NOT_CONFIGURED_NOTE, type InboundKind, type InventoryPolicy, type InventoryPolicyResponse } from '@nova/api-contracts'
import type { Prisma, ReplenishmentPolicy } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { todayIn, validZone } from '../overview'
import { plusDays } from './inventory-rules'

// 库存规则（补货策略的企业级版本，06 章 6.1）：读取当前生效版本与历史；保存即新增一个版本（只增不改），同一事务里写审计与变更时间线。
// 品类与 SKU 两级覆盖由补货模块（P2a-07）在同一张表上维护；这里只处理企业级（level=TENANT，levelRef=ALL）。

const READ = 'inventory.read'
const WRITE = 'replenishment.policy.write'
const SCOPE = { level: 'TENANT', levelRef: 'ALL' } as const
const HISTORY_LIMIT = 50
const dec = (value: { toString(): string }) => Number(value.toString())

export function toPolicy(row: ReplenishmentPolicy, names: ReadonlyMap<string, string>): InventoryPolicy {
  return {
    versionNo: row.versionNo,
    level: 'TENANT',
    leadTimeDays: row.leadTimeDays,
    awdLeadTimeDays: row.awdLeadTimeDays,
    safetyDays: row.safetyDays,
    coverageDays: row.coverageDays,
    redundancyMultiplier: dec(row.redundancyMultiplier),
    inboundCounted: row.inboundCounted as InboundKind[],
    agingFromDays: row.agingFromDays as InventoryPolicy['agingFromDays'],
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    changeReason: row.changeReason,
    createdBy: nameOrFormer(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
  }
}

@Injectable()
export class InventoryPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  /** 企业时区的“今天”。 */
  async todayOf(tenantId: string, now = new Date()): Promise<string> {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    return todayIn(validZone(tenant?.timezone), now)
  }

  /** 当前生效版本（effectiveFrom 不晚于今天的最大版本号）；没有返回 null。内部使用，不做权限检查。 */
  async currentOf(tenantId: string, today: string): Promise<InventoryPolicy | null> {
    const row = await this.prisma.replenishmentPolicy.findFirst({
      where: { tenantId, ...SCOPE, effectiveFrom: { lte: new Date(`${today}T00:00:00Z`) } },
      orderBy: { versionNo: 'desc' },
    })
    if (!row) return null
    const names = await memberNames(this.prisma, tenantId, [row.createdBy])
    return toPolicy(row, names)
  }

  async read(req: RequestWithContext): Promise<InventoryPolicyResponse> {
    const context = await this.context.authorize(req, READ)
    return this.load(context.tenantId)
  }

  /** 当前版本与历史（不做权限检查，调用方负责）。 */
  private async load(tenantId: string): Promise<InventoryPolicyResponse> {
    const today = await this.todayOf(tenantId)
    const rows = await this.prisma.replenishmentPolicy.findMany({ where: { tenantId, ...SCOPE }, orderBy: { versionNo: 'desc' }, take: HISTORY_LIMIT })
    const names = await memberNames(
      this.prisma,
      tenantId,
      rows.map(row => row.createdBy),
    )
    const history = rows.map(row => toPolicy(row, names))
    const current = history.find(item => item.effectiveFrom <= today) ?? null
    return { state: current ? 'OK' : 'NOT_CONNECTED', note: current ? null : POLICY_NOT_CONFIGURED_NOTE, current, history }
  }

  async write(req: RequestWithContext, rawBody: unknown): Promise<InventoryPolicyResponse> {
    const context = await this.context.authorize(req, WRITE)
    const body = InventoryPolicyWriteSchema.parse(rawBody)
    const today = await this.todayOf(context.tenantId)
    const effectiveFrom = body.effectiveFrom ?? today
    if (effectiveFrom < today) throw appError('VALIDATION_FAILED', '生效日期不能早于今天', { fieldErrors: { effectiveFrom: ['不能早于今天'] } })
    if (effectiveFrom > plusDays(today, 365)) throw appError('VALIDATION_FAILED', '生效日期最多提前一年', { fieldErrors: { effectiveFrom: ['最多提前一年'] } })

    await this.prisma
      .$transaction(async tx => {
        const latest = await tx.replenishmentPolicy.findFirst({ where: { tenantId: context.tenantId, ...SCOPE }, orderBy: { versionNo: 'desc' } })
        const currentNo = latest?.versionNo ?? 0
        if (body.expectedVersionNo !== currentNo) {
          throw appError('CONFLICT', '库存规则已被他人修改，请刷新后查看最新版本，再决定是否合并你的修改', { details: { currentVersion: currentNo, expectedVersion: body.expectedVersionNo } })
        }
        const row = await tx.replenishmentPolicy.create({
          data: {
            tenantId: context.tenantId,
            ...SCOPE,
            versionNo: currentNo + 1,
            leadTimeDays: body.leadTimeDays,
            awdLeadTimeDays: body.awdLeadTimeDays,
            safetyDays: body.safetyDays,
            coverageDays: body.coverageDays,
            redundancyMultiplier: body.redundancyMultiplier.toFixed(2),
            inboundCounted: body.inboundCounted,
            agingFromDays: body.agingFromDays,
            ...carryOver(latest),
            effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
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
            detail: { versionNo: row.versionNo, effectiveFrom, reason: body.changeReason },
          },
          { client: tx },
        )
        await tx.entityEvent.create({
          data: {
            tenantId: context.tenantId,
            entityType: 'REPLENISHMENT_POLICY',
            entityId: 'TENANT:ALL',
            kind: 'rule',
            occurredAt: new Date(),
            title: `库存规则升级到第 ${row.versionNo} 版（${effectiveFrom} 起生效）：${body.changeReason}`,
            detailJson: snapshot(row) as unknown as Prisma.InputJsonValue,
            actorKind: 'USER',
            actorId: context.userId,
            sourceRef: `${row.id}:${row.versionNo}`,
          },
        })
        return row
      })
      .catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code === 'P2002') {
          throw appError('CONFLICT', '库存规则刚被他人修改，请刷新后重试', { details: { expectedVersion: body.expectedVersionNo } })
        }
        throw error
      })
    return this.load(context.tenantId)
  }
}

/** 库存规则页只维护风险判定参数；补货计算链参数（P2a-07）沿用上一版，避免保存库存规则时把它们清空。 */
function carryOver(latest: ReplenishmentPolicy | null) {
  if (!latest) return {}
  return {
    productionDays: latest.productionDays,
    domesticDays: latest.domesticDays,
    receivingDays: latest.receivingDays,
    serviceLevel: latest.serviceLevel,
    transportPreference: latest.transportPreference,
    ...(latest.transportOptionsJson === null ? {} : { transportOptionsJson: latest.transportOptionsJson as Prisma.InputJsonValue }),
    casePackQty: latest.casePackQty,
    moq: latest.moq,
    minOrderValue: latest.minOrderValue,
  }
}

function snapshot(row: ReplenishmentPolicy) {
  return {
    versionNo: row.versionNo,
    leadTimeDays: row.leadTimeDays,
    awdLeadTimeDays: row.awdLeadTimeDays,
    safetyDays: row.safetyDays,
    coverageDays: row.coverageDays,
    redundancyMultiplier: dec(row.redundancyMultiplier),
    inboundCounted: row.inboundCounted,
    agingFromDays: row.agingFromDays,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
  }
}
