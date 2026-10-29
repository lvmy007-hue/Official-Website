import { Injectable } from '@nestjs/common'
import {
  ADS_CAMPAIGN_ENTITY_TYPE,
  ADS_CAMPAIGN_EVENT_KIND,
  ADS_CAMPAIGN_META_ACTION,
  ADS_CAMPAIGN_WRITE,
  AdsCampaignMetaBodySchema,
  applyTagChange,
  tagProblem,
  type AdsCampaignMetaResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { adsRelationWhere, ContextService } from '../auth'

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])
const tagsText = (tags: readonly string[]) => (tags.length ? tags.join('、') : '（无）')

// 批量设置标签与负责人（08 章 8.3 批量动作中不写亚马逊的部分）：只改本系统的 AdsCampaign.tags / ownerId，同步器从不改这两列。
// 每个活动带版本号（乐观锁），整批在一个事务里：任何一个冲突或不存在，整批不生效。每个活动写一条审计和一条变更记录（“操作记录”页签读它）。
@Injectable()
export class AdsCampaignMetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async update(req: RequestWithContext, rawBody: unknown): Promise<AdsCampaignMetaResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_CAMPAIGN_WRITE, {})
    const body = AdsCampaignMetaBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const ids = body.items.map(item => item.id)
    if (new Set(ids).size !== ids.length) throw appError('DATA_CONDITION_FAILED', '同一个活动不能在一次请求里出现多次')
    if (body.ownerId) {
      const member = await this.prisma.membership.findFirst({ where: { tenantId, userId: body.ownerId, status: 'ACTIVE' }, select: { id: true } })
      if (!member) throw appError('DATA_CONDITION_FAILED', '负责人必须是企业的在职成员')
    }
    const found = await this.prisma.adsCampaign.findMany({
      where: { tenantId, id: { in: ids }, ...adsRelationWhere(scope) },
      select: { id: true, name: true, tags: true, ownerId: true, version: true, adsProfile: { select: { sellerAccountId: true } } },
      take: ids.length,
    })
    // 范围外的活动与不存在一样处理，不泄露存在性
    if (found.length !== ids.length) throw appError('RESOURCE_NOT_FOUND', `有 ${ids.length - found.length} 个活动不存在或不在你的数据范围内，整批没有修改`)
    const byId = new Map(found.map(row => [row.id, row]))
    const names = await memberNames(this.prisma, tenantId, [...found.map(row => row.ownerId), body.ownerId])

    const plans = body.items.map(item => {
      const current = byId.get(item.id)!
      const nextTags = body.tags ? applyTagChange(current.tags, body.tags.mode, body.tags.values) : current.tags
      const problem = tagProblem(nextTags)
      if (problem) throw appError('DATA_CONDITION_FAILED', `活动“${current.name}”：${problem}`)
      const nextOwner = body.ownerId === undefined ? current.ownerId : body.ownerId
      return { item, current, nextTags, nextOwner, changed: !sameList(current.tags, nextTags) || current.ownerId !== nextOwner }
    })

    const now = new Date()
    const items: AdsCampaignMetaResult['items'] = []
    await this.prisma.$transaction(
      async tx => {
        for (const plan of plans) {
          if (!plan.changed) {
            items.push({ id: plan.item.id, version: plan.current.version, tags: plan.current.tags, ownerId: plan.current.ownerId })
            continue
          }
          const next = await updateWithVersion(
            tx.adsCampaign,
            { id: plan.item.id, tenantId },
            plan.item.version,
            { tags: plan.nextTags, ownerId: plan.nextOwner },
            { label: '广告活动', select: { version: true, tags: true, ownerId: true } },
          )
          const parts = [
            sameList(plan.current.tags, plan.nextTags) ? null : `标签：${tagsText(plan.current.tags)} → ${tagsText(plan.nextTags)}`,
            plan.current.ownerId === plan.nextOwner ? null : `负责人：${nameOrFormer(names, plan.current.ownerId, '（无）')} → ${nameOrFormer(names, plan.nextOwner, '（无）')}`,
          ].filter((part): part is string => part !== null)
          const before = { tags: plan.current.tags, ownerId: plan.current.ownerId }
          const after = { tags: next.tags, ownerId: next.ownerId }
          await tx.entityEvent.create({
            data: {
              tenantId,
              sellerAccountId: plan.current.adsProfile.sellerAccountId,
              entityType: ADS_CAMPAIGN_ENTITY_TYPE,
              entityId: plan.item.id,
              kind: ADS_CAMPAIGN_EVENT_KIND,
              occurredAt: now,
              title: parts.join('；'),
              detailJson: { before, after },
              actorKind: 'USER',
              actorId: context.userId,
              sourceRef: `meta:${plan.item.id}:${next.version}`,
            },
          })
          await this.audit.record(req, { action: ADS_CAMPAIGN_META_ACTION, resourceType: 'AdsCampaign', resourceId: plan.item.id, before, after }, { client: tx })
          items.push({ id: plan.item.id, version: next.version, tags: next.tags, ownerId: next.ownerId })
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    const updated = plans.filter(plan => plan.changed).length
    return { updated, unchanged: plans.length - updated, items }
  }
}
