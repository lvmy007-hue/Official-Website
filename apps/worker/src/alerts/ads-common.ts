import type { PrismaClient } from '@prisma/client'
import type { scopeFilter } from './params'

// 广告预警评估器的公共小件（P3-18）：范围条件、活动与店铺名称的读取、活动对象的登记方式。
// 广告预警只看美元活动（与广告控制台一致，不折算其他币种）；规则范围里的店铺经广告档案的绑定店铺（AdsProfile.sellerAccountId）过滤，
// 没有绑定店铺的档案只有不限店铺的规则才看得到。

export const DAY_MS = 86_400_000
export const ADS_ALERT_CURRENCY = 'USD'
const KEY_LIMIT = 5000

type Dec = { toString(): string } | null | undefined
export const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))
export const money = (value: number) => Math.round(value * 100) / 100
export const percent = (value: number) => `${Math.round(value * 1000) / 10}%`
export const utcDay = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
export const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type Scope = ReturnType<typeof scopeFilter>
/** 规则范围里的店铺换成对广告档案的关系条件（没有设置店铺范围就不限制）。 */
export const profileScope = (scope: Scope) => (scope.stores ? { adsProfile: { sellerAccountId: { in: scope.stores } } } : {})

export interface CampaignKey {
  adsProfileId: string
  adProduct: string
  campaignId: string
}
export const campaignKeyOf = (key: CampaignKey) => `${key.adsProfileId}|${key.adProduct}|${key.campaignId}`

export interface CampaignInfo {
  id: string
  name: string
}

/** 活动管理接口里这些活动的本地记录（有就能链到活动详情）；键是 档案|广告产品|活动编号。 */
export async function loadCampaigns(db: PrismaClient, tenantId: string, keys: readonly CampaignKey[]): Promise<Map<string, CampaignInfo>> {
  if (keys.length === 0) return new Map()
  const found = await db.adsCampaign.findMany({
    where: {
      tenantId,
      adsProfileId: { in: [...new Set(keys.map(key => key.adsProfileId))] },
      externalCampaignId: { in: [...new Set(keys.map(key => key.campaignId))] },
    },
    select: { id: true, adsProfileId: true, adProduct: true, externalCampaignId: true, name: true },
    orderBy: { id: 'asc' },
    take: KEY_LIMIT,
  })
  return new Map(found.map(row => [campaignKeyOf({ adsProfileId: row.adsProfileId, adProduct: row.adProduct, campaignId: row.externalCampaignId }), { id: row.id, name: row.name }]))
}

/** 广告档案绑定的店铺（没有绑定为 null）与店铺名称。 */
export async function loadProfileStores(db: PrismaClient, tenantId: string, profileIds: readonly string[]): Promise<{ storeOf: Map<string, string | null>; storeName: Map<string, string> }> {
  const ids = [...new Set(profileIds)]
  if (ids.length === 0) return { storeOf: new Map(), storeName: new Map() }
  const profiles = await db.adsProfile.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, sellerAccountId: true }, take: KEY_LIMIT })
  const storeIds = [...new Set(profiles.flatMap(profile => (profile.sellerAccountId ? [profile.sellerAccountId] : [])))]
  const stores = storeIds.length > 0 ? await db.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: 1000 }) : []
  return { storeOf: new Map(profiles.map(profile => [profile.id, profile.sellerAccountId])), storeName: new Map(stores.map(store => [store.id, store.displayName])) }
}

/** 活动对象的登记：有本地记录的链到活动详情（CAMPAIGN），没有的按 档案|广告产品|活动编号 登记（ADS_CAMPAIGN，没有详情页）。 */
export function campaignRef(key: CampaignKey, info: CampaignInfo | undefined) {
  return {
    entityType: info ? 'CAMPAIGN' : 'ADS_CAMPAIGN',
    entityId: info?.id ?? campaignKeyOf(key),
    name: info?.name ?? `活动 ${key.campaignId}`,
  }
}
