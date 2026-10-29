import { Injectable } from '@nestjs/common'
import { ScopeSearchSchema } from '@nova/api-contracts'
import type { ApiContext } from '../../platform/http'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, type ResolvedScope } from '../auth'
import { todayIn, validZone, zonedDayStart } from '../overview'

// 今日实时各接口的共同入口：校验 overview.read、解析店铺范围与企业时区“今天”。
// 推送是否接入：看部署专项环境变量 AMAZON_NOTIFICATION_DESTINATION_ID（与订阅管理同一判定）。

export const pushDestinationConfigured = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.AMAZON_NOTIFICATION_DESTINATION_ID?.trim())

export interface TodayRequest {
  context: ApiContext
  scope: ResolvedScope
  timeZone: string
  businessDate: string
  dayStart: Date
  dayEndExclusive: Date
  now: Date
  pushConnected: boolean
  storeIds: string[]
  query: Record<string, string>
}

@Injectable()
export class TodayContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async prepare(req: RequestWithContext, query: Record<string, string>, now = new Date()): Promise<TodayRequest> {
    const { context, scope } = await this.context.authorizeScoped(req, 'overview.read', query)
    ScopeSearchSchema.parse(query)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const timeZone = validZone(tenant?.timezone)
    const businessDate = todayIn(timeZone, now)
    const dayStart = zonedDayStart(businessDate, timeZone)
    const next = new Date(dayStart.getTime() + 86_400_000)
    const stores = await this.prisma.sellerAccount.findMany({
      where: { tenantId: context.tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
      select: { id: true },
      take: 500,
    })
    return {
      context,
      scope,
      timeZone,
      businessDate,
      dayStart,
      dayEndExclusive: next,
      now,
      pushConnected: pushDestinationConfigured(),
      storeIds: stores.map(s => s.id),
      query,
    }
  }
}
