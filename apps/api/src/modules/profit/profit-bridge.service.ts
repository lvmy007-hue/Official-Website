import { Injectable } from '@nestjs/common'
import {
  BRIDGE_KEYS,
  ProfitQuerySchema,
  round6,
  type ProfitBridgeCompareResponse,
  type ProfitBridgeCompareRow,
  type ProfitBridgeItem,
  type ProfitItemState,
  type ProfitSummary,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bridgeViewOf, coverageOf, marginOf, type Totals } from './profit-aggregate'
import { NO_DATA_NOTE, ProfitAccessService, rangeOf } from './profit-access.service'
import { loadTotals } from './profit-load'

const STATE_ORDER: readonly ProfitItemState[] = ['RESTRICTED', 'NOT_CONNECTED', 'NO_DATA', 'OK']
/** 两期里状态“更差”的那个：没权限 > 尚未接入 > 没有数据 > 有数。 */
const worse = (a: ProfitItemState, b: ProfitItemState): ProfitItemState => (STATE_ORDER.indexOf(a) <= STATE_ORDER.indexOf(b) ? a : b)

const summaryOf = (totals: Totals, canCost: boolean): ProfitSummary => ({
  revenue: totals.rows === 0 ? null : totals.revenue,
  units: totals.units,
  netProfit: totals.profit,
  margin: marginOf(totals.profit, totals.revenue),
  coveredProfit: totals.coveredProfit,
  incompleteRows: totals.incompleteRows,
  rows: totals.rows,
  ...(canCost ? { costCoverage: coverageOf(totals.costedUnits, totals.units) } : {}),
})

// 利润桥对比（07 章 7.9 第 6 个页签）：当前期（全局时间范围）对比另一期（全局对比期；没选就用上一期），逐项给出对净利润的影响。
// 任一期某个项目没有数据（或没接入、无权限）时，这个项目不给影响值——不拿 0 当“上期没有”。
@Injectable()
export class ProfitBridgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProfitAccessService,
  ) {}

  async compare(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitBridgeCompareResponse> {
    const access = await this.access.resolve(req, rawQuery, 'profit', now)
    const { recognition } = ProfitQuerySchema.parse({ recognition: rawQuery.recognition })
    const { periods } = access
    const baseline = periods.compare ?? periods.previous
    const [currentTotals, baseTotals, freshness] = await Promise.all([
      loadTotals(this.prisma, this.access.where(access, recognition)),
      loadTotals(this.prisma, this.access.where(access, recognition, baseline)),
      this.access.freshness(access, now),
    ])
    const current = bridgeViewOf(currentTotals, access.canCost)
    const base = bridgeViewOf(baseTotals, access.canCost)
    const pick = (items: ProfitBridgeItem[], key: string) => items.find(item => item.key === key) as ProfitBridgeItem
    const rows: ProfitBridgeCompareRow[] = BRIDGE_KEYS.filter(key => key !== 'NET_PROFIT').map(key => {
      const a = pick(base.items, key)
      const b = pick(current.items, key)
      const impact = a.contribution === null || b.contribution === null ? null : round6(b.contribution - a.contribution)
      return { key, label: b.label, direction: b.direction, state: worse(a.state, b.state), base: a.value, current: b.value, impact }
    })
    const netImpact = base.netProfit === null || current.netProfit === null ? null : round6(current.netProfit - base.netProfit)
    const explained = rows.reduce((sum, row) => sum + (row.impact ?? 0), 0)
    const empty = currentTotals.rows === 0 && baseTotals.rows === 0
    const notes: string[] = []
    if (empty) notes.push(NO_DATA_NOTE)
    else if (netImpact === null) notes.push('至少一期有行因缺少成本算不出净利润，净利润变化不给；下面逐项变化仍然给出（没有数据的项目不给）。')
    if (periods.period.days !== baseline.days) notes.push(`两期天数不同（${periods.period.days} 天对 ${baseline.days} 天），合计金额不能直接比较大小，请结合利润率看。`)
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: notes.length > 0 ? notes.join(' ') : null,
      ...this.access.common(access, recognition, freshness),
      baseRange: rangeOf(baseline, false),
      compareMode: periods.compare?.mode === 'yoy' || periods.compare?.mode === 'custom' ? periods.compare.mode : 'previous',
      base: summaryOf(baseTotals, access.canCost),
      current: summaryOf(currentTotals, access.canCost),
      rows,
      netImpact,
      unexplained: netImpact === null ? null : round6(netImpact - explained),
    }
  }
}
