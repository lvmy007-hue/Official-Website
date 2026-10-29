import type { Prisma } from '@prisma/client'
import { NonRetryableError } from '@nova/workflow'
import type { AdsV1Api } from '../../connectors/ads-v1-api'
import { parseForecast } from '../../connectors/ads-v1-parse'
import type { ImportContext } from '../../types'
import type { AdsAccountScope } from './recommendations'

// 活动预测（importers.md A-01：活动预测 → AdsForecastRun）：修改预算之前，用官方预测给出曝光、点击、花费区间作为影响预览。
// 每次请求留一行（只追加）；预测只是亚马逊给的估计，页面要标注“官方预测，非承诺”。这里不写亚马逊（预测是只读查询）。

/** 预算上限：防止把输错的数字（多打几个零）发给亚马逊；与广告活动日预算的常见量级相比足够宽松。 */
export const FORECAST_BUDGET_MAX = 10_000_000

export async function requestCampaignForecast(
  ctx: ImportContext,
  api: Pick<AdsV1Api, 'forecastCampaign'>,
  scope: AdsAccountScope,
  input: { campaignId: string; requestedBudget: number; currency?: string; requestedBy?: string; now?: Date },
): Promise<{ id: string; forecast: Record<string, unknown> }> {
  if (!input.campaignId) throw new NonRetryableError('ADS_FORECAST_INVALID', '预测需要指定广告活动')
  if (!Number.isFinite(input.requestedBudget) || input.requestedBudget < 0 || input.requestedBudget > FORECAST_BUDGET_MAX) {
    throw new NonRetryableError('ADS_FORECAST_INVALID', `预测预算必须在 0 到 ${FORECAST_BUDGET_MAX} 之间`)
  }
  const forecast = parseForecast(await api.forecastCampaign(input.campaignId, input.requestedBudget))
  if (!forecast) throw new Error('ADS_FORECAST_EMPTY')
  const row = await ctx.prisma.adsForecastRun.create({
    data: {
      tenantId: scope.tenantId,
      adsProfileId: scope.adsProfileId,
      adsAccountId: scope.adsAccountId,
      campaignId: input.campaignId,
      requestedBudget: input.requestedBudget,
      currency: input.currency ?? 'USD',
      forecastJson: forecast as Prisma.InputJsonValue,
      requestedAt: input.now ?? new Date(),
      requestedBy: input.requestedBy,
    },
    select: { id: true },
  })
  return { id: row.id, forecast }
}
