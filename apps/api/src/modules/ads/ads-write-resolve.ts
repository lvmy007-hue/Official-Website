import { adsMoneyText, type AdsWriteEntity, type AdsWriteOp } from '@nova/api-contracts'
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../platform/prisma.service'
import { adsProfileWhere, type ResolvedScope } from '../auth'

// 广告写入的对象解析（P3-17）：把请求里的系统编号解析成“要调用亚马逊所需的外部编号、当前值、所属广告档案”。
// 范围外与不存在一律按“不存在”处理（不泄露范围外对象的存在），解析结果带原因而不是抛错，预览才能逐项显示。

export interface ResolvedWrite {
  index: number
  op: AdsWriteOp
  /** 解析成功时的对象信息；失败时为 null，blocker 写原因。 */
  target: {
    adsProfileId: string
    adsAccountId: string | null
    sellerAccountId: string | null
    entityType: AdsWriteEntity
    entityId: string
    /** 修改对象的亚马逊编号；新增类是父对象（活动或广告组）的亚马逊编号。 */
    externalId: string
    /** 否定挂在广告组或关键词挂在广告组时，所属活动的亚马逊编号。 */
    campaignExternalId: string | null
    label: string
    before: string | null
    /** 投放对象来自哪张表。 */
    table: 'AdsTarget' | 'AdsKeyword' | null
    /** 目前的状态（用于判断“没有变化”）。 */
    currentState: string | null
  } | null
  blocker: string | null
}

const MISSING = '对象不存在或不在你的数据范围内'

@Injectable()
export class AdsWriteResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(tenantId: string, scope: ResolvedScope, ops: readonly AdsWriteOp[]): Promise<ResolvedWrite[]> {
    const scoped = { tenantId, adsProfile: adsProfileWhere(scope) }
    const ids = (pick: (op: AdsWriteOp) => boolean) => [...new Set(ops.filter(pick).map(op => op.entityId))]
    const campaignIds = ids(op => op.kind.startsWith('CAMPAIGN_') || (op.kind === 'NEGATIVE_ADD' && op.level === 'CAMPAIGN'))
    const groupIds = ids(op => op.kind.startsWith('AD_GROUP_') || op.kind === 'KEYWORD_ADD' || (op.kind === 'NEGATIVE_ADD' && op.level === 'AD_GROUP'))
    const targetIds = ids(op => op.kind.startsWith('TARGET_'))
    const [campaigns, groups, targets, keywords] = await Promise.all([
      campaignIds.length
        ? this.prisma.adsCampaign.findMany({
            where: { id: { in: campaignIds }, ...scoped },
            select: {
              id: true,
              adsProfileId: true,
              externalCampaignId: true,
              name: true,
              state: true,
              budget: true,
              bidStrategy: true,
              adsProfile: { select: { adsAccountId: true, sellerAccountId: true } },
            },
            orderBy: { id: 'asc' },
            take: campaignIds.length,
          })
        : [],
      groupIds.length
        ? this.prisma.adsAdGroup.findMany({
            where: { id: { in: groupIds }, ...scoped },
            select: {
              id: true,
              adsProfileId: true,
              adGroupId: true,
              campaignId: true,
              name: true,
              state: true,
              defaultBid: true,
              adsProfile: { select: { adsAccountId: true, sellerAccountId: true } },
            },
            orderBy: { id: 'asc' },
            take: groupIds.length,
          })
        : [],
      targetIds.length
        ? this.prisma.adsTarget.findMany({
            where: { id: { in: targetIds }, ...scoped },
            select: { id: true, adsProfileId: true, targetId: true, adGroupId: true, expression: true, bid: true, state: true, adsProfile: { select: { adsAccountId: true, sellerAccountId: true } } },
            orderBy: { id: 'asc' },
            take: targetIds.length,
          })
        : [],
      targetIds.length
        ? this.prisma.adsKeyword.findMany({
            where: { id: { in: targetIds }, ...scoped },
            select: { id: true, adsProfileId: true, keywordId: true, adGroupId: true, text: true, bid: true, state: true, adsProfile: { select: { adsAccountId: true, sellerAccountId: true } } },
            orderBy: { id: 'asc' },
            take: targetIds.length,
          })
        : [],
    ])
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map(row => [row.id, row]))
    const campaignMap = byId(campaigns)
    const groupMap = byId(groups)
    const targetMap = byId(targets)
    const keywordMap = byId(keywords)
    const fail = (index: number, op: AdsWriteOp, blocker = MISSING): ResolvedWrite => ({ index, op, target: null, blocker })

    return ops.map((op, index): ResolvedWrite => {
      const profile = (row: { adsProfileId: string; adsProfile: { adsAccountId: string | null; sellerAccountId: string | null } }) => ({
        adsProfileId: row.adsProfileId,
        adsAccountId: row.adsProfile.adsAccountId,
        sellerAccountId: row.adsProfile.sellerAccountId,
      })
      const campaignTarget = () => {
        const row = campaignMap.get(op.entityId)
        if (!row) return null
        return {
          ...profile(row),
          entityType: 'CAMPAIGN' as const,
          entityId: row.id,
          externalId: row.externalCampaignId,
          campaignExternalId: row.externalCampaignId,
          label: row.name,
          before: op.kind === 'CAMPAIGN_STATE' ? row.state : op.kind === 'CAMPAIGN_BUDGET' ? adsMoneyText(row.budget?.toString()) : op.kind === 'CAMPAIGN_BID_STRATEGY' ? row.bidStrategy : null,
          table: null,
          currentState: row.state,
        }
      }
      const groupTarget = () => {
        const row = groupMap.get(op.entityId)
        if (!row) return null
        return {
          ...profile(row),
          entityType: 'AD_GROUP' as const,
          entityId: row.id,
          externalId: row.adGroupId,
          campaignExternalId: row.campaignId,
          label: row.name,
          before: op.kind === 'AD_GROUP_STATE' ? row.state : op.kind === 'AD_GROUP_BID' ? adsMoneyText(row.defaultBid?.toString()) : null,
          table: null,
          currentState: row.state,
        }
      }
      let target: ResolvedWrite['target'] = null
      if (op.kind.startsWith('CAMPAIGN_') || (op.kind === 'NEGATIVE_ADD' && op.level === 'CAMPAIGN')) target = campaignTarget()
      else if (op.kind.startsWith('AD_GROUP_') || op.kind === 'KEYWORD_ADD' || op.kind === 'NEGATIVE_ADD') target = groupTarget()
      else {
        const t = targetMap.get(op.entityId)
        const k = keywordMap.get(op.entityId)
        const row = t ?? k
        if (row) {
          target = {
            ...profile(row),
            entityType: 'TARGET',
            entityId: row.id,
            externalId: t ? t.targetId : k!.keywordId,
            campaignExternalId: null,
            label: t ? t.expression : k!.text,
            before: op.kind === 'TARGET_STATE' ? row.state : adsMoneyText(row.bid?.toString()),
            table: t ? 'AdsTarget' : 'AdsKeyword',
            currentState: row.state,
          }
        }
      }
      return target ? { index, op, target, blocker: null } : fail(index, op)
    })
  }
}
