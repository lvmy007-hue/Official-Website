import { isOutOfBudgetStatus } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { money, num, profileScope } from './ads-common'
import { scopeFilter } from './params'

// 广告超预算预警评估器（P3-18，09 章 9.1 广告类）：启用中的活动，活动管理接口同步到的投放状态带“预算用完”（OUT_OF_BUDGET）。
// 判断与今日广告页的“超预算活动”一致，都用 api-contracts 的 isOutOfBudgetStatus（子串、不分大小写）。
// 局限（都写进规则说明与证据）：投放状态随活动同步刷新，不是实时的；“带 OUT_OF_BUDGET”是未对真实广告账户核对过的假设；
// 营销数据流第二版不含预算消耗数据集，小时数据接收端又暂缓（14.10），所以算不出“超预算时长”。不限币种（状态与币种无关）；不给影响金额（没有可靠依据）。

const READ_LIMIT = 2000

export const adsOutOfBudgetEvaluator: AlertEvaluator = {
  type: 'ads.out-of-budget',
  async evaluate({ db, tenantId, rule }) {
    const scope = scopeFilter(rule)
    const campaigns = await db.adsCampaign.findMany({
      where: {
        tenantId,
        state: { equals: 'ENABLED', mode: 'insensitive' },
        servingStatus: { contains: 'OUT_OF_BUDGET', mode: 'insensitive' },
        ...profileScope(scope),
      },
      select: {
        id: true,
        name: true,
        adProduct: true,
        servingStatus: true,
        budget: true,
        budgetType: true,
        currency: true,
        sourceUpdatedAt: true,
        adsProfile: { select: { sellerAccountId: true, sellerAccount: { select: { displayName: true } } } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    return campaigns
      .filter(campaign => isOutOfBudgetStatus(campaign.servingStatus))
      .map((campaign): AlertHit => {
        const store = campaign.adsProfile.sellerAccount?.displayName ?? null
        const budget = num(campaign.budget)
        return {
          entityType: 'CAMPAIGN',
          entityId: campaign.id,
          sellerAccountId: campaign.adsProfile.sellerAccountId,
          entityLabel: store ? `${campaign.name}（${store}）` : campaign.name,
          title: `广告活动“${campaign.name}”预算已用完（投放状态 ${campaign.servingStatus}）`,
          suggestedAction: '到广告活动详情看预算利用率与近几天的转化：成本销售比低于目标说明预算不够，可适当提高预算或把预算从低效活动挪过来；成本销售比高则不要加预算',
          evidence: {
            campaignName: campaign.name,
            adProduct: campaign.adProduct,
            storeName: store,
            servingStatus: campaign.servingStatus,
            budget: budget === null ? null : money(budget),
            budgetType: campaign.budgetType,
            currency: campaign.currency,
            statusUpdatedAt: campaign.sourceUpdatedAt.toISOString(),
          },
        }
      })
  },
}
