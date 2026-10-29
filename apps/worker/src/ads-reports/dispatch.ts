import { ADS_PARITY_JOB, ADS_REPORT_V1_JOB } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { AdsReportingV1 } from '../connectors/ads-v1-reports'
import type { AmazonAdsApiClient } from '../connectors/amazon-ads-api'
import { tenantTimeZone } from '../derivers/summary-sql'
import { localDay } from '../importers/shared'
import { runAdsParity } from '../parity/ads-run'
import type { SyncPayload } from '../types'
import { runAdsReport } from './run'

// 新报告接口任务与迁移期核对任务的分发（P3-15）：由连接器分发函数在亚马逊广告连接上调用。
// 本文件只做装配：算出企业口径的今天、构造报告接口客户端，具体逻辑在 run.ts 与 parity/ads-run.ts。

export const ADS_REPORT_JOB_TYPES: readonly string[] = [ADS_REPORT_V1_JOB, ADS_PARITY_JOB]

type Deps = { prisma: PrismaClient; logger: Logger }

/** 没有广告账户编号时没法构造接口客户端；运行器会在用到它之前就以 ADS_ACCOUNT_MISSING 结束任务。 */
const unusable = {
  async create(): Promise<string> {
    throw new NonRetryableError('ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号')
  },
  async retrieve(): Promise<never> {
    throw new NonRetryableError('ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号')
  },
}

export async function processAdsReports(deps: Deps, client: AmazonAdsApiClient, row: { type: string; tenantId: string }, payload: SyncPayload) {
  const { prisma } = deps
  const today = localDay(await tenantTimeZone(prisma, row.tenantId))
    .toISOString()
    .slice(0, 10)
  if (row.type === ADS_REPORT_V1_JOB) {
    if (!payload.reportJobId) throw new NonRetryableError('ADS_REPORT_JOB_CONTEXT_MISSING', '同步任务缺少报告任务编号')
    const job = await prisma.adsReportJob.findUnique({ where: { id: payload.reportJobId }, select: { adsProfile: { select: { adsAccountId: true } } } })
    const adsAccountId = job?.adsProfile.adsAccountId
    return runAdsReport(deps, { reportJobId: payload.reportJobId }, { reporting: adsAccountId ? new AdsReportingV1(client, adsAccountId) : unusable, today })
  }
  if (!payload.adsProfileId) throw new NonRetryableError('ADS_PARITY_PROFILE_MISSING', '核对任务缺少广告档案编号')
  const profile = await prisma.adsProfile.findUnique({ where: { id: payload.adsProfileId }, select: { adsAccountId: true } })
  if (!profile?.adsAccountId) throw new NonRetryableError('ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号，无法核对')
  return runAdsParity(deps, { tenantId: row.tenantId, adsProfileId: payload.adsProfileId }, { reporting: new AdsReportingV1(client, profile.adsAccountId), today })
}
