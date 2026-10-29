import { Injectable } from '@nestjs/common'
import {
  CASHFLOW_FRESHNESS_KEYS,
  CASHFLOW_READ,
  CashflowQuerySchema,
  FUNNEL_ASSUMPTIONS,
  FUNNEL_RESERVE_DAYS,
  FUNNEL_RESERVE_KEYWORD,
  FUNNEL_WINDOW_DAYS,
  ScopeSearchSchema,
  addDaysText,
  buildFunnelStages,
  payoutRateOf,
  reserveSummary,
  roundCash,
  type CashflowFunnelResponse,
  type FunnelPayoutRate,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { localDate, todayIn, validZone, zonedDayStart } from '../overview'
import { baseWhere } from './cashflow-load'

const NO_DATA_NOTE = '尚无回款数据：店铺授权后，财务交易（每 6 小时同步）与结算报告（每天检索一次）同步到后显示漏斗'
/** 打款本身也记成一笔交易；预留金单独统计，都不算入“入账交易净额”。 */
const NOT_OPERATING: Prisma.FbaFinancialTransactionWhereInput[] = ['transfer', 'disbursement', 'payout', FUNNEL_RESERVE_KEYWORD].map(word => ({
  transactionType: { contains: word, mode: 'insensitive' },
}))
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : Number(value.toString()))

/**
 * 回款增强（P6-20）：最近 90 天的“入账 → 释放/递延 → 已公布打款 → 已到账/应收”漏斗、回款率与未退还预留金。
 * 只读；各币种分别汇总、不换算；没有数据来源的级别返回 null（页面写“尚未接入”），不显示成 0。
 */
@Injectable()
export class CashflowFunnelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async funnel(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<CashflowFunnelResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, CASHFLOW_READ, rawQuery)
    ScopeSearchSchema.parse(rawQuery)
    const query = CashflowQuerySchema.parse({ currency: rawQuery.currency })
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone, now)
    const from = addDaysText(today, -(FUNNEL_WINDOW_DAYS - 1))
    const where = baseWhere(tenantId, scope)
    const window = { gte: zonedDayStart(from, zone) }
    const reserveWindow = { gte: zonedDayStart(addDaysText(today, -(FUNNEL_RESERVE_DAYS - 1)), zone) }
    const mine = { ...where, currency: query.currency }
    const posted = (extra: Prisma.FbaFinancialTransactionWhereInput) =>
      this.prisma.fbaFinancialTransaction.aggregate({ where: { ...mine, postedAt: window, NOT: NOT_OPERATING, ...extra }, _sum: { amount: true }, _count: { _all: true } })

    const [allPosted, released, deferred, settlements, reserveRows, anyFinance, txCurrencies, settleCurrencies, freshness] = await Promise.all([
      posted({}),
      posted({ transactionStatus: { in: ['RELEASED', 'DEFERRED_RELEASED'] } }),
      posted({ transactionStatus: 'DEFERRED' }),
      this.prisma.fbaSettlement.findMany({
        where: { ...mine, settlementEndDate: { gte: zonedDayStart(from, zone) }, disbursementAmount: { not: null } },
        select: { depositDate: true, disbursementAmount: true },
        take: 2000,
      }),
      this.prisma.fbaFinancialTransaction.findMany({
        where: { ...mine, postedAt: reserveWindow, transactionType: { contains: FUNNEL_RESERVE_KEYWORD, mode: 'insensitive' } },
        select: { amount: true },
        take: 5000,
      }),
      this.prisma.fbaFinancialTransaction.count({ where: { ...where, postedAt: reserveWindow } }),
      this.prisma.fbaFinancialTransaction.groupBy({ by: ['currency'], where: { ...where, postedAt: reserveWindow }, orderBy: { currency: 'asc' } }),
      this.prisma.fbaSettlement.groupBy({ by: ['currency'], where, orderBy: { currency: 'asc' } }),
      sourceFreshness(this.prisma, tenantId, scope, CASHFLOW_FRESHNESS_KEYS, now),
    ])

    const part = (value: typeof allPosted) => (value._count._all > 0 ? { amount: num(value._sum.amount), count: value._count._all } : null)
    const announcedAmount = settlements.reduce((total, row) => total + num(row.disbursementAmount), 0)
    const paidRows = settlements.filter(row => row.depositDate !== null && localDate(row.depositDate, zone) <= today)
    const paidAmount = paidRows.reduce((total, row) => total + num(row.disbursementAmount), 0)
    const announced = settlements.length > 0 ? { amount: announcedAmount, count: settlements.length } : null
    const paid = announced ? { amount: paidAmount, count: paidRows.length } : null
    const postedPart = part(allPosted)
    const stages = buildFunnelStages({
      posted: postedPart,
      // 有入账交易时，释放与递延两级没有记录就是 0 笔（交易有状态），不是未接入
      released: postedPart ? (part(released) ?? { amount: 0, count: 0 }) : null,
      deferred: postedPart ? (part(deferred) ?? { amount: 0, count: 0 }) : null,
      announced,
      paid,
    })
    const rate = announced && paid ? payoutRateOf(paid.amount, announced.amount) : null
    const payoutRate: FunnelPayoutRate = {
      value: rate,
      paid: paid ? roundCash(paid.amount) : null,
      announced: announced ? roundCash(announced.amount) : null,
      note: announced ? '已到账的打款额 ÷ 已公布的打款额（同一批结算单，打款日已过的算已到账）' : '窗口内没有已公布打款额的结算单，不给回款率',
    }
    const currencies = [...new Set([query.currency, ...txCurrencies.map(row => row.currency), ...settleCurrencies.map(row => row.currency)])].sort()
    const hasAny = postedPart !== null || announced !== null || reserveRows.length > 0
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : NO_DATA_NOTE,
      asOf: today,
      from,
      to: today,
      windowDays: FUNNEL_WINDOW_DAYS,
      currency: query.currency,
      currencies,
      stages,
      payoutRate,
      reserve: reserveSummary(
        reserveRows.map(row => num(row.amount)),
        anyFinance > 0,
      ),
      assumptions: [...FUNNEL_ASSUMPTIONS],
      freshness,
    }
  }
}
