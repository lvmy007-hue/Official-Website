import { Injectable } from '@nestjs/common'
import { ADS_READ, ADS_WRITE_KIND_INFO, BulkKeywordBodySchema, keywordKey, splitBulkItems, type AdsBulkAddResponse, type AdsWriteKind, type AdsWriteOp } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { AdsWriteService } from './ads-write.service'

const EXISTING_LIMIT = 19_999
const NOT_FOUND = '广告组或活动不存在，或不在你的数据范围内'

type Parent = { kind: 'group'; adsProfileId: string; adGroupId: string } | { kind: 'campaign'; adsProfileId: string; campaignId: string }

// 词研究一键加词的批量入口（P6-24，16 章第 8 节；freeze/api.md POST /ads/keywords/bulk-add）：把品牌分析搜索词、词级中心的候选词一次加成关键词或否定投放。
// 不另起写入通道：先去掉目标里已经有的词和批内重复的词（所以同一份请求重复提交是幂等的，被跳过的逐条说明原因），其余逐项交给统一写入流水线
// （权限 → 参数 → 对象与范围 → 动作守卫与开关 → 每项一条写入记录 → 审计 → 后台任务）。每项各自成记录，亚马逊的成败逐项独立；预览沿用 POST /ads/preview。
@Injectable()
export class AdsBulkAddService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly writes: AdsWriteService,
  ) {}

  async submit(req: RequestWithContext, rawBody: unknown): Promise<AdsBulkAddResponse> {
    // 权限先于参数校验：先要有广告读取权限，再要有这类写入自己的权限
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    const rawMode = rawBody && typeof rawBody === 'object' ? (rawBody as { mode?: unknown }).mode : undefined
    await this.context.authorize(req, ADS_WRITE_KIND_INFO[rawMode === 'NEGATIVE' ? 'NEGATIVE_ADD' : 'KEYWORD_ADD'].permission)
    const body = BulkKeywordBodySchema.parse(rawBody)
    const kind: AdsWriteKind = body.mode === 'NEGATIVE' ? 'NEGATIVE_ADD' : 'KEYWORD_ADD'
    const parent = await this.parentOf(context.tenantId, scope, body.mode, body.level, body.entityId)
    const existing = await this.existing(context.tenantId, body.mode, parent)
    const { pending, skipped } = splitBulkItems(body.items, existing)
    if (pending.length === 0) return { state: 'NOTHING_TO_ADD', requested: body.items.length, runs: [], skipped }

    const ops: AdsWriteOp[] = pending.map(item => ({
      kind,
      entityId: body.entityId,
      text: item.text,
      matchType: item.matchType,
      ...(kind === 'NEGATIVE_ADD' ? { level: body.level } : item.amount === undefined ? {} : { amount: item.amount }),
    }))
    const result = await this.writes.submit(req, { ops }, { allow: allowed => allowed === kind, audit: { bulkAdd: true, source: body.source, requested: body.items.length, skipped: skipped.length } })
    return { state: 'QUEUED', requested: body.items.length, runs: result.runs, skipped }
  }

  /** 找父对象（范围外与不存在一样 404，不泄露存在性）。 */
  private async parentOf(tenantId: string, scope: ResolvedScope, mode: 'KEYWORD' | 'NEGATIVE', level: 'CAMPAIGN' | 'AD_GROUP' | undefined, id: string): Promise<Parent> {
    const where = { id, tenantId, ...adsRelationWhere(scope) }
    if (mode === 'NEGATIVE' && level === 'CAMPAIGN') {
      const campaign = await this.prisma.adsCampaign.findFirst({ where, select: { adsProfileId: true, externalCampaignId: true } })
      if (!campaign) throw appError('RESOURCE_NOT_FOUND', NOT_FOUND)
      return { kind: 'campaign', adsProfileId: campaign.adsProfileId, campaignId: campaign.externalCampaignId }
    }
    const group = await this.prisma.adsAdGroup.findFirst({ where, select: { adsProfileId: true, adGroupId: true } })
    if (!group) throw appError('RESOURCE_NOT_FOUND', NOT_FOUND)
    return { kind: 'group', adsProfileId: group.adsProfileId, adGroupId: group.adGroupId }
  }

  /** 目标里已有的“词 + 匹配方式”（已归档的关键词不算）。 */
  private async existing(tenantId: string, mode: 'KEYWORD' | 'NEGATIVE', parent: Parent): Promise<Set<string>> {
    if (mode === 'KEYWORD' && parent.kind === 'group') {
      const rows = await this.prisma.adsKeyword.findMany({
        where: { tenantId, adsProfileId: parent.adsProfileId, adGroupId: parent.adGroupId, NOT: { state: { equals: 'ARCHIVED', mode: 'insensitive' } } },
        select: { text: true, matchType: true },
        orderBy: [{ id: 'asc' }],
        take: EXISTING_LIMIT,
      })
      return new Set(rows.map(row => keywordKey(row.text, row.matchType)))
    }
    const where =
      parent.kind === 'campaign'
        ? { tenantId, adsProfileId: parent.adsProfileId, level: 'CAMPAIGN', campaignId: parent.campaignId }
        : { tenantId, adsProfileId: parent.adsProfileId, level: 'AD_GROUP', adGroupId: parent.adGroupId }
    const rows = await this.prisma.adsNegativeTarget.findMany({ where, select: { expression: true, matchType: true }, orderBy: [{ id: 'asc' }], take: EXISTING_LIMIT })
    return new Set(rows.map(row => keywordKey(row.expression, row.matchType)))
  }
}
