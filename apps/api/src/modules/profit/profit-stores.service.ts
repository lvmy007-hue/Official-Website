import { Injectable } from '@nestjs/common'
import { ProfitQuerySchema, type ProfitStoreRow, type ProfitStoresResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bridgeViewOf, marginOf, totalsOf } from './profit-aggregate'
import { NO_DATA_NOTE, ProfitAccessService } from './profit-access.service'
import { loadStoreNames, loadTotalsByStore } from './profit-load'

// 店铺利润（07 章 7.9 第 2 个页签）：范围内每个店铺一行，各带自己的利润桥；没有数据的店铺也列出，写“尚无记录”，不是 0。
@Injectable()
export class ProfitStoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProfitAccessService,
  ) {}

  async stores(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitStoresResponse> {
    const access = await this.access.resolve(req, rawQuery, 'profit', now)
    const { recognition } = ProfitQuerySchema.parse({ recognition: rawQuery.recognition })
    const where = this.access.where(access, recognition)
    const [byStore, names, freshness] = await Promise.all([loadTotalsByStore(this.prisma, where), loadStoreNames(this.prisma, access.tenantId, access.scope), this.access.freshness(access, now)])
    const ids = new Set([...names.keys(), ...byStore.keys()])
    const items: ProfitStoreRow[] = [...ids].map(id => {
      const totals = byStore.get(id) ?? totalsOf({}, 0, 0)
      return {
        sellerAccountId: id,
        storeName: names.get(id) ?? id,
        units: totals.units,
        revenue: totals.rows === 0 ? null : totals.revenue,
        netProfit: totals.profit,
        margin: marginOf(totals.profit, totals.revenue),
        bridge: bridgeViewOf(totals, access.canCost),
      }
    })
    // 销售额从高到低，没有数据的排在最后；并列按店铺名
    items.sort((a, b) => (a.revenue === b.revenue ? (a.storeName < b.storeName ? -1 : 1) : a.revenue === null ? 1 : b.revenue === null ? -1 : b.revenue - a.revenue))
    const empty = byStore.size === 0
    return { state: empty ? 'NO_DATA' : 'OK', note: empty ? NO_DATA_NOTE : null, ...this.access.common(access, recognition, freshness), items }
  }
}
