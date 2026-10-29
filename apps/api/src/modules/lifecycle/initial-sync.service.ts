import { Injectable } from '@nestjs/common'
import { BACKFILL_SEGMENT_DAYS, planBackfillSegments, type BackfillSegment } from '@nova/api-contracts'
import { PRIORITY, syncSourceKey } from '@nova/workflow'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'

export interface InitialSyncScope {
  domains: Array<'ORDERS' | 'INVENTORY' | 'FINANCE' | 'ADS'>
  backfillDays: number
}

export interface InitialSyncPlanItem {
  connectionId: string
  type: string
  segment?: BackfillSegment
  adsProfileId?: string
  reportType?: string
}

/** 广告历史回补的报表类型：活动日报与搜索词，与广告报表导入器支持的类型一致 */
const ADS_BACKFILL_REPORTS = ['spCampaigns', 'spSearchTerm'] as const

/**
 * 首次同步的历史回补计划（12.7 第 5 条，纯函数，便于测试）：
 * 财务按每段最多 180 天、订单每段 90 天、广告报表每段最多 120 天切段；库存是当前快照，只有一次。
 * 每个分段一个独立任务：可单独重试、进度在同步中心逐段可见；最近的分段最先执行（同优先级下按入队顺序）。
 */
export function planInitialSync(now: Date, scope: InitialSyncScope, inputs: { spConnectionIds: string[]; adsConnectionId: string | null; adsProfiles: Array<{ id: string }> }): InitialSyncPlanItem[] {
  const plan: InitialSyncPlanItem[] = []
  for (const connectionId of inputs.spConnectionIds) {
    if (scope.domains.includes('INVENTORY')) plan.push({ connectionId, type: 'FBA_INVENTORY' })
    if (scope.domains.includes('ORDERS')) for (const segment of planBackfillSegments(now, scope.backfillDays, BACKFILL_SEGMENT_DAYS.ORDERS)) plan.push({ connectionId, type: 'FBA_ORDERS', segment })
    if (scope.domains.includes('FINANCE')) for (const segment of planBackfillSegments(now, scope.backfillDays, BACKFILL_SEGMENT_DAYS.FINANCE)) plan.push({ connectionId, type: 'FBA_FINANCE', segment })
  }
  if (scope.domains.includes('ADS') && inputs.adsConnectionId) {
    const segments = planBackfillSegments(now, scope.backfillDays, BACKFILL_SEGMENT_DAYS.ADS)
    for (const profile of inputs.adsProfiles)
      for (const reportType of ADS_BACKFILL_REPORTS)
        for (const segment of segments) plan.push({ connectionId: inputs.adsConnectionId, type: 'ADS_REPORT_CREATE', segment, adsProfileId: profile.id, reportType })
  }
  return plan
}

// 向导完成后触发首次同步：把计划里的每一项建成同步任务并入队（最低优先级，不挤占日常增量）。
// 已存在同一来源（同连接、同类型、同分段）的排队或运行中任务时跳过，重复触发不会重复建任务。
@Injectable()
export class InitialSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async start(tenantId: string, requestId: string, scope: InitialSyncScope) {
    const [spConnections, adsConnection, adsProfiles] = await Promise.all([
      this.prisma.platformConnection.findMany({ where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', sellerAccountId: { not: null } }, select: { id: true } }),
      this.prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' }, select: { id: true } }),
      this.prisma.adsProfile.findMany({ where: { tenantId, sellerAccountId: { not: null } }, select: { id: true } }),
    ])
    const plan = planInitialSync(new Date(), scope, { spConnectionIds: spConnections.map(item => item.id), adsConnectionId: adsConnection?.id ?? null, adsProfiles })
    let created = 0
    for (const item of plan) if (await this.enqueue(tenantId, requestId, item)) created += 1
    return { planned: plan.length, created }
  }

  private async enqueue(tenantId: string, requestId: string, item: InitialSyncPlanItem): Promise<boolean> {
    const keyParts = [item.segment?.from, item.segment?.to, item.adsProfileId, item.reportType]
    const sourceKey = syncSourceKey(item.connectionId, item.type, ...keyParts)
    const active = await this.prisma.syncJob.findFirst({ where: { tenantId, sourceKey, status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true } })
    if (active) return false
    const window = item.segment ? { after: item.segment.from, before: item.segment.to } : undefined
    let reportJobId: string | undefined
    if (item.type === 'ADS_REPORT_CREATE' && item.adsProfileId && item.reportType && item.segment) {
      const report = await this.prisma.adsReportJob.create({
        data: { tenantId, adsProfileId: item.adsProfileId, reportType: item.reportType, fromDate: new Date(item.segment.from), toDate: new Date(item.segment.to), status: 'PENDING', requestId },
      })
      reportJobId = report.id
    }
    const job = await this.prisma.syncJob.create({
      data: {
        tenantId,
        connectionId: item.connectionId,
        type: item.type,
        status: 'PENDING',
        requestId,
        context: { backfill: true, ...(window ? { window } : {}), ...(reportJobId ? { reportJobId, reportType: item.reportType } : {}) },
        ...syncJobMeta(item.connectionId, item.type, keyParts, PRIORITY.BACKFILL),
      },
    })
    await this.queue.add(
      'sync',
      { tenantId, syncJobId: job.id, requestId, marketplaceId: 'ATVPDKIKX0DER', ...(window ? { window } : {}), ...(reportJobId ? { reportJobId, reportType: item.reportType } : {}) },
      job.id,
      {
        type: item.type,
        priority: PRIORITY.BACKFILL,
      },
    )
    return true
  }
}
