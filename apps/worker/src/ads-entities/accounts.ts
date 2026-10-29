import type { PrismaClient } from '@prisma/client'
import type { AmazonAdsApiClient } from '../connectors/amazon-ads-api'
import type { JsonObject } from '../types'

// 广告账户发现（P5-12A，importers.md A-01）：统一接口的所有请求都要全球广告账户编号（Amazon-Ads-AccountId），而旧档案同步只拿到档案编号（profileId）。
// 账户管理接口列出每个广告账户及它的旧档案编号（alternateIds[].profileId），按这个对应关系把账户编号填进广告档案（AdsProfile.adsAccountId），并建好账户行（指标与实体表对它有外键）。
// 规则：
//   - 档案已有账户编号就不改（不被接口的变化悄悄换掉，换了会让历史数据挂到别的账户上），编号冲突只计数；
//   - 一个账户编号只给一个档案（企业内唯一）；一个账户对应多个已知档案时只给第一个，其余档案不动（它们要等接口给出各自的账户）；账户编号已被别的档案占用计入冲突；
//   - 账户在接口里有、但本系统没有对应档案的（没授权的站点）计入 unmatched，不建档案；
//   - 【未对真实账户验证】响应字段见 AmazonAdsApiClient.listAdsAccounts。

export type AccountDiscovery = { found: number; linked: number; alreadyLinked: number; unmatched: number; conflicts: number }

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined)
const obj = (value: unknown): JsonObject => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {})

/** 亚马逊的账户状态 → 本地：已创建就是启用，其余原样（大写）。 */
export const accountStatusOf = (value: unknown): string => {
  const status = text(value)?.toUpperCase()
  return !status || status === 'CREATED' ? 'ACTIVE' : status
}

type ProfileRow = { id: string; profileId: string; adsAccountId: string | null; currencyCode: string; timezone: string | null; displayName: string | null }

export async function discoverAdsAccounts(db: PrismaClient, client: Pick<AmazonAdsApiClient, 'listAdsAccounts'>, tenantId: string, now = new Date()): Promise<AccountDiscovery> {
  const accounts = await client.listAdsAccounts()
  const profiles: ProfileRow[] = await db.adsProfile.findMany({
    where: { tenantId },
    select: { id: true, profileId: true, adsAccountId: true, currencyCode: true, timezone: true, displayName: true },
    orderBy: { id: 'asc' },
    take: 5000,
  })
  const byProfileId = new Map(profiles.map(profile => [profile.profileId, profile]))
  const claimed = new Set(profiles.flatMap(profile => (profile.adsAccountId ? [profile.adsAccountId] : [])))
  const result: AccountDiscovery = { found: 0, linked: 0, alreadyLinked: 0, unmatched: 0, conflicts: 0 }
  for (const item of accounts) {
    const adsAccountId = text(item.adsAccountId)
    if (!adsAccountId) continue
    result.found += 1
    const alternates = Array.isArray(item.alternateIds) ? item.alternateIds.map(obj) : []
    const matches = alternates.flatMap(alternate => {
      const profile = byProfileId.get(text(alternate.profileId) ?? '')
      return profile ? [{ profile, entityId: text(alternate.entityId) }] : []
    })
    const owner = matches.find(match => match.profile.adsAccountId === adsAccountId) ?? matches[0]
    if (!owner) {
      result.unmatched += 1
      continue
    }
    const { profile } = owner
    if (profile.adsAccountId === adsAccountId) result.alreadyLinked += 1
    else if (profile.adsAccountId || claimed.has(adsAccountId)) {
      result.conflicts += 1
      continue
    } else {
      const updated = await db.adsProfile.updateMany({ where: { id: profile.id, tenantId, adsAccountId: null }, data: { adsAccountId } })
      if (updated.count === 0) {
        result.conflicts += 1
        continue
      }
      profile.adsAccountId = adsAccountId
      claimed.add(adsAccountId)
      result.linked += 1
    }
    const name = text(item.accountName) ?? text(item.name) ?? profile.displayName ?? adsAccountId
    const status = accountStatusOf(item.status)
    await db.adsAccount.upsert({
      where: { tenantId_adsAccountId: { tenantId, adsAccountId } },
      create: { tenantId, adsProfileId: profile.id, adsAccountId, name, entityId: owner.entityId, status, currency: profile.currencyCode, timezone: profile.timezone, sourceUpdatedAt: now },
      update: { name, status, ...(owner.entityId ? { entityId: owner.entityId } : {}), sourceUpdatedAt: now },
    })
  }
  return result
}
