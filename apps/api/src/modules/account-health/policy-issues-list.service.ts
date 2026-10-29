import { Injectable } from '@nestjs/common'
import {
  ACCOUNT_HEALTH_LIMITS,
  ACCOUNT_HEALTH_READ,
  ACCOUNT_HEALTH_ROLE_GUIDE,
  PolicyIssueListQuerySchema,
  SELLER_PERFORMANCE_FRESHNESS_KEY,
  type PolicyIssueListResponse,
  type PolicyIssueRow,
  type PolicyIssueStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { ISSUE_SELECT, decodeOffset, issueRow, pageOf, reportSyncByStore, storesOf, worstSync } from './account-health-common'

const NOTE_NO_STORE = '还没有接入亚马逊店铺；接入店铺并同步后，才能看到政策合规问题'
const NOTE_NONE = '目前没有政策合规问题记录（来自每日同步的账户健康报告；报告里没有问题条目就不会有记录）'
const NOTE_FILTERED = '没有符合筛选条件的问题；可以放宽筛选条件'

/** 政策合规问题列表（09 章 9.2）：默认未解决在前；负责人与处理状态是人工处理信息，同步不覆盖。 */
@Injectable()
export class PolicyIssuesListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<PolicyIssueListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ACCOUNT_HEALTH_READ, rawQuery)
    const query = PolicyIssueListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const stores = await storesOf(this.prisma, tenantId, scope)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const limit = ACCOUNT_HEALTH_LIMITS.readRows
    const base: Prisma.PolicyIssueWhereInput = { tenantId, ...storeWhere(scope) }
    const where: Prisma.PolicyIssueWhereInput = {
      ...base,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.handlingStatus ? { handlingStatus: query.handlingStatus } : {}),
      ...(query.ownerId ? { ownerUserId: query.ownerId } : {}),
    }
    const dir = query.sort.dir === 'asc' ? ('asc' as const) : ('desc' as const)
    const order: Prisma.PolicyIssueOrderByWithRelationInput = query.sort.field === 'lastSeenAt' ? { lastSeenAt: dir } : { firstSeenAt: dir }
    const [rows, countRows, sync, freshness] = await Promise.all([
      this.prisma.policyIssue.findMany({
        where,
        select: ISSUE_SELECT,
        orderBy: [{ status: 'asc' }, order, { id: 'asc' }],
        take: limit + 1,
      }),
      this.prisma.policyIssue.groupBy({ by: ['status'], where: base, _count: { _all: true }, orderBy: { status: 'asc' }, take: 10 }),
      reportSyncByStore(
        this.prisma,
        tenantId,
        stores.map(store => store.id),
        now,
      ),
      sourceFreshness(this.prisma, tenantId, scope, [SELLER_PERFORMANCE_FRESHNESS_KEY], now),
    ])
    const truncated = rows.length > limit
    const owners = await memberNames(
      this.prisma,
      tenantId,
      rows.slice(0, limit).map(row => row.ownerUserId),
    )
    const keyword = query.q?.toLowerCase()
    const items: PolicyIssueRow[] = rows
      .slice(0, limit)
      .map(row => issueRow(row, names.get(row.sellerAccountId) ?? '', row.ownerUserId ? (owners.get(row.ownerUserId) ?? null) : null))
      .filter(row => !keyword || [row.title, row.issueId, row.storeName, row.impactText ?? '', ...row.asins].some(text => text.toLowerCase().includes(keyword)))
    const { page, pageInfo } = pageOf(items, offset, query.pageSize, binding)
    const counts: Record<PolicyIssueStatus, number> = { OPEN: 0, RESOLVED: 0 }
    for (const row of countRows) if (row.status === 'OPEN' || row.status === 'RESOLVED') counts[row.status] = row._count._all
    const merged = worstSync(stores.map(store => sync.byStore.get(store.id)).flatMap(item => (item ? [item] : [])))
    let state: PolicyIssueListResponse['state'] = 'OK'
    let note: string | null = null
    if (stores.length === 0) {
      state = 'NOT_CONNECTED'
      note = NOTE_NO_STORE
    } else if (items.length === 0) {
      const unfiltered = !query.q && !query.status && !query.kind && !query.handlingStatus && !query.ownerId
      state = unfiltered && merged.rolePending ? 'ROLE_PENDING' : 'NO_DATA'
      note = !unfiltered ? NOTE_FILTERED : merged.rolePending ? ACCOUNT_HEALTH_ROLE_GUIDE : NOTE_NONE
    }
    return { state, note, items: page, pageInfo, counts, sync: merged, freshness, truncated }
  }
}
