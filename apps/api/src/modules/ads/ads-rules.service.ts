import { Injectable } from '@nestjs/common'
import {
  ADS_READ,
  ADS_RULE_EXECUTION_PENDING,
  ADS_RULE_LIMITS,
  ADS_RULE_WRITE,
  ScopeSearchSchema,
  type AdsRuleDetailResponse,
  type AdsRuleListResponse,
  type AdsRuleProfileOption,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService } from '../../platform/write'
import { adsProfileWhere, adsRelationWhere, ContextService } from '../auth'
import { validZone } from '../overview'
import { autoStatusOf, RULE_ID_PATTERN, RULE_SELECT, ruleRowOf } from './ads-rules-common'
import { ruleQuality } from './ads-rules-quality'

const NOTE_NONE = '还没有创建自动规则：规则按“条件 + 动作 + 护栏”描述什么情况下该处理哪些对象；先用试运行看看会命中什么，再决定启用'

// 自动规则列表与详情（P3-13，08 章 8.10；freeze/api.md /ads/rules*）。只读系统自己的规则与执行记录，不调亚马逊。
@Injectable()
export class AdsRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsRuleListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    ScopeSearchSchema.parse(rawQuery)
    const tenantId = context.tenantId
    const [found, profiles, auto] = await Promise.all([
      this.prisma.adsAutomationRule.findMany({
        where: { tenantId, ...adsRelationWhere(scope) },
        select: RULE_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: ADS_RULE_LIMITS.ruleMax + 1,
      }),
      this.prisma.adsProfile.findMany({
        where: { tenantId, ...adsProfileWhere(scope) },
        select: { id: true, displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } },
        orderBy: [{ profileId: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
      autoStatusOf(this.guard, context),
    ])
    const records = found.slice(0, ADS_RULE_LIMITS.ruleMax)
    const people = await memberNames(
      this.prisma,
      tenantId,
      records.map(record => record.updatedBy),
    )
    const items = records.map(record => ruleRowOf(record, people))
    const options: AdsRuleProfileOption[] = profiles.map(row => ({ id: row.id, name: row.displayName ?? row.profileId, storeName: row.sellerAccount?.displayName ?? null }))
    return {
      rules: { state: items.length > 0 ? 'OK' : 'NO_DATA', note: items.length > 0 ? null : NOTE_NONE, items, truncated: found.length > ADS_RULE_LIMITS.ruleMax },
      profiles: options,
      canWrite: hasPermission(context.permissions as string[], ADS_RULE_WRITE),
      auto,
      execution: ADS_RULE_EXECUTION_PENDING,
    }
  }

  async detail(req: RequestWithContext, id: string, now: Date = new Date()): Promise<AdsRuleDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    if (!RULE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '自动规则不存在')
    const tenantId = context.tenantId
    const record = await this.prisma.adsAutomationRule.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: RULE_SELECT })
    if (!record) throw appError('RESOURCE_NOT_FOUND', '自动规则不存在')
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const [quality, people, auto] = await Promise.all([
      ruleQuality(this.prisma, tenantId, record, now, zone),
      memberNames(this.prisma, tenantId, [record.updatedBy]),
      autoStatusOf(this.guard, context),
    ])
    return {
      rule: ruleRowOf(record, people),
      quality,
      canWrite: hasPermission(context.permissions as string[], ADS_RULE_WRITE),
      auto,
      execution: ADS_RULE_EXECUTION_PENDING,
    }
  }
}
