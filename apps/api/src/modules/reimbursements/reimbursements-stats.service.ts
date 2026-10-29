import { Injectable } from '@nestjs/common'
import {
  CASE_STATUSES,
  OPPORTUNITY_RULES,
  REIMBURSEMENTS_READ,
  STATS_BASIS,
  ScopeQuerySchema,
  averagePayDays,
  emptyCaseCounts,
  isRuleConnected,
  recoveryByCurrency,
  resolveWindows,
  RULE_BASIS,
  ruleStats,
  type CaseStatus,
  type OpportunityRule,
  type ReimbursementStatsResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { SettingsService } from '../settings'
import { REIMBURSEMENT_FRESHNESS_KEYS } from './reimbursements-common'

// 数据库层单次查询上限是 20000 行，多取 1 行判断是否超限，所以统计上限是 19999 个案件
const CASE_LIMIT = 19_999
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

// 赔付统计（07 章 7.3）：案件数、回收率（按币种）、平均到账时长、各类机会的成功率、未归属赔付、时限设置。
// 范围是成员数据范围内的全部案件（不按日期筛），读取超过上限时不计算（页面提示缩小店铺范围），不拿不完整的数当结论。
@Injectable()
export class ReimbursementsStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly settings: SettingsService,
  ) {}

  async stats(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReimbursementStatsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_READ, rawQuery)
    ScopeQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const store = storeWhere(scope)
    const [cases, pending, unmatched, freshness, windows] = await Promise.all([
      this.prisma.reimbursementCase.findMany({
        where: { tenantId, ...store },
        select: { id: true, status: true, ruleCode: true, currency: true, expectedAmount: true, receivedAmount: true, submittedAt: true },
        take: CASE_LIMIT + 1,
      }),
      this.prisma.reimbursementOpportunity.groupBy({ by: ['ruleCode'], where: { tenantId, ...store, status: 'PENDING' }, _count: { _all: true } }),
      this.prisma.reimbursementRecord.groupBy({ by: ['currency'], where: { tenantId, ...store, matchedCaseId: null }, _count: { _all: true }, _sum: { amount: true } }),
      sourceFreshness(this.prisma, tenantId, scope, REIMBURSEMENT_FRESHNESS_KEYS),
      this.settings.get(tenantId, 'reimbursement.windows'),
    ])
    const pendingByRule: Partial<Record<OpportunityRule, number>> = {}
    for (const row of pending) if ((OPPORTUNITY_RULES as readonly string[]).includes(row.ruleCode)) pendingByRule[row.ruleCode as OpportunityRule] = row._count._all
    const pendingOpportunities = Object.values(pendingByRule).reduce((sum, count) => sum + count, 0)
    const base = {
      pendingOpportunities,
      unmatched: {
        count: unmatched.reduce((sum, row) => sum + row._count._all, 0),
        byCurrency: unmatched.map(row => ({ currency: row.currency, amount: num(row._sum.amount) ?? 0 })).sort((a, b) => a.currency.localeCompare(b.currency)),
      },
      windows: resolveWindows(windows.value),
      windowsDefault: windows.version === 0,
      windowsVersion: windows.version,
      basis: STATS_BASIS,
      freshness,
    }
    const caseCounts = emptyCaseCounts()
    if (cases.length > CASE_LIMIT) {
      return {
        ...base,
        state: 'NO_DATA',
        note: '案件超过 2 万个，统计未计算；请缩小店铺范围后再看',
        caseCounts,
        recovery: [],
        avgPayDays: null,
        paidSample: 0,
        rules: ruleStats([], pendingByRule, isRuleConnected, RULE_BASIS),
      }
    }
    for (const item of cases) if ((CASE_STATUSES as readonly string[]).includes(item.status)) caseCounts[item.status as CaseStatus] += 1
    const paidIds = cases.filter(item => num(item.receivedAmount)! > 0).map(item => item.id)
    const firstPaid = paidIds.length
      ? await this.prisma.reimbursementRecord.groupBy({ by: ['matchedCaseId'], where: { tenantId, matchedCaseId: { in: paidIds }, amount: { gt: 0 } }, _min: { approvedAt: true } })
      : []
    const firstPaidAt = new Map(firstPaid.flatMap(row => (row.matchedCaseId && row._min.approvedAt ? [[row.matchedCaseId, row._min.approvedAt] as const] : [])))
    const stat = cases.map(item => ({
      status: item.status as CaseStatus,
      ruleCode: item.ruleCode as OpportunityRule,
      currency: item.currency,
      expectedAmount: num(item.expectedAmount),
      receivedAmount: num(item.receivedAmount) ?? 0,
      submittedAt: item.submittedAt,
      firstPaidAt: firstPaidAt.get(item.id) ?? null,
    }))
    const pay = averagePayDays(stat)
    const hasAny = cases.length > 0 || pendingOpportunities > 0 || base.unmatched.count > 0
    return {
      ...base,
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : '尚无赔付机会、案件与官方赔付明细；店铺授权并完成数据同步后每 3 小时扫描一次',
      caseCounts,
      recovery: recoveryByCurrency(stat),
      avgPayDays: pay.days,
      paidSample: pay.sample,
      rules: ruleStats(stat, pendingByRule, isRuleConnected, RULE_BASIS),
    }
  }
}
