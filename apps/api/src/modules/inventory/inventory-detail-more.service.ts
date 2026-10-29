import { Injectable } from '@nestjs/common'
import { DEMAND_METHOD, type InventoryAgeFeesResponse, type InventoryDispositionResponse, type InventoryForecastResponse, type AwdTabResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AwdInventoryDetailService } from '../awd'
import { ourDisposition } from './inventory-advice'
import { crossings } from './inventory-aging'
import { forecastSeries } from './inventory-detail-math'
import { InventoryItemService } from './inventory-item.service'
import { plusDays } from './inventory-rules'

const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null)
const HISTORY_DAYS = 90

// 库存详情后半部分：上游仓储、库龄与费用、处置建议、预测。
@Injectable()
export class InventoryDetailMoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: InventoryItemService,
    private readonly awdTab: AwdInventoryDetailService,
  ) {}

  /** 上游仓储（AWD）：需要同时有库存与 AWD 查看权限；没有快照时不显示数字。 */
  async awd(req: RequestWithContext, id: string): Promise<AwdTabResponse> {
    const { context, scope, item } = await this.items.resolve(req, id, ['awd.read'])
    return this.awdTab.forSku(context.tenantId, scope, { sellerAccountId: item.row.sellerAccountId, sku: item.row.sku })
  }

  async ageFees(req: RequestWithContext, id: string): Promise<InventoryAgeFeesResponse> {
    const { today, item } = await this.items.resolve(req, id)
    const { row } = item
    const snapshotDate = row.age.snapshotDate
    const has = row.age.granularity !== null && snapshotDate !== null
    return {
      state: has ? 'OK' : 'NO_DATA',
      note: has ? null : '尚无库龄快照；库龄报告同步后这里会出现分布与跨档时间线',
      snapshotDate,
      granularity: row.age.granularity,
      buckets: row.age.buckets,
      surchargeEstimate: row.age.surchargeEstimate,
      bands: row.fees.ageSurchargeBands,
      longTerm6Month: row.fees.longTerm6Month,
      longTerm12Month: row.fees.longTerm12Month,
      crossings: has ? crossings(item.ageColumns, item.feeColumns, snapshotDate, today) : [],
    }
  }

  async disposition(req: RequestWithContext, id: string): Promise<InventoryDispositionResponse> {
    const { context, policy, item } = await this.items.resolve(req, id)
    const { row } = item
    const planning = await this.prisma.inventoryPlanningSnapshot.findFirst({
      where: { tenantId: context.tenantId, sellerAccountId: row.sellerAccountId, sku: row.sku },
      orderBy: { snapshotDate: 'desc' },
      select: { removalReportQty: true, removalReportReason: true },
    })
    const hasAmazon = row.dates.planningDate !== null
    return {
      amazon: {
        state: hasAmazon ? 'OK' : 'NO_DATA',
        action: row.advice.amazonAction,
        salePrice: row.advice.amazonSalePrice,
        saleDays: row.advice.amazonSaleDays,
        removalQty: planning?.removalReportQty ?? row.advice.amazonRemovalQty,
        removalReason: planning?.removalReportReason ?? null,
        savings: row.advice.amazonSavings,
        note: hasAmazon ? null : '尚无亚马逊库存规划报告，没有亚马逊的处置建议',
      },
      ours: ourDisposition({
        policy,
        assessment: row.assessment,
        agingAtRisk: row.age.atRisk,
        agedQty: item.agedQty,
        demandMid: row.demand.mid,
        sellable: row.quantity.sellable,
        inboundCounted: row.quantity.inboundCounted,
        nextMonthStorage: row.fees.nextMonthStorage,
        ageSurcharge: row.age.surchargeEstimate,
      }),
    }
  }

  async forecast(req: RequestWithContext, id: string): Promise<InventoryForecastResponse> {
    const { context, today, item } = await this.items.resolve(req, id)
    const { row } = item
    const rows = row.asin
      ? await this.prisma.asinDailySummary.findMany({
          where: { tenantId: context.tenantId, sellerAccountId: row.sellerAccountId, asin: row.asin, summaryDate: { gte: asDate(plusDays(today, -HISTORY_DAYS)), lte: asDate(plusDays(today, -1)) } },
          select: { summaryDate: true, units: true, inventoryAvailable: true },
          orderBy: { summaryDate: 'asc' },
          take: 200,
        })
      : []
    const byDate = new Map(rows.map(entry => [dateText(entry.summaryDate) as string, entry]))
    const first = rows.length ? (dateText(rows[0].summaryDate) as string) : null
    // 历史只从该 ASIN 第一次出现销量汇总的日期开始，之前的日期没有记录，不补 0
    const history = first
      ? Array.from({ length: HISTORY_DAYS }, (_, index) => plusDays(today, index - HISTORY_DAYS))
          .filter(date => date >= first)
          .map(date => {
            const entry = byDate.get(date)
            return { date, units: entry?.units ?? 0, stockout: entry?.inventoryAvailable === 0 }
          })
      : []
    const demand = row.demand
    return {
      state: demand.mid === null ? 'NO_DATA' : 'OK',
      note: demand.mid === null ? '没有销量记录，无法预测' : null,
      method: DEMAND_METHOD,
      source: demand.source,
      history,
      forecast: forecastSeries(demand, today),
      exclusions: {
        stockoutDays: demand.stockoutDaysExcluded,
        stockoutNote: '近 30 天内已知断货（可售为 0）的日子不计入日均，避免把断货当成需求下降',
        promotionNote: '促销与活动日历尚未接入，促销日销量没有被剔除，预测可能偏高',
        seasonality: row.seasonality,
      },
    }
  }
}
