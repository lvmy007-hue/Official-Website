import { Injectable } from '@nestjs/common'
import {
  FIRST_MILE_MODE_LABEL,
  TRANSIT_BASIS,
  TRANSIT_MIN_SAMPLES,
  TransitApplyBodySchema,
  type FirstMileMode,
  type PolicyUpsertBody,
  type TransitApplyResult,
  type TransitMonthPoint,
  type TransitStatRow,
  type TransitStatsResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { ReplenishmentPolicyService } from '../replenishment'
import { dayText, FM_READ, POLICY_WRITE, stateConflict, todayText } from './first-mile-common'
import { loadDeliveredSamples, summaryOf } from './transit-load'

// 实际时效统计与回写补货策略（06 章 6.10“先进能力”）：
// 统计按货代与运输方式分组，口径写在 TRANSIT_BASIS 里；回写是人工确认的动作：取 p90 作为企业级补货策略里该运输方式的时效，
// 保存成一个新的策略版本（旧版本不改，库存健康与补货建议的下一次计算起生效），由补货策略的版本化入口完成，权限是 replenishment.policy.write。
@Injectable()
export class TransitStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly policies: ReplenishmentPolicyService,
  ) {}

  private async tenantPolicy(tenantId: string, today: string) {
    return (await this.policies.effectiveOf(tenantId, today)).find(policy => policy.level === 'TENANT' && policy.levelRef === 'ALL') ?? null
  }

  async stats(req: RequestWithContext): Promise<TransitStatsResponse> {
    const context = await this.context.authorize(req, FM_READ)
    const tenantId = context.tenantId
    const today = todayText()
    const [samples, forwarders, monthly, policy] = await Promise.all([
      loadDeliveredSamples(this.prisma, tenantId, today),
      this.prisma.freightForwarder.findMany({ where: { tenantId }, select: { id: true, name: true }, take: 200 }),
      this.prisma.transitTimeStat.findMany({ where: { tenantId }, orderBy: { periodMonth: 'asc' }, take: 5000 }),
      this.tenantPolicy(tenantId, today),
    ])
    const names = new Map(forwarders.map(row => [row.id, row.name]))
    const groups = new Map<string, typeof samples>()
    for (const sample of samples) groups.set(`${sample.forwarderId}|${sample.mode}`, [...(groups.get(`${sample.forwarderId}|${sample.mode}`) ?? []), sample])
    const rows: TransitStatRow[] = [...groups.entries()]
      .map(([key, group]) => {
        const [forwarderId, mode] = key.split('|') as [string, FirstMileMode]
        const summary = summaryOf(group)
        const policyDays = policy?.transportOptions.find(option => option.mode === mode)?.transitDays ?? null
        const points: TransitMonthPoint[] = monthly
          .filter(row => row.forwarderId === forwarderId && row.mode === mode)
          .map(row => ({ month: dayText(row.periodMonth) as string, sampleCount: row.sampleCount, p50Days: row.p50Days, p90Days: row.p90Days }))
        const blocked =
          summary.sampleCount < TRANSIT_MIN_SAMPLES
            ? `样本不足（至少 ${TRANSIT_MIN_SAMPLES} 单已交付，现有 ${summary.sampleCount} 单）`
            : policy
              ? null
              : '企业级补货策略尚未配置，请先到补货策略页保存'
        return {
          forwarderId,
          forwarderName: names.get(forwarderId) ?? '已删除的货代',
          mode,
          modeLabel: FIRST_MILE_MODE_LABEL[mode] ?? mode,
          ...summary,
          monthly: points,
          policyTransitDays: policyDays,
          applyBlocked: blocked,
        }
      })
      .sort((a, b) => a.forwarderName.localeCompare(b.forwarderName) || a.mode.localeCompare(b.mode))
    return { rows, policyVersionNo: policy?.versionNo ?? null, basis: TRANSIT_BASIS }
  }

  async apply(req: RequestWithContext, rawBody: unknown): Promise<TransitApplyResult> {
    const context = await this.context.authorize(req, POLICY_WRITE)
    const body = TransitApplyBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const today = todayText()
    const forwarder = await this.prisma.freightForwarder.findFirst({ where: { id: body.forwarderId, tenantId }, select: { name: true } })
    if (!forwarder) throw appError('RESOURCE_NOT_FOUND', '货代不存在')
    const summary = summaryOf(await loadDeliveredSamples(this.prisma, tenantId, today, { forwarderId: body.forwarderId, mode: body.mode }))
    if (summary.sampleCount < TRANSIT_MIN_SAMPLES || summary.p90Days === null) throw stateConflict(`样本不足：至少需要 ${TRANSIT_MIN_SAMPLES} 单已交付的运单，现有 ${summary.sampleCount} 单`)
    const current = await this.tenantPolicy(tenantId, today)
    if (!current) throw stateConflict('企业级补货策略尚未配置，请先到补货策略页保存')
    if (current.versionNo !== body.expectedVersionNo) {
      throw appError('CONFLICT', '企业级补货策略已被他人修改，请刷新后再回写', { details: { currentVersion: current.versionNo, expectedVersion: body.expectedVersionNo } })
    }
    const { productionDays, domesticDays, receivingDays, serviceLevel, transportPreference } = current
    if (productionDays === null || domesticDays === null || receivingDays === null || serviceLevel === null || transportPreference === null) {
      throw stateConflict('企业级补货策略的参数还不完整，请先到补货策略页补齐并保存')
    }
    const transitDays = Math.min(180, Math.max(1, summary.p90Days))
    const previous = current.transportOptions.find(option => option.mode === body.mode)
    const options = previous
      ? current.transportOptions.map(option => (option.mode === body.mode ? { ...option, transitDays } : option))
      : [...current.transportOptions, { mode: body.mode, transitDays, unitCost: null }]
    const upsert: PolicyUpsertBody = {
      level: 'TENANT',
      levelRef: 'ALL',
      expectedVersionNo: current.versionNo,
      leadTimeDays: current.leadTimeDays,
      awdLeadTimeDays: current.awdLeadTimeDays,
      safetyDays: current.safetyDays,
      coverageDays: current.coverageDays,
      redundancyMultiplier: current.redundancyMultiplier,
      inboundCounted: current.inboundCounted,
      agingFromDays: current.agingFromDays,
      productionDays,
      domesticDays,
      receivingDays,
      serviceLevel,
      transportPreference,
      transportOptions: options,
      casePackQty: current.casePackQty,
      moq: current.moq,
      minOrderValue: current.minOrderValue,
      includeUnavoidableShortage: current.includeUnavoidableShortage,
      changeReason: `头程实际时效回写：${forwarder.name} ${FIRST_MILE_MODE_LABEL[body.mode]} 九成运单 ${summary.p90Days} 天内交付（样本 ${summary.sampleCount} 单）`,
    }
    const saved = await this.policies.upsert(req, upsert)
    return { versionNo: saved.versionNo, mode: body.mode, transitDays, previousDays: previous?.transitDays ?? null }
  }
}
