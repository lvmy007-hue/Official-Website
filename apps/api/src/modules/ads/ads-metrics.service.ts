import { Injectable } from '@nestjs/common'
import {
  ADS_METRICS_DATASETS,
  ADS_METRICS_DIMENSION_KEYS,
  ADS_METRICS_EMPTY_NOTE,
  ADS_METRICS_KEYS,
  ADS_READ,
  AdsMetricsQuerySchema,
  addSums,
  compareMetricRows,
  metricsRequestIssues,
  metricValuesOf,
  parseKeyList,
  type AdsMetricsDimension,
  type AdsMetricsKey,
  type AdsMetricsResponse,
  type AdsMetricsRow,
} from '@nova/api-contracts'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsProfileWhere, adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { rangeOf } from './ads-campaigns-common'
import { loadMetricGroups, type MetricsGroup } from './ads-metrics-load'
import { decodeOffset, pageOf } from './ads-page'

const PROFILE_OPTION_MAX = 200
const NO_VALUE = '—'
const NOTE_NOT_CONNECTED = '还没有同步到广告档案：先完成亚马逊广告授权并同步档案，才能分析广告指标'
const NOTE_TRUNCATED = '分组太多，只读取了前面的一部分：合计与排序只覆盖读到的部分；请缩小日期范围或减少维度'

