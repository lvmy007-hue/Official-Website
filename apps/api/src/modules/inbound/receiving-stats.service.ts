import { Injectable } from '@nestjs/common'
import {
  RECEIVING_BASIS,
  RECEIVING_MIN_SAMPLES,
  RECEIVING_WINDOW_DAYS,
  ReceivingApplyBodySchema,
  percentileOf,
  receivingDaysOf,
  type PolicyUpsertBody,
  type ReceivingApplyResult,
  type ReceivingStatRow,
  type ReceivingStatsResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { ReplenishmentPolicyService } from '../replenishment'
import { INBOUND_READ } from './inbound-common'

// 按运营中心统计接收时长，并在人工确认后回写补货策略里的“入仓接收天数”（06 章 6.12“先进能力”）：
// 统计口径写在 RECEIVING_BASIS 里；回写取 p90，保存成企业级补货策略的新版本（旧版本不改，下一次计算起生效），
// 走补货策略的版本化入口（权限 replenishment.policy.write）。企业级策略对全部店铺生效，所以回写只允许全部店铺范围的成员做。
const POLICY_WRITE = 'replenishment.policy.write'
const DAY_MS = 86_400_000
const MAX_DAYS = 60

function rowOf(destinationFc: string | null, days: number[], policyReady: string | null): ReceivingStatRow {
  const blocked = days.length < RECEIVING_MIN_SAMPLES ? `样本不足（至少 ${RECEIVING_MIN_SAMPLES} 个已关闭货件，现有 ${days.length} 个）` : policyReady
  return {
    destinationFc,
    label: destinationFc ?? '全部运营中心',
    sampleCount: days.length,
    p50Days: percentileOf(days, 0.5),
    p90Days: percentileOf(days, 0.9),
    minDays: days.length ? Math.min(...days) : null,
    maxDays: days.length ? Math.max(...days) : null,
    applyBlocked: blocked,
  }
}

@Injectable()
export class ReceivingStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly policies: ReplenishmentPolicyService,
  ) {}

  private async samples(tenantId: string, scope: ResolvedScope, now: Date): Promise<Array<{ fc: string | null; days: number }>> {
    const since = new Date(now.getTime() - RECEIVING_WINDOW_DAYS * DAY_MS)
    const rows = await this.prisma.fbaInboundShipment.findMany({
      where: { plan: { tenantId, ...storeWhere(scope) }, status: 'CLOSED', receivedFirstAt: { not: null }, receivedDoneAt: { gte: since, not: null } },
      select: { destinationFc: true, receivedFirstAt: true, receivedDoneAt: true },
      take: 20000,
    })
    return rows.flatMap(row => {
      const days = receivingDaysOf(row.receivedFirstAt, row.receivedDoneAt)
      return days === null ? [] : [{ fc: row.destinationFc, days }]
    })
  }

  private async tenantPolicy(tenantId: string, today: string) {
    return (await this.policies.effectiveOf(tenantId, today)).find(policy => policy.level === 'TENANT' && policy.levelRef === 'ALL') ?? null
  }

  async stats(req: RequestWithContext): Promise<ReceivingStatsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const now = new Date()
    const [samples, policy] = await Promise.all([this.samples(context.tenantId, scope, now), this.tenantPolicy(context.tenantId, now.toISOString().slice(0, 10))])
    const notReady = policy ? null : '企业级补货策略尚未配置，请先到补货策略页保存'
    const byFc = new Map<string, number[]>()
    for (const sample of samples) if (sample.fc) byFc.set(sample.fc, [...(byFc.get(sample.fc) ?? []), sample.days])
    return {
      overall: rowOf(
        null,
        samples.map(sample => sample.days),
        notReady,
      ),
      rows: [...byFc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([fc, days]) => rowOf(fc, days, notReady)),
      policyVersionNo: policy?.versionNo ?? null,
      policyReceivingDays: policy?.receivingDays ?? null,
      basis: RECEIVING_BASIS,
    }
  }

  async apply(req: RequestWithContext, rawBody: unknown): Promise<ReceivingApplyResult> {
    const { context, scope } = await this.context.authorizeScoped(req, POLICY_WRITE, {})
    const body = ReceivingApplyBodySchema.parse(rawBody)
    if (!scope.unrestricted) throw appError('SCOPE_STORE_FORBIDDEN', '企业级补货策略对全部店铺生效，回写入仓接收时长需要全部店铺的数据范围')
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const days = (await this.samples(context.tenantId, scope, now)).filter(sample => body.destinationFc === null || sample.fc === body.destinationFc).map(sample => sample.days)
    const p90 = percentileOf(days, 0.9)
    if (days.length < RECEIVING_MIN_SAMPLES || p90 === null) throw appError('DATA_CONDITION_FAILED', `样本不足：至少需要 ${RECEIVING_MIN_SAMPLES} 个已关闭的货件，现有 ${days.length} 个`)
    const current = await this.tenantPolicy(context.tenantId, today)
    if (!current) throw appError('DATA_CONDITION_FAILED', '企业级补货策略尚未配置，请先到补货策略页保存')
    if (current.versionNo !== body.expectedVersionNo) {
      throw appError('CONFLICT', '企业级补货策略已被他人修改，请刷新后再回写', { details: { currentVersion: current.versionNo, expectedVersion: body.expectedVersionNo } })
    }
    const { productionDays, domesticDays, receivingDays, serviceLevel, transportPreference } = current
    if (productionDays === null || domesticDays === null || receivingDays === null || serviceLevel === null || transportPreference === null) {
      throw appError('DATA_CONDITION_FAILED', '企业级补货策略的参数还不完整，请先到补货策略页补齐并保存')
    }
    // 接收时长是自然日差，同一天为 0；策略里的入仓接收天数至少 1 天
    const nextDays = Math.min(MAX_DAYS, Math.max(1, p90))
    const scopeLabel = body.destinationFc ?? '全部运营中心'
    const upsert: PolicyUpsertBody = {
      level: 'TENANT',
      levelRef: 'ALL',
      expectedVersionNo: current.versionNo,
      // 总提前期不改（与头程时效回写一致）：补货计算链按拆分后的各段天数算，库存健康用的总提前期仍由人在策略页维护
      leadTimeDays: current.leadTimeDays,
      awdLeadTimeDays: current.awdLeadTimeDays,
      safetyDays: current.safetyDays,
      coverageDays: current.coverageDays,
      redundancyMultiplier: current.redundancyMultiplier,
      inboundCounted: current.inboundCounted,
      agingFromDays: current.agingFromDays,
      productionDays,
      domesticDays,
      receivingDays: nextDays,
      serviceLevel,
      transportPreference,
      transportOptions: current.transportOptions,
      casePackQty: current.casePackQty,
      moq: current.moq,
      minOrderValue: current.minOrderValue,
      includeUnavoidableShortage: current.includeUnavoidableShortage,
      changeReason: `入仓接收时长回写：${scopeLabel} 九成货件 ${p90} 天内接收完成（样本 ${days.length} 个）`,
    }
    const saved = await this.policies.upsert(req, upsert)
    return { versionNo: saved.versionNo, receivingDays: nextDays, previousDays: receivingDays, scopeLabel }
  }
}
