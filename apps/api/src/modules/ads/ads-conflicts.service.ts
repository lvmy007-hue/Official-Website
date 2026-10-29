import { Injectable } from '@nestjs/common'
import {
  ADS_CONFLICT_RULE_NOTE,
  ADS_READ,
  AdsToolListQuerySchema,
  adsConflicts,
  conflictCounts,
  type AdsConflict,
  type AdsConflictsResponse,
  type ConflictObjectInput,
  type ConflictRuleInput,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsRelationWhere, ContextService } from '../auth'
import { gridOfRecord, targetIdsOf } from './ads-dayparting-common'
import { loadStrategies } from './ads-dayparting-load'
import { decodeOffset, pageOf } from './ads-page'

const RULE_LIMIT = 500
const CAMPAIGN_LIMIT = 19_999
const NOTE_NONE = '没有发现冲突：已启用的分时策略与“自动执行”模式的自动规则没有作用到同一对象的同一字段'

const objectOf = (json: unknown): Record<string, unknown> => (json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {})

/** 把库里的自动规则整理成冲突检查的输入（动作类型与限定活动都在 JSON 里）。 */
export function ruleInputOf(record: { id: string; name: string; adsProfileId: string; status: string; mode: string; level: string; actionJson: unknown; scopeJson: unknown }): ConflictRuleInput {
  const ids = objectOf(record.scopeJson).campaignIds
  return {
    id: record.id,
    name: record.name,
    adsProfileId: record.adsProfileId,
    status: record.status,
    mode: record.mode,
    level: record.level,
    actionType: String(objectOf(record.actionJson).type ?? ''),
    campaignIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
  }
}

// 投放冲突检查（P6-24，16 章第 8 节；freeze/api.md GET /ads/conflicts）：同一对象被多个会写入的分时策略或自动规则作用时列出来，写明谁生效、谁被忽略。
// 只读 ads.read 与数据范围，读系统自己保存的策略与规则，不调亚马逊。判定是契约里的纯函数 adsConflicts（保存时前端也复用同一份结果）。
@Injectable()
export class AdsConflictsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 范围内全部冲突（不分页），以及是否因为上限被截断。 */
  async all(req: RequestWithContext, rawQuery: Record<string, string>): Promise<{ items: AdsConflict[]; truncated: boolean; tenantId: string }> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const tenantId = context.tenantId
    const ctx = { tenantId, scope }
    const [strategies, rules] = await Promise.all([
      loadStrategies(this.prisma, ctx),
      this.prisma.adsAutomationRule.findMany({
        where: { tenantId, ...adsRelationWhere(scope), status: 'ACTIVE', mode: 'AUTO', level: 'CAMPAIGN' },
        select: { id: true, name: true, adsProfileId: true, status: true, mode: true, level: true, actionJson: true, scopeJson: true },
        orderBy: [{ id: 'asc' }],
        take: RULE_LIMIT + 1,
      }),
    ])
    const groupIds = [...new Set(strategies.records.filter(record => record.targetLevel === 'AD_GROUP').flatMap(record => targetIdsOf(record.scopeJson)))]
    const [campaigns, groups] = await Promise.all([
      this.prisma.adsCampaign.findMany({ where: { tenantId, ...adsRelationWhere(scope) }, select: { id: true, name: true, adsProfileId: true }, orderBy: [{ id: 'asc' }], take: CAMPAIGN_LIMIT + 1 }),
      groupIds.length === 0
        ? Promise.resolve([] as ConflictObjectInput[])
        : this.prisma.adsAdGroup.findMany({
            where: { tenantId, ...adsRelationWhere(scope), id: { in: groupIds } },
            select: { id: true, name: true, adsProfileId: true },
            orderBy: [{ id: 'asc' }],
            take: groupIds.length,
          }),
    ])
    const items = adsConflicts({
      strategies: strategies.records.map(record => ({
        id: record.id,
        name: record.name,
        adsProfileId: record.adsProfileId,
        status: record.status,
        kind: record.kind,
        level: record.targetLevel,
        grid: gridOfRecord(record.hourlyMultipliersJson),
        targetIds: targetIdsOf(record.scopeJson),
      })),
      rules: rules.slice(0, RULE_LIMIT).map(ruleInputOf),
      campaigns: campaigns.slice(0, CAMPAIGN_LIMIT),
      adGroups: groups,
    })
    return { items, truncated: strategies.truncated || rules.length > RULE_LIMIT || campaigns.length > CAMPAIGN_LIMIT, tenantId }
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsConflictsResponse> {
    const loaded = await this.all(req, rawQuery)
    const query = AdsToolListQuerySchema.parse(rawQuery)
    const binding = bindingOf(loaded.tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const q = query.q?.toLowerCase()
    const filtered = loaded.items.filter(
      item => (!query.kind || item.kind === query.kind) && (!q || (item.objectName ?? '').toLowerCase().includes(q) || item.parties.some(party => party.name.toLowerCase().includes(q))),
    )
    const { page, pageInfo } = pageOf(filtered, offset, query.pageSize, binding)
    return {
      state: loaded.items.length > 0 ? 'OK' : 'NO_DATA',
      note: loaded.items.length > 0 ? null : NOTE_NONE,
      ruleNote: ADS_CONFLICT_RULE_NOTE,
      items: page,
      pageInfo,
      counts: conflictCounts(loaded.items),
      total: filtered.length,
      truncated: loaded.truncated,
    }
  }
}
