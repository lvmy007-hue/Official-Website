import { Injectable } from '@nestjs/common'
import {
  ASIN360_WIN_PRICE_NOTE,
  PROFIT_BASIS_LABEL,
  PROFIT_BASIS_NOTE,
  PROFIT_CURRENCY,
  PROFIT_FRESHNESS_KEYS,
  ProfitQuerySchema,
  ScopeSearchSchema,
  type Asin360EconomicsResponse,
  type ProfitTrendPoint,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { resolvePeriods, todayIn, validZone } from '../overview'
import { bridgeViewOf, coverageOf, loadTotals, loadTotalsByDate, profitWhere } from '../profit'
import { ProductAccessService } from './product-access.service'
import { unitEconomicsOf } from './product-economics-math'

const NO_DATA_NOTE = '所选范围内这个商品尚无利润数据：订单、财务交易同步完成后会自动派生利润日表（每 6 小时重算近 45 天）；没有生效的成本版本时利润会是空的，不会当 0'
const NOTES = [
  '金额币种为美元。这里只含这个商品（店铺 × SKU）自己的行：店铺级费用（没有 SKU 的月度仓储费等）与没能分摊到商品的广告花费不在内，所以与利润分析页的店铺合计不会相加相等。',
  '广告花费是分摊到这个商品的部分（先按广告商品报表归属，剩余按销售额或销量分摊）；关税与汇兑损益尚未接入，不计入净利润（利润桥里显示“尚未接入”，不是 0）。',
  '每件金额 = 范围内合计 ÷ 销售件数；净利润只要有一行因缺少成本算不出就整体不给，不拿部分数字冒充。',
  '价格模拟是估算：假设佣金、退款、促销按售价等比例变化，其余费用与成本每件固定不变，不预测销量与转化的变化。',
]

// ASIN 360“利润与成本”页签的我方部分（P2b-17，05 章 5.2 第 5 页签）：单位经济瀑布与价格模拟的输入。
// 数据与口径完全沿用利润分析（P2b-10）：读利润日表（P2b-09 派生）、同一套利润桥函数，只是收窄到这个商品（店铺 × SKU）。
// 需要 profit.read 与利润字段权限（缺任一返回 403）；成本类项目另需成本字段权限，没有就整项写“无权限”。
@Injectable()
export class ProductEconomicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async economics(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360EconomicsResponse> {
    const { context, scope, product } = await this.access.resolve(req, id, 'profit.read')
    if (!canSeeField(context.permissions, 'profit')) throw new AppError(403, 'TENANT_ACCESS_DENIED', '商品利润需要利润字段权限（field.profit）')
    const dates = ScopeSearchSchema.parse(rawQuery)
    const { recognition } = ProfitQuerySchema.parse({ recognition: rawQuery.recognition })
    const canCost = canSeeField(context.permissions, 'cost')
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const periods = resolvePeriods(dates, todayIn(validZone(tenant?.timezone), now))
    const { period } = periods
    const where = { ...profitWhere(context.tenantId, scope, recognition, period.from, period.to), sellerAccountId: product.sellerAccountId, sku: product.sellerSku }
    const [totals, byDate, freshness] = await Promise.all([
      loadTotals(this.prisma, where),
      loadTotalsByDate(this.prisma, where),
      sourceFreshness(this.prisma, context.tenantId, scope, PROFIT_FRESHNESS_KEYS, now),
    ])
    const empty = totals.rows === 0
    const bridge = bridgeViewOf(totals, canCost)
    const trend: ProfitTrendPoint[] = byDate.map(point => ({ date: point.date, revenue: point.totals.revenue, profit: point.totals.profit, coveredProfit: point.totals.coveredProfit }))
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_DATA_NOTE : null,
      recognition,
      basisLabel: PROFIT_BASIS_LABEL[recognition],
      basisNote: PROFIT_BASIS_NOTE[recognition],
      currency: PROFIT_CURRENCY,
      range: { from: period.from, to: period.to, days: period.days, defaulted: periods.defaulted },
      bridge,
      unit: unitEconomicsOf(totals, bridge),
      trend,
      listPrice: product.price === null ? null : Number(product.price.toString()),
      winPrice: { state: 'NOT_CONNECTED', note: ASIN360_WIN_PRICE_NOTE },
      costCoverage: canCost ? coverageOf(totals.costedUnits, totals.units) : null,
      notes: NOTES,
      freshness,
    }
  }
}
