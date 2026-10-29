import { Injectable } from '@nestjs/common'
import {
  ADS_RULE_CREATED_ACTION,
  ADS_RULE_SWITCH,
  ADS_RULE_UPDATED_ACTION,
  ADS_RULE_WRITE,
  AdsRuleBodySchema,
  AdsRuleUpdateBodySchema,
  describeRuleSpec,
  ruleSpecIssues,
  type AdsRuleSpec,
  type AdsRuleWriteResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService, AuditWriter, updateWithVersion } from '../../platform/write'
import { adsProfileWhere, adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { jsonOf, levelOf, modeOf, RULE_ID_PATTERN, RULE_SELECT, ruleRowOf, specOf, type RuleRecord } from './ads-rules-common'

const LABEL = '自动规则'
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
const dupName = () => appError('CONFLICT', '这个广告账户下已经有同名的自动规则，请换一个名称', { fieldErrors: { name: ['规则名称已存在'] } })

// 自动规则的创建与修改（P3-13，08 章 8.10）：只改本系统里的规则，不写亚马逊（自动执行随 P3-17）。
// 顺序：权限 → 参数（422）→ 广告账户或规则存在且在范围（404）→ 限定的活动都在同一账户与范围内（404，整批）→ 内容整体合法（422）
//   → 要改成自动模式时检查写入开关（409）→ 事务内写入与审计（重名 409、版本冲突 409）。
@Injectable()
export class AdsRulesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly audit: AuditWriter,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown): Promise<AdsRuleWriteResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_RULE_WRITE, {})
    const body = AdsRuleBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const profile = await this.prisma.adsProfile.findFirst({ where: { id: body.adsProfileId, tenantId, ...adsProfileWhere(scope) }, select: { id: true } })
    if (!profile) throw appError('RESOURCE_NOT_FOUND', '广告账户不存在或不在你的数据范围内')
    await this.assertCampaigns(tenantId, scope, profile.id, body.campaignIds)
    if (body.mode === 'AUTO') await this.assertAutoAllowed(context)
    const spec: AdsRuleSpec = { level: body.level, conditions: body.conditions, textFilters: body.textFilters, campaignIds: body.campaignIds, action: body.action, guardrails: body.guardrails }
    try {
      const created = await this.prisma.$transaction(async tx => {
        const row = await tx.adsAutomationRule.create({
          data: {
            tenantId,
            adsProfileId: profile.id,
            name: body.name,
            level: body.level,
            mode: body.mode,
            status: body.status,
            frequency: body.frequency,
            ...jsonOf(spec),
            createdBy: context.userId,
            updatedBy: context.userId,
          },
          select: RULE_SELECT,
        })
        await this.audit.record(req, { action: ADS_RULE_CREATED_ACTION, resourceType: 'AdsAutomationRule', resourceId: row.id, after: this.snapshot(row) }, { client: tx })
        return row
      })
      return await this.result(tenantId, created)
    } catch (error) {
      if (isUniqueViolation(error)) throw dupName()
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<AdsRuleWriteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_RULE_WRITE, {})
    const body = AdsRuleUpdateBodySchema.parse(rawBody)
    if (!RULE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    const tenantId = context.tenantId
    const current = await this.prisma.adsAutomationRule.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: RULE_SELECT })
    if (!current) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)

    // 改动后的整体内容要合法：动作要与层级相配，护栏要与动作相配，所以合并之后再校验一次
    const before = specOf(current)
    const next: AdsRuleSpec = {
      level: before.level,
      conditions: body.conditions ?? before.conditions,
      textFilters: body.textFilters ?? before.textFilters,
      campaignIds: body.campaignIds ?? before.campaignIds,
      action: body.action ?? before.action,
      guardrails: body.guardrails ?? before.guardrails,
    }
    const issue = ruleSpecIssues(next)
    if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { action: [issue] } })
    if (body.campaignIds !== undefined) await this.assertCampaigns(tenantId, scope, current.adsProfileId, body.campaignIds)
    if (body.mode === 'AUTO' && modeOf(current.mode) !== 'AUTO') await this.assertAutoAllowed(context)

    const data: Record<string, unknown> = { updatedBy: context.userId }
    if (body.name !== undefined) data.name = body.name
    if (body.mode !== undefined) data.mode = body.mode
    if (body.status !== undefined) data.status = body.status
    if (body.frequency !== undefined) data.frequency = body.frequency
    const touched = body.conditions !== undefined || body.textFilters !== undefined || body.campaignIds !== undefined || body.action !== undefined || body.guardrails !== undefined
    if (touched) Object.assign(data, jsonOf(next))

    try {
      const updated = await this.prisma.$transaction(async tx => {
        await updateWithVersion(tx.adsAutomationRule, { id, tenantId }, body.version, data, { label: LABEL })
        // 更新返回的是整行，这里再按页面要用的字段读一次（同事务，读到的就是刚写的）
        const row = await tx.adsAutomationRule.findFirstOrThrow({ where: { id, tenantId }, select: RULE_SELECT })
        await this.audit.record(req, { action: ADS_RULE_UPDATED_ACTION, resourceType: 'AdsAutomationRule', resourceId: id, before: this.snapshot(current), after: this.snapshot(row) }, { client: tx })
        return row
      })
      return await this.result(tenantId, updated)
    } catch (error) {
      if (isUniqueViolation(error)) throw dupName()
      throw error
    }
  }

  private async result(tenantId: string, record: RuleRecord): Promise<AdsRuleWriteResult> {
    const people = await memberNames(this.prisma, tenantId, [record.updatedBy])
    return { rule: ruleRowOf(record, people) }
  }

  /** 限定的活动必须都在这个广告账户下、你的数据范围内；有一个找不到整批拒绝，什么也不保存。 */
  private async assertCampaigns(tenantId: string, scope: ResolvedScope, adsProfileId: string, campaignIds: readonly string[]): Promise<void> {
    if (campaignIds.length === 0) return
    const found = await this.prisma.adsCampaign.findMany({
      where: { tenantId, adsProfileId, id: { in: [...campaignIds] }, ...adsRelationWhere(scope) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: campaignIds.length,
    })
    if (found.length !== campaignIds.length) throw appError('RESOURCE_NOT_FOUND', `有 ${campaignIds.length - found.length} 个限定的活动不存在、不属于所选广告账户或不在你的数据范围内，没有保存`)
  }

  /** 自动执行模式要写亚马逊：需要写入开关“自动规则执行”已开启（默认关）。没开就明确拒绝，不悄悄降级成建议模式。 */
  private async assertAutoAllowed(context: ApiContext): Promise<void> {
    await this.guard.assert(context, { permission: ADS_RULE_WRITE, switchKey: ADS_RULE_SWITCH })
  }

  /** 审计里记录的规则快照：只存摘要（条件、动作、护栏的中文描述）与基本属性。 */
  private snapshot(row: RuleRecord) {
    const summary = describeRuleSpec(specOf(row))
    return {
      name: row.name,
      level: levelOf(row.level),
      mode: row.mode,
      status: row.status,
      frequency: row.frequency,
      conditions: summary.conditions,
      action: summary.action,
      guardrails: summary.guardrails,
      scope: summary.scope,
      version: row.version,
    }
  }
}
