import { Injectable } from '@nestjs/common'
import { PROFIT_DICTIONARY_KIND, buildDictionaryView, type BridgeContribution, type BridgeKey, type ProfitBridgeView, type ProfitDictionaryView } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'

// 利润页按利润项目字典拆开（P6-18）：读企业的字典与利润日表里按项目拆分的金额（itemAmounts），和利润桥一起合成一棵树。
// 金额一律是对净利润的带符号贡献；每个项目都能追到交易行（利润分析的“可追溯”浮层沿用旧入口，字典页按项目列出交易类型与近 30 天笔数）。
// 读取按页翻（每页 5000 行、最多 40 页）：行数再多也只会标“不完整”，不会拖垮接口；没有字典（没人打开过字典页）时返回 null。

const PAGE = 5000
const MAX_PAGES = 40

export interface DictionaryScope {
  tenantId: string
  where: Prisma.ProfitDailyWhereInput
  bridge: ProfitBridgeView
  canCost: boolean
}

@Injectable()
export class ProfitDictionaryService {
  constructor(private readonly prisma: PrismaService) {}

  async view(scope: DictionaryScope): Promise<ProfitDictionaryView | null> {
    const { tenantId } = scope
    const [items, active] = await Promise.all([
      this.prisma.profitItem.findMany({
        where: { tenantId },
        select: { id: true, parentId: true, level: true, name: true, group: true, isSystem: true, systemKey: true, sort: true },
        take: 1000,
      }),
      this.prisma.metricVersion.findFirst({ where: { tenantId, kind: PROFIT_DICTIONARY_KIND, status: 'ACTIVE' }, select: { versionNo: true } }),
    ])
    if (items.length === 0) return null
    const { sums, rowsWithItems, truncated } = await this.itemSums(scope.where)
    const contribution: BridgeContribution = {}
    for (const item of scope.bridge.items) contribution[item.key as BridgeKey] = item.contribution
    const view = buildDictionaryView({
      version: active?.versionNo ?? 0,
      items,
      sums,
      contribution,
      netProfit: scope.bridge.netProfit,
      rowsWithItems,
      rowsTotal: scope.bridge.rows,
    })
    const notes: string[] = view.note ? [view.note] : []
    if (truncated) notes.push(`范围内的行太多，只汇总了前 ${PAGE * MAX_PAGES} 行带项目拆分的数据，金额不完整，请缩小日期范围`)
    // 没有成本字段权限时三项成本不给数，合计自然对不上净利润，不当作“不平衡”
    const balanced = scope.canCost && !truncated ? view.balanced : null
    if (!scope.canCost) notes.push('没有成本字段权限（field.cost），采购成本、头程、关税、其他成本不显示金额')
    return { ...view, balanced, note: notes.length > 0 ? notes.join('；') : null }
  }

  private async itemSums(where: Prisma.ProfitDailyWhereInput): Promise<{ sums: Map<string, number>; rowsWithItems: number; truncated: boolean }> {
    const sums = new Map<string, number>()
    let rowsWithItems = 0
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await this.prisma.profitDaily.findMany({
        where: { ...where, itemAmounts: { not: Prisma.DbNull } },
        select: { id: true, itemAmounts: true },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      for (const row of rows) {
        const amounts = row.itemAmounts
        if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) continue
        rowsWithItems += 1
        for (const [key, value] of Object.entries(amounts as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value)) sums.set(key, (sums.get(key) ?? 0) + value)
        }
      }
      if (rows.length < PAGE) return { sums, rowsWithItems, truncated: false }
      cursor = rows[rows.length - 1]?.id
    }
    return { sums, rowsWithItems, truncated: true }
  }
}
