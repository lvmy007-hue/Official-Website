import { Injectable } from '@nestjs/common'
import {
  GuardrailListQuerySchema,
  PRICING_LIMITS,
  PRICING_READ,
  PRICING_RULE_ACTIONS,
  PRICING_RULE_WRITE,
  PricingRuleCreateBodySchema,
  PricingRuleUpdateBodySchema,
  pricingParamsIssue,
  pricingScopeIssue,
  type PricingParams,
  type PricingRuleListResponse,
  type PricingRuleView,
  type PricingStrategy,
  type PricingTargetScope,
} from '@nova/api-contracts'
import { Prisma, type PricingRule } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { assertStoreInScope, ContextService, storeWhere } from '../auth'
import { storesOf } from './pricing-common'
import { ruleViewOf, switchStateOf } from './pricing-rule-view'

const json = (value: unknown) => value as Prisma.InputJsonValue
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
const dupName = () => appError('CONFLICT', '这家店铺下已经有同名的定价规则，请换一个名称', { fieldErrors: { name: ['规则名称已存在'] } })
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 定价规则（05 章 5.5）：手动规则只生成待确认的建议，自动规则在护栏、单次调幅与每日次数范围内执行，且受写入开关与熔断保护。创建与修改只改本系统里的规则，不调亚马逊。 */
@Injectable()
export class PricingRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async views(tenantId: string, rules: readonly PricingRule[], names: ReadonlyMap<string, string>): Promise<PricingRuleView[]> {
    const [pending, state] = await Promise.all([
      this.prisma.pricingRuleRun.groupBy({
        by: ['ruleId'],
        where: { tenantId, ruleId: { in: rules.map(rule => rule.id) }, outcome: 'SUGGESTED' },
        _count: { _all: true },
        orderBy: { ruleId: 'asc' },
        take: PRICING_LIMITS.ruleListMax,
      }),
      switchStateOf(this.prisma, tenantId),
    ])
    const counts = new Map(pending.map(row => [row.ruleId, row._count._all]))
    return rules.map(rule => ruleViewOf(rule, names.get(rule.sellerAccountId) ?? '', counts.get(rule.id) ?? 0, state))
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<PricingRuleListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_READ, {})
    const query = GuardrailListQuerySchema.parse(rawQuery.storeId ? { storeId: rawQuery.storeId } : {})
    if (query.storeId) assertStoreInScope(scope, query.storeId)
    const stores = await storesOf(this.prisma, context.tenantId, scope)
    const rows = await this.prisma.pricingRule.findMany({
      where: { tenantId: context.tenantId, ...storeWhere(scope), ...(query.storeId ? { sellerAccountId: query.storeId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: PRICING_LIMITS.ruleListMax + 1,
    })
    const page = rows.slice(0, PRICING_LIMITS.ruleListMax)
    return { items: await this.views(context.tenantId, page, new Map(stores.map(store => [store.id, store.name]))), truncated: rows.length > PRICING_LIMITS.ruleListMax }
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<PricingRuleView> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_RULE_WRITE, {})
    const body = PricingRuleCreateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    const tenantId = context.tenantId
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.storeId, tenantId }, select: { displayName: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const count = await this.prisma.pricingRule.count({ where: { tenantId, sellerAccountId: body.storeId } })
    if (count >= PRICING_LIMITS.rulesPerStoreMax)
      throw appError('CONFLICT', `每家店铺最多 ${PRICING_LIMITS.rulesPerStoreMax} 条定价规则，请先删除不用的规则（可停用）`, { details: { code: 'RULE_LIMIT' } })
    try {
      const created = await this.prisma.$transaction(async tx => {
        const row = await tx.pricingRule.create({
          data: {
            tenantId,
            sellerAccountId: body.storeId,
            name: body.name,
            mode: body.mode,
            strategy: body.strategy,
            paramsJson: json(body.params),
            targetScopeJson: json(body.scope),
            ...(body.scenarioMatrix ? { scenarioMatrix: json(body.scenarioMatrix) } : {}),
            status: body.status,
            maxChangePct: body.maxChangePct,
            dailyLimit: body.dailyLimit,
            breakerFailures: body.breaker.failureStreak,
            breakerConversionDrop: body.breaker.conversionDropPct,
            breakerMinMargin: body.breaker.minMarginPct,
            createdBy: context.userId,
            updatedBy: context.userId,
          },
        })
        await this.audit.record(
          req,
          {
            action: PRICING_RULE_ACTIONS.created,
            resourceType: 'PricingRule',
            resourceId: row.id,
            after: {
              name: row.name,
              mode: row.mode,
              strategy: row.strategy,
              status: row.status,
              maxChangePct: body.maxChangePct,
              dailyLimit: body.dailyLimit,
              scenarioMatrix: body.scenarioMatrix ?? null,
            },
          },
          { client: tx },
        )
        return row
      })
      return (await this.views(tenantId, [created], new Map([[body.storeId, store.displayName]])))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw dupName()
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<PricingRuleView> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_RULE_WRITE, {})
    const body = PricingRuleUpdateBodySchema.parse(rawBody)
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '定价规则不存在')
    const tenantId = context.tenantId
    const current = await this.prisma.pricingRule.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '定价规则不存在')
    if (body.status === 'BREAKER') throw appError('VALIDATION_FAILED', '熔断状态只能由系统触发，不能手工设置', { fieldErrors: { status: ['不能手工设为熔断'] } })
    const params = (body.params ?? current.paramsJson) as PricingParams
    const target = (body.scope ?? current.targetScopeJson) as PricingTargetScope
    if (body.params !== undefined) {
      const issue = pricingParamsIssue(current.strategy as PricingStrategy, params)
      if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { params: [issue] } })
    }
    if (body.scope !== undefined) {
      const issue = pricingScopeIssue(target)
      if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { scope: [issue] } })
    }
    const resuming = current.status === 'BREAKER' && body.status === 'ACTIVE'
    const data: Prisma.PricingRuleUncheckedUpdateManyInput = { updatedBy: context.userId }
    if (body.name !== undefined) data.name = body.name
    if (body.mode !== undefined) data.mode = body.mode
    if (body.params !== undefined) data.paramsJson = json(body.params)
    if (body.scope !== undefined) data.targetScopeJson = json(body.scope)
    if (body.maxChangePct !== undefined) data.maxChangePct = body.maxChangePct
    // 情形 × 动作矩阵：传 null 取消（改回按策略求价），传对象整体替换，不传不改
    if (body.scenarioMatrix !== undefined) data.scenarioMatrix = body.scenarioMatrix === null ? Prisma.DbNull : json(body.scenarioMatrix)
    if (body.dailyLimit !== undefined) data.dailyLimit = body.dailyLimit
    if (body.breaker !== undefined) {
      data.breakerFailures = body.breaker.failureStreak
      data.breakerConversionDrop = body.breaker.conversionDropPct
      data.breakerMinMargin = body.breaker.minMarginPct
    }
    if (body.status !== undefined && current.status !== 'BREAKER') data.status = body.status
    // 从熔断恢复：只有明确改为“启用”才恢复，并清掉熔断原因，规则从下一轮开始重新评估。
    if (resuming) Object.assign(data, { status: 'ACTIVE', breakerReason: null, breakerAt: null })
    try {
      const updated = await this.prisma.$transaction(async tx => {
        await updateWithVersion(tx.pricingRule, { id, tenantId }, body.expectedVersion, data as Record<string, unknown>, { label: '定价规则' })
        const row = await tx.pricingRule.findFirstOrThrow({ where: { id, tenantId } })
        await this.audit.record(
          req,
          {
            action: PRICING_RULE_ACTIONS.updated,
            resourceType: 'PricingRule',
            resourceId: id,
            before: { name: current.name, mode: current.mode, status: current.status, version: current.version },
            after: {
              name: row.name,
              mode: row.mode,
              status: row.status,
              version: row.version,
              resumed: resuming,
              ...(body.scenarioMatrix !== undefined ? { scenarioMatrix: body.scenarioMatrix } : {}),
            },
          },
          { client: tx },
        )
        return row
      })
      const store = await this.prisma.sellerAccount.findFirst({ where: { id: updated.sellerAccountId, tenantId }, select: { displayName: true } })
      return (await this.views(tenantId, [updated], new Map([[updated.sellerAccountId, store?.displayName ?? '']])))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw dupName()
      throw error
    }
  }
}
