import type { PromotionReported } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { NO_REPORT, num, type PromotionRecord } from './promotions-common'

// 促销绩效报告（R-40）与优惠券绩效报告（R-41）的汇总：按映射编号（促销的 trackingId）关联到促销。
// 关联键、列名与粒度都按文档整理、未用真实报告核对（CR-080）：找不到行就写“尚无记录”，报告从没同步成功过写“尚未接入”，绝不写 0。

const isCoupon = (row: Pick<PromotionRecord, 'promotionType'>) => row.promotionType === 'COUPON'
const keyOf = (storeId: string, mappingId: string) => `${storeId}|${mappingId}`

export async function reportedTotals(
  prisma: PrismaService,
  tenantId: string,
  rows: readonly PromotionRecord[],
  connected: { promotion: boolean; coupon: boolean },
): Promise<Map<string, PromotionReported>> {
  const result = new Map<string, PromotionReported>()
  const linked = rows.filter(row => row.mappingId)
  const promotions = linked.filter(row => !isCoupon(row))
  const coupons = linked.filter(isCoupon)
  const stores = (list: readonly PromotionRecord[]) => [...new Set(list.map(row => row.sellerAccountId))]
  const mappings = (list: readonly PromotionRecord[]) => [...new Set(list.flatMap(row => (row.mappingId ? [row.mappingId] : [])))]
  const [promotionRows, couponRows] = await Promise.all([
    promotions.length
      ? prisma.promotionMetric.groupBy({
          by: ['sellerAccountId', 'mappingId'],
          where: { tenantId, sellerAccountId: { in: stores(promotions) }, mappingId: { in: mappings(promotions) }, currency: 'USD' },
          _sum: { units: true, sales: true, redemptions: true },
          orderBy: [{ sellerAccountId: 'asc' }, { mappingId: 'asc' }],
          take: 1000,
        })
      : Promise.resolve([]),
    coupons.length
      ? prisma.couponMetric.groupBy({
          by: ['sellerAccountId', 'mappingId'],
          where: { tenantId, sellerAccountId: { in: stores(coupons) }, mappingId: { in: mappings(coupons) }, currency: 'USD' },
          _sum: { sales: true, redemptions: true },
          orderBy: [{ sellerAccountId: 'asc' }, { mappingId: 'asc' }],
          take: 1000,
        })
      : Promise.resolve([]),
  ])
  const byPromotion = new Map(promotionRows.map(row => [keyOf(row.sellerAccountId, row.mappingId), { units: row._sum.units, sales: num(row._sum.sales), redemptions: row._sum.redemptions }]))
  const byCoupon = new Map(couponRows.map(row => [keyOf(row.sellerAccountId, row.mappingId), { units: null, sales: num(row._sum.sales), redemptions: row._sum.redemptions }]))
  for (const row of rows) {
    const coupon = isCoupon(row)
    const found = row.mappingId ? (coupon ? byCoupon : byPromotion).get(keyOf(row.sellerAccountId, row.mappingId)) : undefined
    if (found) result.set(row.id, { state: 'OK', ...found })
    else result.set(row.id, { ...NO_REPORT, state: (coupon ? connected.coupon : connected.promotion) ? 'NO_RECORD' : 'NOT_CONNECTED' })
  }
  return result
}
