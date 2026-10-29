import { Injectable } from '@nestjs/common'
import { ADS_READ, AdsToolListQuerySchema, groupDuplicateKeywords, keywordMatchLabel, type AdsDuplicateKeyword, type AdsDuplicateKeywordsResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsRelationWhere, ContextService } from '../auth'
import { num } from './ads-campaigns-common'
import { decodeOffset, pageOf } from './ads-page'

const KEYWORD_LIMIT = 19_999
const NAME_LIMIT = 19_999
const NOTE_NEVER = '还没有同步任何关键词（需要广告实体同步器的关键词）；连接广告账户并同步后才会出现'
const NOTE_NONE = '没有发现重复关键词：同一个词、同一匹配方式没有出现在多个广告组里'

// 重复关键词检查（P6-24，16 章第 8 节；freeze/api.md GET /ads/duplicate-keywords）：同一广告账户下，同一个词（不分大小写、合并空白）、
// 同一匹配方式出现在两个及以上广告组的，逐组列出每个位置的广告组、活动、状态与竞价。已归档的不算。只读 ads.read 与数据范围。
@Injectable()
export class AdsDuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsDuplicateKeywordsResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsToolListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const scoped = { tenantId, ...adsRelationWhere(scope) }
    const found = await this.prisma.adsKeyword.findMany({
      where: { ...scoped, NOT: { state: { equals: 'ARCHIVED', mode: 'insensitive' } }, ...(query.matchType ? { matchType: { equals: query.matchType, mode: 'insensitive' } } : {}) },
      select: { id: true, adsProfileId: true, campaignId: true, adGroupId: true, text: true, matchType: true, bid: true, state: true },
      orderBy: [{ id: 'asc' }],
      take: KEYWORD_LIMIT + 1,
    })
    const truncated = found.length > KEYWORD_LIMIT
    const groups = groupDuplicateKeywords(found.slice(0, KEYWORD_LIMIT).map(row => ({ ...row, bid: num(row.bid) })))
    const q = query.q?.toLowerCase()
    const matched = q ? groups.filter(group => group.text.includes(q)) : groups
    const { page, pageInfo } = pageOf(matched, offset, query.pageSize, binding)

    const records = page.flatMap(group => group.records)
    const names = await this.names(scoped, records)
    const items = page.map((group): AdsDuplicateKeyword => {
      return {
        key: group.key,
        adsProfileId: group.adsProfileId,
        text: group.text,
        matchType: group.matchType,
        matchLabel: keywordMatchLabel(group.matchType),
        adGroupCount: new Set(group.records.map(record => `${record.campaignId}|${record.adGroupId}`)).size,
        locations: group.records.map(record => {
          const adGroup = names.groups.get(`${record.adsProfileId}|${record.adGroupId}`) ?? null
          const campaign = names.campaigns.get(`${record.adsProfileId}|${record.campaignId}`) ?? null
          return {
            keywordId: record.id,
            adGroupExternalId: record.adGroupId,
            adGroupId: adGroup?.id ?? null,
            adGroupName: adGroup?.name ?? null,
            campaignId: campaign?.id ?? null,
            campaignName: campaign?.name ?? null,
            state: record.state,
            bid: record.bid,
          }
        }),
      }
    })
    const state = groups.length > 0 ? 'OK' : found.length > 0 ? 'NO_DATA' : (await this.hasAny(scoped)) ? 'NO_DATA' : 'NOT_CONNECTED'
    return { state, note: state === 'NOT_CONNECTED' ? NOTE_NEVER : groups.length === 0 ? NOTE_NONE : null, items, pageInfo, total: matched.length, truncated }
  }

  private async hasAny(scoped: { tenantId: string }) {
    return (await this.prisma.adsKeyword.findFirst({ where: scoped, select: { id: true } })) !== null
  }

  /** 当前页涉及的广告组与活动名称：键是“档案|外部编号”。 */
  private async names(scoped: { tenantId: string }, records: ReadonlyArray<{ adsProfileId: string; campaignId: string; adGroupId: string }>) {
    const result = { groups: new Map<string, { id: string; name: string }>(), campaigns: new Map<string, { id: string; name: string }>() }
    if (records.length === 0) return result
    const profileIds = [...new Set(records.map(record => record.adsProfileId))]
    const [groups, campaigns] = await Promise.all([
      this.prisma.adsAdGroup.findMany({
        where: { ...scoped, adsProfileId: { in: profileIds }, adGroupId: { in: [...new Set(records.map(record => record.adGroupId))] } },
        select: { id: true, adsProfileId: true, adGroupId: true, name: true },
        orderBy: [{ id: 'desc' }],
        take: NAME_LIMIT,
      }),
      this.prisma.adsCampaign.findMany({
        where: { ...scoped, adsProfileId: { in: profileIds }, externalCampaignId: { in: [...new Set(records.map(record => record.campaignId))] } },
        select: { id: true, adsProfileId: true, externalCampaignId: true, name: true },
        orderBy: [{ id: 'desc' }],
        take: NAME_LIMIT,
      }),
    ])
    for (const row of groups) result.groups.set(`${row.adsProfileId}|${row.adGroupId}`, { id: row.id, name: row.name })
    for (const row of campaigns) result.campaigns.set(`${row.adsProfileId}|${row.externalCampaignId}`, { id: row.id, name: row.name })
    return result
  }
}
