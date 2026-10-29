import { Injectable } from '@nestjs/common'
import { ScopeSearchSchema, type Asin360CompareResponse } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { resolvePeriods, todayIn, validZone } from '../overview'
import { ProductAccessService } from './product-access.service'
import { buildCompareRows } from './product-compare-math'
import { ProductOverviewService } from './product-overview.service'

// ASIN 360 同环比明细（P6-21，16 章 3.1）：本期对选中的对比期（环比、同比或自定义区间），输出通用结构。
// 没有选对比期时只给本期取值（prevValue 全为 null）；没有选日期范围时按默认近 30 天对比上一期（与经营表现一致）。
@Injectable()
export class ProductCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
    private readonly overview: ProductOverviewService,
  ) {}

  async compare(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<Asin360CompareResponse> {
    const { context, product } = await this.access.resolve(req, id)
    const dates = ScopeSearchSchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const periods = resolvePeriods(dates, todayIn(validZone(tenant?.timezone)))
    const { period, compare } = periods
    const [current, other] = await Promise.all([
      this.overview.loadWindow(product, period.from, period.to),
      compare ? this.overview.loadWindow(product, compare.from, compare.to) : Promise.resolve(null),
    ])
    const rows = buildCompareRows({
      current: { total: current.total, has: current.has },
      previous: other ? { total: other.total, has: other.has } : null,
      canSeeProfit: canSeeField(context.permissions, 'profit'),
    })
    return {
      state: current.has ? 'OK' : 'NO_DATA',
      note: current.has ? null : '所选范围内没有这个商品的订单记录（可能该时段没有销售，也可能还没同步）',
      period: { from: period.from, to: period.to },
      compare: compare ? { mode: compare.mode, from: compare.from, to: compare.to } : null,
      currency: current.currency ?? product.currency,
      rows,
    }
  }
}
