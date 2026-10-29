import { Injectable } from '@nestjs/common'
import {
  CASHFLOW_ADS_DAYS,
  CASHFLOW_CONFIRM,
  CASHFLOW_FRESHNESS_KEYS,
  CASHFLOW_MODEL_VERSION,
  CASHFLOW_READ,
  CASHFLOW_RELEASED_DAYS,
  CASHFLOW_RUN_RATE_DAYS,
  CashflowQuerySchema,
  ScopeSearchSchema,
  addDaysText,
  buildForecast,
  deferralBuckets,
  roundCash,
  type CashSource,
  type CashSourceView,
  type CashflowDeferral,
  type CashflowForecastView,
  type CashflowResponse,
  type ForecastWeek,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { todayIn, validZone } from '../overview'
import { baseWhere, loadBalances, loadDeferred, loadReleased, loadRunRates, loadSettlementHistory, loadStores, type DeferredGroup } from './cashflow-load'
import { loadAdsOutflow, loadFirstMileOutflow, loadPurchaseOutflow } from './cashflow-outflows'
import { assemblePayout } from './cashflow-payout'
import { DisbursementsService } from './disbursements.service'

const NO_DATA_NOTE = '尚无回款与现金流数据：店铺授权后，财务交易（每 6 小时同步）、结算报告（每天检索一次）同步到后显示；到账需要财务手工登记'
const MATURITY_NOTE = '预计释放日来自财务接口的递延上下文（官方模型字段 maturityDate）；接口没给的递延交易列在“未提供释放日”，不用下单日推算。已释放金额按入账时间统计（官方没有给出释放时刻）。'

const view = (label: string, source: CashSource<unknown>, total: number | null, okNote: string): CashSourceView =>
  source.state === 'OK' ? { state: 'OK', label, note: okNote, total } : { state: source.state, label, note: source.reason, total: null }
const sum = (items: ReadonlyArray<{ amount: number }>) => roundCash(items.reduce((total, item) => total + item.amount, 0))

// 回款与现金流（P2b-08，07 章 7.8）：余额（只有递延余额）、递延与释放、打款预测、按周现金流预测、到账登记与核对。
// 预测是模型估算：没有足够的结算单历史就不预测，采购与头程没有店铺归属只在“全部店铺”范围计入，广告尚未接入就写尚未接入，都不显示成 0。
@Injectable()
export class CashflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly disbursements: DisbursementsService,
  ) {}

  async cashflow(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<CashflowResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, CASHFLOW_READ, rawQuery)
    ScopeSearchSchema.parse(rawQuery)
    const query = CashflowQuerySchema.parse({ currency: rawQuery.currency, weeks: rawQuery.weeks })
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone, now)
    const horizonEnd = addDaysText(today, query.weeks * 7 - 1)
    const where = baseWhere(tenantId, scope)
    const access = { permissions: context.permissions, scope }

    const stores = await loadStores(this.prisma, tenantId, scope)
    const [balances, deferred, released, rates, history, purchase, firstMile, ads, disbursements, freshness] = await Promise.all([
      loadBalances(this.prisma, where, stores, today),
      loadDeferred(this.prisma, where, today, zone),
      loadReleased(this.prisma, where, today, zone),
      loadRunRates(this.prisma, where, today, zone),
      loadSettlementHistory(this.prisma, where, zone),
      loadPurchaseOutflow(this.prisma, tenantId, access, query.currency),
      loadFirstMileOutflow(this.prisma, tenantId, access, query.currency),
      loadAdsOutflow(this.prisma, tenantId, access, query.currency, today, zone),
      this.disbursements.rows(tenantId, scope, today, zone),
      sourceFreshness(this.prisma, tenantId, scope, CASHFLOW_FRESHNESS_KEYS, now),
    ])

    const plan = assemblePayout({ stores, history, rates, deferred, currency: query.currency, today, horizonEnd })
    const weeks = buildForecast({
      today,
      weeks: query.weeks,
      published: plan.published,
      predicted: plan.predicted,
      purchase: purchase.source,
      firstMile: firstMile.source,
      adsDaily: ads,
    })
    const currencies = [
      ...new Set([
        query.currency,
        ...history.map(point => point.currency),
        ...balances.items.map(item => item.currency),
        ...deferred.map(group => group.currency),
        ...released.map(item => item.currency),
      ]),
    ].sort()
    const hasAny = balances.items.length > 0 || deferred.length > 0 || history.length > 0 || disbursements.items.length > 0 || released.length > 0
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : NO_DATA_NOTE,
      asOf: today,
      currency: query.currency,
      currencies,
      balances,
      deferral: this.deferral(deferred, released, query.currency, today, query.weeks),
      payout: plan.payout,
      forecast: this.forecastView({
        currency: query.currency,
        weeks,
        plan,
        purchase,
        firstMile,
        ads,
        purchaseTotal: sum(purchase.source.state === 'OK' ? purchase.source.value : []),
        firstMileTotal: sum(firstMile.source.state === 'OK' ? firstMile.source.value : []),
      }),
      disbursements,
      canConfirm: hasPermission(context.permissions, CASHFLOW_CONFIRM),
      freshness,
    }
  }

  private deferral(groups: readonly DeferredGroup[], released: Array<{ currency: string; amount: number; count: number }>, currency: string, today: string, weeks: number): CashflowDeferral {
    const byCurrency = new Map<string, { amount: number; count: number; withMaturity: number }>()
    for (const group of groups) {
      const entry = byCurrency.get(group.currency) ?? { amount: 0, count: 0, withMaturity: 0 }
      entry.amount = roundCash(entry.amount + group.amount)
      entry.count += group.count
      if (group.maturityDate !== null) entry.withMaturity += group.count
      byCurrency.set(group.currency, entry)
    }
    const mine = groups.filter(group => group.currency === currency)
    return {
      totals: [...byCurrency.entries()].map(([code, entry]) => ({ currency: code, ...entry })).sort((a, b) => a.currency.localeCompare(b.currency)),
      schedule:
        mine.length > 0
          ? deferralBuckets(
              mine.map(group => ({ date: group.maturityDate, amount: group.amount, count: group.count })),
              today,
              weeks,
            )
          : null,
      released,
      releasedDays: CASHFLOW_RELEASED_DAYS,
      note: MATURITY_NOTE,
    }
  }

  private forecastView(input: {
    currency: string
    weeks: ForecastWeek[]
    plan: ReturnType<typeof assemblePayout>
    purchase: Awaited<ReturnType<typeof loadPurchaseOutflow>>
    firstMile: Awaited<ReturnType<typeof loadFirstMileOutflow>>
    ads: CashSource<number>
    purchaseTotal: number
    firstMileTotal: number
  }): CashflowForecastView {
    const { plan, purchase, firstMile, ads } = input
    const totalOf = (key: 'publishedInflow' | 'estimatedInflow' | 'purchaseOutflow' | 'firstMileOutflow' | 'adsOutflow') => roundCash(input.weeks.reduce((total, week) => total + (week[key] ?? 0), 0))
    const predictedNote = plan.unpredicted > 0 ? `${plan.unpredicted} 个店铺的结算单历史不足，没有预测，其余店铺按模型估算` : '按各店铺的结算周期与近期日均净入账估算，见“打款预测”的依据说明'
    const excluded = [
      { label: '采购付款', ...purchase.excluded },
      { label: '头程付款', ...firstMile.excluded },
    ].filter(item => item.count > 0)
    const undated = [
      { label: '采购付款', count: purchase.undated },
      { label: '头程付款', count: firstMile.undated },
    ].filter(item => item.count > 0)
    return {
      currency: input.currency,
      modelVersion: CASHFLOW_MODEL_VERSION,
      weeks: input.weeks,
      sources: [
        view('已公布的打款', { state: 'OK', value: null }, totalOf('publishedInflow'), '结算单上已有打款日与金额、打款日在今天或之后的结算单（确定的，不是估算）'),
        view('预计打款', plan.predicted, plan.predicted.state === 'OK' ? totalOf('estimatedInflow') : null, predictedNote),
        view('采购付款', purchase.source, input.purchaseTotal, '付款计划里状态为“计划”、采购单已下单且未取消的付款，按计划付款日；计划日已过的算逾期，归入第一周'),
        view('头程付款', firstMile.source, input.firstMileTotal, '还没有登记实际费用、也没有送达的运单，按预估费用与预计到港日估计（官方没有头程付款计划，这是估计，不是合同约定）'),
        view('广告扣款', ads, ads.state === 'OK' ? totalOf('adsOutflow') : null, `最近 ${CASHFLOW_ADS_DAYS} 天广告花费的日均 × 7 天（模型估算）`),
      ],
      excluded,
      undated,
      assumptions: [
        '预测每周从今天起算 7 天；累计净额不含期初余额（官方没有可用的账户余额接口）',
        `近期日均净入账取最近 ${CASHFLOW_RUN_RATE_DAYS} 天已释放交易（不含打款本身）；净额为负时亚马逊不打款，按 0 处理`,
        '预测不换算汇率：只计入与所选币种相同的金额，币种不同的采购与头程付款单独列出',
      ],
    }
  }
}
