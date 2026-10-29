import { Injectable } from '@nestjs/common'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'

// 新旧接口并行核对报告（P1-26）：只读。核对由后台任务在每次订单、财务同步之后按天运行，这里只负责把结果交给前端。
// 受限成员只看得到数据范围内店铺的通道与核对记录；核对差异里只有订单号与金额，不含买家信息。

const DOMAINS = ['ORDERS', 'FINANCE'] as const
const CATEGORIES = ['TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED'] as const
const RUN_LIMIT = 30
const DIFF_LIMIT = 200

type Domain = (typeof DOMAINS)[number]
type Category = (typeof CATEGORIES)[number]

const pick = <T extends string>(allowed: readonly T[], value: string | undefined, name: string): T | undefined => {
  if (!value) return undefined
  if (!(allowed as readonly string[]).includes(value)) throw new AppError(422, 'VALIDATION_FAILED', `${name} 的取值不合法`)
  return value as T
}

@Injectable()
export class ParityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /**
   * 通道状态（旧通道是否仍在对照、连续通过次数）与最近的核对记录；带 runId 时附上该次核对的差异明细（未解释优先）与各类计数。
   */
  async report(req: RequestWithContext, query: Record<string, string>) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.read', {})
    const domain: Domain | undefined = pick(DOMAINS, query.domain, 'domain')
    const category: Category | undefined = pick(CATEGORIES, query.category, 'category')
    const where = { tenantId: context.tenantId, ...storeWhere(scope), ...(domain ? { domain } : {}) }

    const [channels, runs] = await Promise.all([
      this.prisma.connectorChannelState.findMany({ where, orderBy: [{ sellerAccountId: 'asc' }, { domain: 'asc' }], include: { sellerAccount: { select: { displayName: true } } } }),
      this.prisma.connectorParityRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: RUN_LIMIT }),
    ])
    const view = {
      channels: channels.map(channel => ({
        sellerAccountId: channel.sellerAccountId,
        storeName: channel.sellerAccount.displayName,
        domain: channel.domain,
        legacyEnabled: channel.legacyEnabled,
        consecutivePasses: channel.consecutivePasses,
        requiredPasses: channel.requiredPasses,
        lastRunAt: channel.lastRunAt,
        closedAt: channel.closedAt,
        closedReason: channel.closedReason,
      })),
      runs: runs.map(run => ({
        id: run.id,
        sellerAccountId: run.sellerAccountId,
        domain: run.domain,
        windowStart: run.windowStart,
        windowEnd: run.windowEnd,
        legacyCount: run.legacyCount,
        newCount: run.newCount,
        matchedCount: run.matchedCount,
        unexplainedCount: run.unexplainedCount,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
    }
    if (!query.runId) return view

    const run = await this.prisma.connectorParityRun.findFirst({ where: { ...where, id: query.runId }, select: { id: true } })
    if (!run) throw new AppError(404, 'RESOURCE_NOT_FOUND', '核对记录不存在或无权访问')
    const [diffs, grouped] = await Promise.all([
      this.prisma.connectorParityDiff.findMany({
        where: { tenantId: context.tenantId, runId: run.id, ...(category ? { category } : {}) },
        orderBy: [{ category: 'asc' }, { entityKey: 'asc' }],
        take: DIFF_LIMIT,
      }),
      this.prisma.connectorParityDiff.groupBy({ by: ['category'], where: { tenantId: context.tenantId, runId: run.id }, _count: { _all: true } }),
    ])
    const counts: Record<Category, number> = { TIME_BASIS: 0, ATTRIBUTION_BASIS: 0, SCOPE: 0, UNEXPLAINED: 0 }
    for (const row of grouped) counts[row.category as Category] = row._count._all
    return {
      ...view,
      diffs: diffs.map(diff => ({ category: diff.category, entityKey: diff.entityKey, field: diff.field, legacyValue: diff.legacyValue, newValue: diff.newValue, explanation: diff.explanation })),
      diffCounts: counts,
      diffsTruncated: Object.values(counts).reduce((sum, value) => sum + value, 0) > diffs.length && !category,
    }
  }
}
