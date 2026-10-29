import { Injectable } from '@nestjs/common'
import type { CashResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { OverviewContextService } from './overview-context.service'
import { addDays, asDate, dateText, todayIn, zonedDayStart } from './period'

const RELEASED = ['RELEASED', 'DEFERRED_RELEASED']
/** 余额快照只看最近这么多天，取每个店铺最近的一次 */
const BALANCE_LOOKBACK_DAYS = 45
const NEXT_PAYOUT_NOTE_NONE = '没有尚未到来的结算打款日。亚马逊在结算周期关闭后才公布打款日，这里不做推测'

// 经营控制台：现金视角（04 章 4.1 第 6 项）。需要 finance.read，没有该权限一律不返回金额。
// 全部来自财务接口：已释放 = 本期入账交易里状态为已释放的金额；递延中 = 最近一次递延余额快照；下次打款日 = 最早的未来结算打款日。
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly base: OverviewContextService,
  ) {}

  async cash(req: RequestWithContext, query: Record<string, string>): Promise<CashResponse> {
    const request = await this.base.prepare(req, query)
    const { period } = request.periods
    const empty: Omit<CashResponse, 'state' | 'note'> = { period, released: null, deferred: null, nextPayoutDate: null, nextPayoutNote: NEXT_PAYOUT_NOTE_NONE }
    if (!hasPermission(request.context.permissions, 'finance.read')) return { ...empty, state: 'RESTRICTED', note: '现金视角需要“财务查看”权限' }

    const { tenantId, scope } = request.ctx
    const where = { tenantId, ...storeWhere(scope) }
    const today = todayIn(request.timeZone)
    const [released, balances, next] = await Promise.all([
      this.prisma.fbaFinancialTransaction.aggregate({
        where: {
          ...where,
          transactionStatus: { in: RELEASED },
          currency: 'USD',
          postedAt: { gte: zonedDayStart(period.from, request.timeZone), lt: zonedDayStart(addDays(period.to, 1), request.timeZone) },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.accountBalanceSnapshot.findMany({
        where: { ...where, balanceType: 'DEFERRED', currency: 'USD', snapshotDate: { gte: asDate(addDays(today, -BALANCE_LOOKBACK_DAYS)) } },
        select: { sellerAccountId: true, snapshotDate: true, amount: true },
        orderBy: { snapshotDate: 'desc' },
        take: 5000,
      }),
      this.prisma.fbaSettlement.findFirst({ where: { ...where, depositDate: { gte: zonedDayStart(today, request.timeZone) } }, orderBy: { depositDate: 'asc' }, select: { depositDate: true } }),
    ])

    // 每个店铺只取最近一次快照日的余额（同一天可能有多个账户类型，求和）
    const latest = new Map<string, string>()
    for (const row of balances) if (!latest.has(row.sellerAccountId)) latest.set(row.sellerAccountId, dateText(row.snapshotDate))
    const deferredAmount = balances.filter(row => latest.get(row.sellerAccountId) === dateText(row.snapshotDate)).reduce((total, row) => total + Number(row.amount.toString()), 0)
    const asOf = [...latest.values()].sort()[0]
    const hasBalance = latest.size > 0
    const releasedAmount = released._count._all > 0 && released._sum.amount !== null ? Number(released._sum.amount.toString()) : null
    const any = releasedAmount !== null || hasBalance || next !== null
    return {
      state: any ? 'OK' : 'NO_DATA',
      note: any ? null : '尚无财务交易、余额或结算记录（需要先授权店铺并完成财务同步）',
      period,
      released: releasedAmount,
      deferred: hasBalance && asOf ? { amount: deferredAmount, asOf } : null,
      nextPayoutDate: next?.depositDate ? localDay(next.depositDate, request.timeZone) : null,
      nextPayoutNote: next?.depositDate ? '来自亚马逊已公布的结算周期，实际到账以银行为准' : NEXT_PAYOUT_NOTE_NONE,
    }
  }
}

const localDay = (value: Date, zone: string) => todayIn(zone, value)
