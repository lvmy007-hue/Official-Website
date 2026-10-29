import { Injectable } from '@nestjs/common'
import {
  EXCEPTION_CATEGORIES,
  EXCEPTION_CATEGORY_LABEL,
  SETTLEMENT_CATEGORIES,
  SETTLEMENT_CATEGORY_LABEL,
  SETTLEMENT_FRESHNESS_KEYS,
  SETTLEMENT_PENDING_LABEL,
  SETTLEMENT_READ,
  SETTLEMENT_STATUS_LABEL,
  SETTLEMENT_TOLERANCE,
  type SettlementBreakdownRow,
  type SettlementCategory,
  type SettlementCheck,
  type SettlementDisbursementsResponse,
  type SettlementReconciliationResponse,
  type SettlementSummaryResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { findSettlement, num, openExceptionCounts, pendingReasonOf, settlementRow, totalsOf } from './settlements-common'

const BREAKDOWN_LIMIT = 300

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const numberOf = (value: unknown) => (typeof value === 'number' ? value : null)
const CHECK_KEYS = ['REPORT_SELF', 'REPORT_VS_API', 'ORDERS']
const CHECK_STATES = ['PASS', 'FAIL', 'SKIPPED']

/** 核对结果里保存的检查项：只认认得的键与状态，其余丢弃。 */
function checksOf(value: unknown): SettlementCheck[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const check = record(item)
    return CHECK_KEYS.includes(String(check.key)) && CHECK_STATES.includes(String(check.state)) && typeof check.label === 'string' && typeof check.detail === 'string'
      ? [{ key: check.key as SettlementCheck['key'], label: check.label, state: check.state as SettlementCheck['state'], detail: check.detail }]
      : []
  })
}

