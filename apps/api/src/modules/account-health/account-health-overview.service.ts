import { Injectable } from '@nestjs/common'
import {
  ACCOUNT_HEALTH_BASIS,
  ACCOUNT_HEALTH_LIMITS,
  ACCOUNT_HEALTH_READ,
  ACCOUNT_PUSH_NOT_CONNECTED_NOTE,
  ACCOUNT_RATING_METRIC_KEY,
  ACCOUNT_STATUS_FRESHNESS_KEY,
  ACCOUNT_STATUS_METRIC_KEY,
  ODR_BREAKDOWN_NOTE,
  SELLER_PERFORMANCE_FRESHNESS_KEY,
  ScopeSearchSchema,
  type AccountHealthResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { addDays, todayIn, validZone } from '../overview'
import { asDay, reportSyncByStore, storesOf, ymd } from './account-health-common'
import { buildStoreView, type SnapshotRecord } from './account-health-view'

const SNAPSHOT_SELECT = {
  snapshotDate: true,
  metricKey: true,
  metricGroup: true,
  accountStatus: true,
  status: true,
  value: true,
  target: true,
  targetCondition: true,
  unit: true,
  windowDays: true,
  detailJson: true,
  source: true,
} as const

/**
 * 账户健康总览（09 章 9.2）：每个店铺一块——账户状态与变更历史、账户健康评级与趋势、订单缺陷率与构成、政策合规、其他指标。
 * 取数分三步，避免店铺多时超出单次读取上限：历史（状态、评级、订单缺陷率近 90 天）、每个店铺最近一份快照日期、该日期的全部指标。
 * 报告没给的指标没有行，页面显示“尚无记录”，不补 0；认不出的指标进“其他指标”，用报告原名显示。
 */
@Injectable()
export class AccountHealthOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async overview(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<AccountHealthResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ACCOUNT_HEALTH_READ, rawQuery)
    ScopeSearchSchema.parse(rawQuery)
    const tenantId = context.tenantId
    const stores = await storesOf(this.prisma, tenantId, scope)
    const storeIds = stores.map(store => store.id)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    const since = asDay(addDays(today, -ACCOUNT_HEALTH_LIMITS.trendDays))
    const limit = ACCOUNT_HEALTH_LIMITS.readRows

    const [history, latestDates, issues, sync, connections, freshness] = await Promise.all([
      storeIds.length === 0
        ? []
        : this.prisma.accountHealthSnapshot.findMany({
            where: {
              tenantId,
              sellerAccountId: { in: storeIds },
              snapshotDate: { gte: since },
              OR: [{ metricKey: { in: [ACCOUNT_STATUS_METRIC_KEY, ACCOUNT_RATING_METRIC_KEY] } }, { metricKey: { startsWith: 'orderDefectRate', mode: 'insensitive' } }],
            },
            select: { sellerAccountId: true, ...SNAPSHOT_SELECT },
            orderBy: [{ snapshotDate: 'desc' }, { sellerAccountId: 'asc' }, { metricKey: 'asc' }],
            take: limit + 1,
          }),
      storeIds.length === 0
        ? []
        : this.prisma.accountHealthSnapshot.groupBy({
            by: ['sellerAccountId'],
            where: { tenantId, sellerAccountId: { in: storeIds } },
            _max: { snapshotDate: true },
            orderBy: { sellerAccountId: 'asc' },
            take: 500,
          }),
      storeIds.length === 0
        ? []
        : this.prisma.policyIssue.groupBy({
            by: ['sellerAccountId', 'kind'],
            where: { tenantId, sellerAccountId: { in: storeIds }, status: 'OPEN' },
            _count: { _all: true },
            orderBy: [{ sellerAccountId: 'asc' }, { kind: 'asc' }],
            take: 5000,
          }),
      reportSyncByStore(this.prisma, tenantId, storeIds, now),
      storeIds.length === 0
        ? []
        : this.prisma.platformConnection.findMany({
            where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', sellerAccountId: { in: storeIds } },
            select: { sellerAccountId: true },
            take: 1000,
          }),
      sourceFreshness(this.prisma, tenantId, scope, [SELLER_PERFORMANCE_FRESHNESS_KEY, ACCOUNT_STATUS_FRESHNESS_KEY], now),
    ])

    const latestByStore = new Map(latestDates.flatMap(row => (row._max.snapshotDate ? [[row.sellerAccountId, row._max.snapshotDate] as const] : [])))
    const latestRows =
      latestByStore.size === 0
        ? []
        : await this.prisma.accountHealthSnapshot.findMany({
            where: { tenantId, OR: [...latestByStore].map(([sellerAccountId, snapshotDate]) => ({ sellerAccountId, snapshotDate })) },
            select: { sellerAccountId: true, ...SNAPSHOT_SELECT },
            orderBy: [{ sellerAccountId: 'asc' }, { metricKey: 'asc' }],
            take: limit + 1,
          })
    const truncated = history.length > limit || latestRows.length > limit
    const connected = new Set(connections.map(row => row.sellerAccountId))
    const group = <T extends { sellerAccountId: string }>(rows: readonly T[]) => {
      const map = new Map<string, T[]>()
      for (const row of rows.slice(0, limit)) map.set(row.sellerAccountId, [...(map.get(row.sellerAccountId) ?? []), row])
      return map
    }
    const historyBy = group(history)
    const latestBy = group(latestRows)
    const views = stores.map(store =>
      buildStoreView({
        store,
        connected: connected.has(store.id),
        sync: sync.byStore.get(store.id) as NonNullable<ReturnType<typeof sync.byStore.get>>,
        history: (historyBy.get(store.id) ?? []) as SnapshotRecord[],
        latest: (latestBy.get(store.id) ?? []) as SnapshotRecord[],
        latestDate: latestByStore.has(store.id) ? ymd(latestByStore.get(store.id) as Date) : null,
        openByKind: issues.filter(row => row.sellerAccountId === store.id).map(row => ({ kind: row.kind, count: row._count._all })),
      }),
    )
    return {
      stores: views,
      push: sync.pushLastAt ? { state: 'OK', note: null } : { state: 'NOT_CONNECTED', note: ACCOUNT_PUSH_NOT_CONNECTED_NOTE },
      truncated,
      freshness,
      basis: `${ACCOUNT_HEALTH_BASIS}${ODR_BREAKDOWN_NOTE}`,
    }
  }
}
