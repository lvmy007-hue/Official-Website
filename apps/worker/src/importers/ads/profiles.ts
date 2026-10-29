import type { AmazonAdsApiClient } from '../../connectors/amazon-ads-api'
import { autoBindAdsProfile, pickAdsAccountId } from '../../connectors/ads-binding'
import type { ImportContext, JsonObject } from '../../types'

export async function syncAdsProfiles(ctx: ImportContext, client: AmazonAdsApiClient, tenantId: string, connectionId: string) {
  const { prisma, logger } = ctx
  const profiles = await client.getProfiles()
  let imported = 0
  for (const item of profiles) {
    const profileId = String(item.profileId ?? '')
    if (!profileId) continue
    const accountInfo = (item.accountInfo ?? {}) as JsonObject
    const countryCode = String(item.countryCode ?? 'US')
    const marketplaceId = String(item.marketplaceStringId ?? (countryCode === 'US' ? 'ATVPDKIKX0DER' : '')) || 'ATVPDKIKX0DER'
    const profile = await prisma.adsProfile.upsert({
      where: { tenantId_profileId: { tenantId, profileId } },
      create: {
        tenantId,
        profileId,
        legacyScopeId: profileId,
        accountId: pickAdsAccountId(item),
        marketplaceId,
        countryCode,
        currencyCode: String(item.currencyCode ?? 'USD'),
        timezone: typeof item.timeZone === 'string' ? item.timeZone : typeof item.timezone === 'string' ? item.timezone : undefined,
        displayName: typeof accountInfo.name === 'string' ? accountInfo.name : `Amazon Ads · ${countryCode}`,
        sourceUpdatedAt: new Date(),
      },
      update: {
        legacyScopeId: profileId,
        accountId: pickAdsAccountId(item),
        marketplaceId,
        countryCode,
        currencyCode: String(item.currencyCode ?? 'USD'),
        timezone: typeof item.timeZone === 'string' ? item.timeZone : typeof item.timezone === 'string' ? item.timezone : undefined,
        displayName: typeof accountInfo.name === 'string' ? accountInfo.name : undefined,
        status: 'ACTIVE',
        sourceUpdatedAt: new Date(),
      },
    })
    await autoBindAdsProfile(prisma, profile)
    await prisma.platformConnection.update({
      where: { id: connectionId },
      data: { adsProfileId: profile.id, externalAccountId: profileId, lastSuccessfulSyncAt: new Date(), lastHealthCheckedAt: new Date(), lastErrorCode: null },
    })
    imported += 1
    try {
      const campaigns = await client.listCampaigns(profileId)
      for (const campaign of campaigns) {
        const externalCampaignId = String(campaign.campaignId ?? campaign.id ?? '')
        if (!externalCampaignId) continue
        await prisma.adsCampaign.upsert({
          where: { adsProfileId_externalCampaignId_adProduct: { adsProfileId: profile.id, externalCampaignId, adProduct: 'SPONSORED_PRODUCTS' } },
          create: {
            tenantId,
            adsProfileId: profile.id,
            externalCampaignId,
            adProduct: 'SPONSORED_PRODUCTS',
            name: String(campaign.name ?? externalCampaignId),
            state: String(campaign.state ?? 'UNKNOWN'),
            budget: campaign.budget && typeof campaign.budget === 'object' ? Number((campaign.budget as JsonObject).budget ?? 0) : typeof campaign.budget === 'number' ? campaign.budget : undefined,
            currency: String(campaign.budget && typeof campaign.budget === 'object' ? ((campaign.budget as JsonObject).currencyCode ?? profile.currencyCode) : profile.currencyCode),
            startDate: typeof campaign.startDate === 'string' ? new Date(campaign.startDate) : undefined,
            endDate: typeof campaign.endDate === 'string' ? new Date(campaign.endDate) : undefined,
            sourceUpdatedAt: new Date(),
            raw: JSON.parse(JSON.stringify(campaign)),
          },
          update: {
            name: String(campaign.name ?? externalCampaignId),
            state: String(campaign.state ?? 'UNKNOWN'),
            budget: campaign.budget && typeof campaign.budget === 'object' ? Number((campaign.budget as JsonObject).budget ?? 0) : typeof campaign.budget === 'number' ? campaign.budget : undefined,
            sourceUpdatedAt: new Date(),
            raw: JSON.parse(JSON.stringify(campaign)),
          },
        })
      }
    } catch (error) {
      logger.warn({ profileId, error: error instanceof Error ? error.message : String(error) }, 'Ads profile imported but campaign sync failed')
    }
  }
  return { imported, profiles: profiles.length }
}