// 结算单详情的三个只读部分（07 章 7.7）：汇总（按类别与科目）、三方核对结果、打款记录。
@Injectable()
export class SettlementsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async summary(req: RequestWithContext, id: string): Promise<SettlementSummaryResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SETTLEMENT_READ, {})
    const tenantId = context.tenantId
    const row = await findSettlement(this.prisma, tenantId, scope, id)
    const [counts, freshness] = await Promise.all([openExceptionCounts(this.prisma, tenantId, [row]), sourceFreshness(this.prisma, tenantId, scope, SETTLEMENT_FRESHNESS_KEYS)])
    const settlement = settlementRow(row, row.reconciliation ? (counts.get(row.reconciliation.id) ?? 0) : 0)
    const hasReport = row.txnCount > 0
    if (!hasReport) return { settlement, hasReport, note: SETTLEMENT_PENDING_LABEL.NO_REPORT, categories: [], breakdown: [], breakdownTruncated: false, freshness }

    const groups = await this.prisma.settlementLine.groupBy({
      by: ['category', 'amountType', 'amountDescription'],
      where: { tenantId, settlementId: row.id },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: [{ category: 'asc' }, { amountType: 'asc' }, { amountDescription: 'asc' }],
      take: BREAKDOWN_LIMIT + 1,
    })
    const breakdown: SettlementBreakdownRow[] = groups.slice(0, BREAKDOWN_LIMIT).map(group => {
      const category = (SETTLEMENT_CATEGORIES as readonly string[]).includes(group.category) ? (group.category as SettlementCategory) : 'ADJUSTMENT'
      return {
        category,
        categoryLabel: SETTLEMENT_CATEGORY_LABEL[category],
        amountType: group.amountType,
        amountDescription: group.amountDescription,
        count: group._count._all,
        amount: num(group._sum.amount) ?? 0,
      }
    })
    const totals = totalsOf(row.summaryJson)
    return {
      settlement,
      hasReport,
      note: null,
      categories: totals ? SETTLEMENT_CATEGORIES.map(category => ({ category, label: SETTLEMENT_CATEGORY_LABEL[category], amount: totals[category] })) : [],
      breakdown,
      breakdownTruncated: groups.length > BREAKDOWN_LIMIT,
      freshness,
    }
  }

  async reconciliation(req: RequestWithContext, id: string): Promise<SettlementReconciliationResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SETTLEMENT_READ, {})
    const tenantId = context.tenantId
    const row = await findSettlement(this.prisma, tenantId, scope, id)
    const [saved, freshness] = await Promise.all([
      this.prisma.reconciliation.findFirst({
        where: { tenantId, settlementId: row.id },
        select: { id: true, status: true, pendingReason: true, computedAt: true, officialAmount: true, systemAmount: true, diffAmount: true, detailJson: true },
      }),
      sourceFreshness(this.prisma, tenantId, scope, SETTLEMENT_FRESHNESS_KEYS),
    ])
    const status = saved && saved.status in SETTLEMENT_STATUS_LABEL ? (saved.status as keyof typeof SETTLEMENT_STATUS_LABEL) : settlementRow(row, 0).status
    const pendingReason =
      status === 'PENDING' ? pendingReasonOf({ reconciliationStatus: 'PENDING', txnCount: row.txnCount, reconciliation: saved ? { id: saved.id, pendingReason: saved.pendingReason } : null }) : null
    const base = {
      settlementId: row.id,
      status,
      statusLabel: SETTLEMENT_STATUS_LABEL[status],
      pendingReason,
      pendingNote: pendingReason ? SETTLEMENT_PENDING_LABEL[pendingReason] : null,
      currency: row.currency,
      tolerance: SETTLEMENT_TOLERANCE,
      freshness,
    }
    if (!saved) {
      // 还没有核对结果：没有结算周期（无法界定哪些交易属于它）或后台还没算过
      return {
        ...base,
        computedAt: null,
        officialAmount: null,
        systemAmount: null,
        diffAmount: null,
        report: null,
        api: null,
        orders: null,
        checks: [],
        exceptions: [],
        openExceptions: 0,
        exceptionsTruncated: false,
      }
    }
    const detail = record(saved.detailJson)
    const groups = await this.prisma.reconciliationException.groupBy({
      by: ['category'],
      where: { tenantId, reconciliationId: saved.id, status: 'OPEN' },
      _count: { _all: true },
      _sum: { absAmount: true },
    })
    const exceptions = EXCEPTION_CATEGORIES.flatMap(category => {
      const group = groups.find(item => item.category === category)
      return group ? [{ category, label: EXCEPTION_CATEGORY_LABEL[category], count: group._count._all, amount: num(group._sum.absAmount) ?? 0 }] : []
    })
    const pick = <T extends Record<string, number | null>>(value: unknown, keys: Array<keyof T>): T | null => {
      const source = record(value)
      if (Object.keys(source).length === 0) return null
      return Object.fromEntries(keys.map(key => [key, numberOf(source[key as string])])) as T
    }
    const report = pick<{ lineCount: number; comparedTotal: number; headerTotal: number | null; selfDiff: number | null; orderCount: number }>(detail.report, [
      'lineCount',
      'comparedTotal',
      'headerTotal',
      'selfDiff',
      'orderCount',
    ])
    const api = pick<{ transactionCount: number; total: number; orderCount: number; otherCurrencyCount: number }>(detail.api, ['transactionCount', 'total', 'orderCount', 'otherCurrencyCount'])
    const orders = pick<{ reportOrders: number; found: number; missing: number }>(detail.orders, ['reportOrders', 'found', 'missing'])
    const pending = status === 'PENDING'
    return {
      ...base,
      computedAt: saved.computedAt.toISOString(),
      // 待核对时两边金额不可比（一边缺数据），不显示，免得把“没有数据”显示成 0
      officialAmount: pending ? null : num(saved.officialAmount),
      systemAmount: pending ? null : num(saved.systemAmount),
      diffAmount: pending ? null : num(saved.diffAmount),
      report: report as SettlementReconciliationResponse['report'],
      api: api as SettlementReconciliationResponse['api'],
      orders: orders as SettlementReconciliationResponse['orders'],
      checks: checksOf(detail.checks),
      exceptions,
      openExceptions: exceptions.reduce((sum, item) => sum + item.count, 0),
      exceptionsTruncated: detail.truncated === true,
    }
  }

  async disbursements(req: RequestWithContext, id: string): Promise<SettlementDisbursementsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SETTLEMENT_READ, {})
    const row = await findSettlement(this.prisma, context.tenantId, scope, id)
    const total = num(row.totalAmount)
    const amount = num(row.disbursementAmount)
    const note =
      amount !== null
        ? '以结算报告汇总行的打款总额与打款日期为准'
        : total !== null && total <= 0
          ? '结算报告汇总金额不为正，本期没有打款'
          : row.txnCount === 0
            ? '结算报告尚未到达，打款信息要等报告到达后才有'
            : '结算报告里还没有打款日期'
    // 财务在回款页登记的到账（P2b-08）：一张结算单最多一条
    const registered = await this.prisma.disbursement.findFirst({
      where: { tenantId: context.tenantId, settlementId: row.id },
      select: { disbursedAt: true, amount: true, currency: true, bankLast4: true, note: true },
    })
    const items: SettlementDisbursementsResponse['items'] = [{ source: 'REPORT', sourceLabel: '结算报告', date: row.depositDate?.toISOString() ?? null, amount, currency: row.currency, note }]
    if (registered) {
      const bank = registered.bankLast4 ? `收款账户末四位 ${registered.bankLast4}` : null
      items.push({
        source: 'MANUAL',
        sourceLabel: '手工登记到账',
        date: registered.disbursedAt.toISOString(),
        amount: num(registered.amount),
        currency: registered.currency,
        note: [bank, registered.note].filter(Boolean).join('；') || '财务登记的到账',
      })
    }
    return {
      items,
      manual: {
        available: amount !== null && amount > 0,
        note: registered ? '已登记到账；核对结果与改正请到“回款与现金流”页的到账核对' : amount !== null && amount > 0 ? '尚未登记到账，请到“回款与现金流”页登记' : '这张结算单没有可登记的打款金额',
      },
    }
  }
}
