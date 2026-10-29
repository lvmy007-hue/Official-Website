import {
  PROMOTION_BASELINE_MIN_DAYS,
  baselineExpectation,
  promoIncrementOf,
  promotionRoi,
  type PromotionCostSection,
  type PromotionEffectSection,
  type PromotionProfitSection,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { asDate, dateText } from '../overview'
import { baselineDaysOf, type BaselinePlan } from './promotions-effect'
import { num } from './promotions-common'
import { PARTIAL_NOTE, type DetailContext } from './promotions-context'

// 促销利润页签（M-160）：增量毛利 = 活动期间实际毛利 − 基线期望毛利（同样的基线法），促销投入回报率 = 增量毛利 ÷（折扣成本 + 平台费用）。
// 毛利来自利润日表（下单口径、美元、所选商品）；某一天只要有一行没有成本，这一天的毛利就是“未知”，不拿部分行凑数。
// 这是模型估算，不是亚马逊给的数字，也不能证明因果。需要利润字段权限（field.profit）。

const FORMULA = '促销投入回报率 = 增量毛利 ÷（折扣成本 + 平台费用）'
const round = (value: number) => Math.round(value * 100) / 100

const empty = (state: PromotionProfitSection['state'], note: string | null): PromotionProfitSection => ({
  state,
  note,
  currency: 'USD',
  actualProfit: null,
  expectedProfit: null,
  incrementalProfit: null,
  roi: { value: null, denominator: null, formula: FORMULA },
})

export async function profitSection(
  prisma: PrismaService,
  ctx: DetailContext,
  input: { canProfit: boolean; effect: PromotionEffectSection; plan: BaselinePlan | null; cost: PromotionCostSection },
): Promise<PromotionProfitSection> {
  const { effect, plan, cost } = input
  if (!input.canProfit) return empty('RESTRICTED', '需要利润字段权限（field.profit）才能看利润与促销投入回报率')
  if (!plan || !ctx.window || ['NO_EFFECT', 'NOT_STARTED', 'NO_ITEMS'].includes(effect.state)) return empty(effect.state === 'OK' ? 'NO_DATA' : effect.state, effect.note)
  const rows = await prisma.profitDaily.groupBy({
    by: ['profitDate'],
    where: {
      tenantId: ctx.tenantId,
      sellerAccountId: ctx.row.sellerAccountId,
      asin: { in: ctx.asins },
      basis: 'ORDERED',
      currency: 'USD',
      profitDate: { gte: asDate(plan.range.from), lte: asDate(ctx.window.to) },
    },
    _sum: { profit: true },
    _count: { _all: true, profit: true },
    orderBy: { profitDate: 'asc' },
    take: 1000,
  })
  // 一天的毛利：有利润行且每行都有成本才算数；没有利润行但当天这些商品销量为 0，毛利就是 0；其余为未知
  const profit = new Map<string, number | null>()
  for (const item of rows) profit.set(dateText(item.profitDate), item._count.profit === item._count._all ? (num(item._sum.profit) ?? 0) : null)
  const valueOf = (date: string): number | null => (profit.has(date) ? (profit.get(date) ?? null) : (plan.units.get(date) ?? 0) === 0 ? 0 : null)
  const dates = plan.windowDates.filter(date => plan.covered.has(date))
  if (dates.length === 0) return empty('NO_DATA', '尚无记录：活动期间还没有销售汇总数据')
  const known = dates.filter(date => valueOf(date) !== null)
  if (known.length < dates.length) return empty('NO_DATA', `活动期间有 ${dates.length - known.length} 天的利润未知（利润日表缺行或成本不全），不给不完整的利润`)
  const actual = round(dates.reduce((sum, date) => sum + (valueOf(date) ?? 0), 0))
  const expectation = baselineExpectation(baselineDaysOf(plan, valueOf), dates, PROMOTION_BASELINE_MIN_DAYS)
  if (expectation.info.state !== 'OK')
    return { ...empty('INSUFFICIENT', `基线期利润有效日只有 ${expectation.info.usedDays} 天（不足 ${PROMOTION_BASELINE_MIN_DAYS} 天），不给增量利润`), actualProfit: actual }
  const expected = round(expectation.total ?? 0)
  const increment = promoIncrementOf(actual, expected).value
  const incremental = increment === null ? null : round(increment)
  const fee = cost.platformFee.state === 'OK' ? cost.platformFee.amount : cost.platformFee.state === 'NOT_APPLICABLE' ? 0 : null
  const roi = promotionRoi(incremental, cost.discount.amount, fee)
  const reason =
    roi.value !== null ? null : cost.discount.amount === null || fee === null ? '折扣成本或平台费用没有可用的数字，不给促销投入回报率' : '折扣成本与平台费用之和不大于 0，不给促销投入回报率'
  return {
    state: 'OK',
    note: [reason, ctx.asinsPartial ? PARTIAL_NOTE : null].filter(Boolean).join('；') || null,
    currency: 'USD',
    actualProfit: actual,
    expectedProfit: expected,
    incrementalProfit: incremental,
    roi: { value: roi.value === null ? null : Math.round(roi.value * 100) / 100, denominator: roi.denominator === null ? null : round(roi.denominator), formula: FORMULA },
  }
}