// 广告指标（P3-15，08 章 8.13；freeze/api.md /ads/metrics）：在本系统已入库的数据集里自由组合维度与指标，日期趋势按日、周、月折叠，行上带活动详情页的跳转。
// 只读；范围走广告档案绑定的店铺（`adsRelationWhere`），只看美元，空值不当 0。多对象对比与趋势图由页面用同一接口分别请求实现（对比的对象各按“活动”等维度筛出）。
@Injectable()
export class AdsMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 活动与广告组的名称与详情页：只解析当前页的行（报告里没有名称的行用实体表补）。 */
  private async decorate(tenantId: string, scope: ResolvedScope, adsProfileId: string | undefined, entries: Array<{ row: AdsMetricsRow; group: MetricsGroup }>) {
    const campaignIds = [...new Set(entries.flatMap(({ group }) => (group.dims.campaign?.key ? [group.dims.campaign.key] : [])))]
    const groupIds = [...new Set(entries.flatMap(({ group }) => (group.dims.adGroup?.key ? [group.dims.adGroup.key] : [])))]
    const [campaigns, adGroups] = await Promise.all([
      campaignIds.length > 0
        ? this.prisma.adsCampaign.findMany({
            where: { tenantId, ...adsRelationWhere(scope), ...(adsProfileId ? { adsProfileId } : {}), externalCampaignId: { in: campaignIds } },
            select: { id: true, externalCampaignId: true, name: true },
            orderBy: [{ externalCampaignId: 'asc' }, { id: 'asc' }],
            take: campaignIds.length * 4,
          })
        : Promise.resolve([]),
      groupIds.length > 0
        ? this.prisma.adsAdGroup.findMany({
            where: { tenantId, ...adsRelationWhere(scope), ...(adsProfileId ? { adsProfileId } : {}), adGroupId: { in: groupIds } },
            select: { adGroupId: true, name: true },
            orderBy: { adGroupId: 'asc' },
            take: groupIds.length * 4,
          })
        : Promise.resolve([]),
    ])
    const campaignByExternal = new Map<string, { id: string; name: string }>()
    for (const campaign of campaigns) if (!campaignByExternal.has(campaign.externalCampaignId)) campaignByExternal.set(campaign.externalCampaignId, campaign)
    const groupName = new Map(adGroups.map(item => [item.adGroupId, item.name]))
    for (const { row, group } of entries) {
      const campaign = group.dims.campaign
      if (campaign) {
        const found = campaignByExternal.get(campaign.key)
        row.dims.campaign = campaign.label && campaign.label !== campaign.key ? campaign.label : (found?.name ?? campaign.label ?? (campaign.key || NO_VALUE))
        row.link = found ? `/app/advertising/campaigns/${found.id}` : null
      }
      const adGroup = group.dims.adGroup
      if (adGroup) row.dims.adGroup = adGroup.label && adGroup.label !== adGroup.key ? adGroup.label : (groupName.get(adGroup.key) ?? adGroup.label ?? (adGroup.key || NO_VALUE))
    }
  }

  async query(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsMetricsResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsMetricsQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const dataset = query.dataset ?? 'CAMPAIGN'
    const info = ADS_METRICS_DATASETS[dataset]
    // 没传维度用数据集的默认维度；传 none 表示不分组，只要合计一行
    const dims =
      query.dims === undefined
        ? { values: [...info.defaultDimensions], invalid: [] as string[] }
        : query.dims === 'none'
          ? { values: [], invalid: [] as string[] }
          : parseKeyList(query.dims, ADS_METRICS_DIMENSION_KEYS)
    const picked = query.metrics === undefined ? { values: [...info.defaultMetrics], invalid: [] as string[] } : parseKeyList(query.metrics, ADS_METRICS_KEYS)
    const issues = metricsRequestIssues({ dataset, dimensions: dims.values, metrics: picked.values, invalidDimensions: dims.invalid, invalidMetrics: picked.invalid, adProduct: query.adProduct })
    if (issues.length > 0) throw new AppError(422, 'ADS_METRICS_REQUEST', issues.join('；'))
    const dimensions: AdsMetricsDimension[] = dims.values
    const metrics: AdsMetricsKey[] = picked.values
    // 排序：没有显式指定时按花费（没选花费就按第一个已选指标）降序；显式指定的必须是行键或已选指标
    const explicitSort = rawQuery.sort !== undefined
    if (explicitSort && query.sort.field !== 'key' && !metrics.includes(query.sort.field as AdsMetricsKey)) throw new AppError(422, 'ADS_METRICS_SORT', '排序的指标必须是已选的指标')
    const sort = explicitSort ? query.sort : { field: metrics.includes('spend') ? 'spend' : metrics[0], dir: 'desc' as const }
    const grain = query.grain ?? 'day'
    const { period, defaulted, zone } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const [loaded, profiles] = await Promise.all([
      loadMetricGroups(this.prisma, { tenantId, scope, dataset, dimensions, grain, period, zone, adsProfileId: query.adsProfileId, adProduct: query.adProduct }),
      this.prisma.adsProfile.findMany({
        where: { tenantId, ...adsProfileWhere(scope) },
        select: { id: true, displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } },
        orderBy: [{ profileId: 'asc' }, { id: 'asc' }],
        take: PROFILE_OPTION_MAX,
      }),
    ])
    const entries = loaded.groups.map(group => {
      const row: AdsMetricsRow = {
        key: dimensions.map(dimension => group.dims[dimension]?.key ?? '').join('|'),
        dims: Object.fromEntries(dimensions.map(dimension => [dimension, group.dims[dimension]?.label ?? NO_VALUE])),
        values: metricValuesOf(group.sums, metrics),
        link: null,
      }
      return { row, group }
    })
    const compare = compareMetricRows(sort)
    entries.sort((a, b) => compare(a.row, b.row))
    const { page, pageInfo } = pageOf(entries, offset, query.pageSize, binding)
    await this.decorate(tenantId, scope, query.adsProfileId, page)
    const empty = entries.length === 0
    return {
      state: empty ? (profiles.length === 0 ? 'NOT_CONNECTED' : 'NO_DATA') : 'OK',
      note: empty ? (profiles.length === 0 ? NOTE_NOT_CONNECTED : ADS_METRICS_EMPTY_NOTE) : loaded.truncated ? NOTE_TRUNCATED : null,
      dataset,
      dimensions,
      metrics,
      grain,
      period,
      defaulted,
      totals: metricValuesOf(addSums(loaded.groups.map(group => group.sums)), metrics),
      groupCount: entries.length,
      truncated: loaded.truncated,
      items: page.map(entry => entry.row),
      profiles: profiles.map(profile => ({ id: profile.id, name: profile.displayName ?? profile.profileId, storeName: profile.sellerAccount?.displayName ?? null })),
      otherCurrencyRows: loaded.otherCurrencyRows,
      pageInfo,
    }
  }
}
