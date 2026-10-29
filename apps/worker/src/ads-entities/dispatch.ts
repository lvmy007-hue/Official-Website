import { ADS_ENTITY_SYNC_JOB } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { AdsV1Api } from '../connectors/ads-v1-api'
import type { AmazonAdsApiClient } from '../connectors/amazon-ads-api'
import type { SyncPayload } from '../types'
import { discoverAdsAccounts, type AccountDiscovery } from './accounts'
import { syncAdsEntities } from './sync'

// 广告实体同步任务与账户发现的分发（P5-12A）：由连接器分发函数在亚马逊广告连接上调用；本文件只做装配。

export const ADS_ENTITY_JOB_TYPES: readonly string[] = [ADS_ENTITY_SYNC_JOB]

type Deps = { prisma: PrismaClient; logger: Logger }

/**
 * 档案同步之后顺带发现统一接口的账户编号。发现失败（例如应用没有账户管理权限）不让档案同步失败：
 * 结果里记下失败原因，实体与新报告任务会因为档案没有账户编号而以“等待依赖”收场，不是同步故障。
 */
export async function discoverAccountsSafely(deps: Deps, client: AmazonAdsApiClient, tenantId: string): Promise<AccountDiscovery | { error: string }> {
  try {
    const found = await discoverAdsAccounts(deps.prisma, client, tenantId)
    if (found.conflicts > 0 || found.unmatched > 0) deps.logger.warn({ ...found }, 'ads account discovery finished with unmatched or conflicting accounts')
    return found
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error)
    deps.logger.warn({ error: message }, 'ads account discovery failed')
    return { error: message }
  }
}

export async function processAdsEntities(deps: Deps, client: AmazonAdsApiClient, row: { tenantId: string }, payload: SyncPayload) {
  if (!payload.adsProfileId) throw new NonRetryableError('ADS_ENTITY_PROFILE_MISSING', '广告实体同步任务缺少广告档案编号')
  const profile = await deps.prisma.adsProfile.findFirst({
    where: { id: payload.adsProfileId, tenantId: row.tenantId },
    select: { id: true, tenantId: true, profileId: true, adsAccountId: true, displayName: true, currencyCode: true },
  })
  if (!profile) throw new NonRetryableError('ADS_ENTITY_PROFILE_MISSING', '广告档案不存在')
  if (!profile.adsAccountId) throw new NonRetryableError('ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号，无法同步广告实体')
  const result = await syncAdsEntities(deps, {
    profile: { id: profile.id, tenantId: profile.tenantId, adsAccountId: profile.adsAccountId, displayName: profile.displayName, currencyCode: profile.currencyCode },
    api: new AdsV1Api(client, profile.adsAccountId),
    loadPortfolios: () => client.listPortfolios(profile.profileId),
  })
  return { ...result, adsProfileId: profile.id }
}
