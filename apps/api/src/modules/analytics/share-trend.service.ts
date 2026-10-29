import { Injectable } from '@nestjs/common'
import {
  BRAND_ANALYTICS_READ,
  SHARE_TREND_DISCLAIMER,
  SHARE_TREND_PERIOD_LIMIT,
  SHARE_TREND_READ,
  SHARE_TREND_ROW_LIMIT,
  ShareTrendQuerySchema,
  aggregateShareTrend,
  type ShareTrendRaw,
  type ShareTrendResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'

// 周期开始是纯日期列，驱动按 UTC 零点返回；用本地时区取日会在西半球服务器上差一天。
const ymd = (date: Date) => date.toISOString().slice(0, 10)

/** 关键词份额趋势（P6-29）：搜索查询表现的展示份额与点击份额。没有品牌分析权限时 200 + RESTRICTED，不报 403。 */
@Injectable()
export class ShareTrendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async trend(req: Parameters<ContextService['authorizeScoped']>[0], rawQuery: Record<string, string>): Promise<ShareTrendResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SHARE_TREND_READ, rawQuery)
    const query = ShareTrendQuerySchema.parse(rawQuery)
    if (!hasPermission(context.permissions, BRAND_ANALYTICS_READ)) {
      return { asin: query.asin, state: 'RESTRICTED', message: '需要品牌分析权限才能查看搜索查询表现里的份额。', disclaimer: SHARE_TREND_DISCLAIMER, points: [], truncated: false }
    }
    const rows = await this.prisma.brandSearchQueryPerformance.findMany({
      where: { tenantId: context.tenantId, asin: query.asin, reportPeriod: 'WEEK', ...storeWhere(scope) },
      orderBy: [{ periodStart: 'desc' }, { impressionsOwn: 'desc' }],
      take: SHARE_TREND_ROW_LIMIT + 1,
      select: {
        periodStart: true,
        searchQuery: true,
        impressionsOwn: true,
        impressionsTotal: true,
        clicksOwn: true,
        clicksTotal: true,
        searchVolume: true,
      },
    })
    const truncatedRows = rows.length > SHARE_TREND_ROW_LIMIT
    const raw: ShareTrendRaw[] = rows.slice(0, SHARE_TREND_ROW_LIMIT).map(row => ({
      periodStart: ymd(row.periodStart),
      searchQuery: row.searchQuery,
      impressionsOwn: row.impressionsOwn,
      impressionsTotal: row.impressionsTotal,
      clicksOwn: row.clicksOwn,
      clicksTotal: row.clicksTotal,
      searchVolume: row.searchVolume,
    }))
    const aggregated = aggregateShareTrend(raw, SHARE_TREND_PERIOD_LIMIT)
    const truncated = truncatedRows || aggregated.truncated
    if (aggregated.points.length === 0) {
      return { asin: query.asin, state: 'NO_DATA', message: '尚无这个 ASIN 的搜索查询表现（周报）。', disclaimer: SHARE_TREND_DISCLAIMER, points: [], truncated: false }
    }
    return {
      asin: query.asin,
      state: truncated ? 'TRUNCATED' : 'OK',
      message: truncated ? `只保留最近 ${SHARE_TREND_PERIOD_LIMIT} 个周期。` : null,
      disclaimer: SHARE_TREND_DISCLAIMER,
      points: aggregated.points,
      truncated,
    }
  }
}
