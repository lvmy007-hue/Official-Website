import { Injectable } from '@nestjs/common'
import {
  INVENTORY_ACTION_LABEL,
  ScopeQuerySchema,
  storageTypeLabel,
  type CapacityCrossing,
  type CapacityRow,
  type CapacitySuggestion,
  type FeeMonth,
  type NotConnectedItem,
  type StorageCapacityResponse,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { crossings } from './inventory-aging'
import { CAPACITY_KEYS, sourceFreshness } from './inventory-freshness'
import { previousMonths } from './inventory-health.service'
import { InventoryLoaderService } from './inventory-loader.service'
import { InventoryPolicyService } from './inventory-policy.service'
import { daysBetween } from './inventory-rules'

const PERMISSION = 'inventory.read'
const FEE_MONTHS = 6
const SUGGESTION_LIMIT = 20
const CROSSING_LIMIT = 30
const CROSSING_WINDOW_DAYS = 30
const SLOW_COVER_DAYS = 90
const round2 = (value: number) => Math.round(value * 100) / 100
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
const sumOrNull = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? round2(present.reduce((total, value) => total + value, 0)) : null
}

const NOT_CONNECTED: NotConnectedItem[] = [
  { key: 'age-surcharge-actual', label: '库龄附加费（实际发生额）', note: '本页暂不汇总实际扣费，请到“费用事件”页的“库龄附加费”页签查看；下方只有库龄报告里的预估', workPackage: '' },
  {
    key: 'low-inventory-fee-actual',
    label: '低库存水平费（实际发生额）',
    note: '本页暂不汇总实际扣费，请到“费用事件”页的“仓储费”页签查看（按费用名称归类）；单个 SKU 的预估见库存详情“库龄与费用”页签',
    workPackage: '',
  },
]

// 仓储容量与费用（06 章 6.6）：利用率与限额、费用趋势（报告里有的几类）、下月预测与库龄跨档提醒、占体积大且周转慢的 SKU。
// 报告没给的数字一律为 null（页面写“尚无记录”），不补 0；实际发生的库龄附加费与低库存水平费在“费用事件”页查看（P2b-05），本页暂不汇总。
@Injectable()
export class CapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
  ) {}

  async capacity(req: RequestWithContext, rawQuery: Record<string, string>): Promise<StorageCapacityResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, rawQuery)
    ScopeQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const today = await this.policies.todayOf(tenantId)
    const policy = await this.policies.currentOf(tenantId, today)
    const [utilization, fees, loaded, volumes, freshness] = await Promise.all([
      this.utilization(tenantId, scope),
      this.fees(tenantId, scope, today),
      this.loader.load({ tenantId, scope, today, policy }),
      this.volumes(tenantId, scope),
      sourceFreshness(this.prisma, tenantId, scope, CAPACITY_KEYS),
    ])
    const rows = loaded.items
    const crossingRows: CapacityCrossing[] = rows
      .flatMap(item => {
        const snapshotDate = item.row.age.snapshotDate
        if (!snapshotDate) return []
        return crossings(item.ageColumns, item.feeColumns, snapshotDate, today)
          .filter(entry => entry.feeTier && !entry.likelyCrossed && daysBetween(today, entry.earliestDate) <= CROSSING_WINDOW_DAYS)
          .map(entry => ({
            sellerAccountId: item.row.sellerAccountId,
            storeName: item.row.storeName,
            sku: item.row.sku,
            boundaryDays: entry.boundaryDays,
            toLabel: entry.toLabel,
            qty: entry.qty,
            earliestDate: entry.earliestDate,
            latestDate: entry.latestDate,
            likelyCrossed: entry.likelyCrossed,
            estimatedIncrease: entry.estimatedIncrease,
          }))
      })
      .sort((a, b) => a.latestDate.localeCompare(b.latestDate) || a.sku.localeCompare(b.sku))
    const suggestions = this.suggestions(rows, volumes)
    const storageValues = rows.map(item => item.row.fees.nextMonthStorage)
    const hasAny = utilization.length > 0 || fees.latestMonth !== null || storageValues.some(value => value !== null) || suggestions.length > 0
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : '尚无仓储容量与费用记录；月度仓储费报告同步或导入仓储限额文件后，这里会显示利用率、费用趋势与下月预测',
      utilization,
      fees,
      forecast: {
        nextMonthStorage: sumOrNull(storageValues),
        storageSkuCount: storageValues.filter(value => value !== null).length,
        ageSurchargeEstimate: sumOrNull(rows.map(item => item.row.age.surchargeEstimate)),
        crossings: crossingRows.slice(0, CROSSING_LIMIT),
        crossingTotal: sumOrNull(crossingRows.map(entry => entry.estimatedIncrease)),
      },
      suggestions,
      notConnected: NOT_CONNECTED,
      freshness,
    }
  }

  private async utilization(tenantId: string, scope: ResolvedScope): Promise<CapacityRow[]> {
    const [snapshots, stores] = await Promise.all([
      this.prisma.storageCapacitySnapshot.findMany({ where: { tenantId, ...storeWhere(scope) }, orderBy: [{ snapshotDate: 'desc' }, { id: 'asc' }], take: 2000 }),
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true, displayName: true }, take: 500 }),
    ])
    const names = await memberNames(
      this.prisma,
      tenantId,
      snapshots.map(row => row.importedBy),
    )
    const storeNames = new Map(stores.map(store => [store.id, store.displayName]))
    const keys = [...new Set(snapshots.map(row => `${row.sellerAccountId}|${row.storageType}`))].sort()
    return keys.map(key => {
      const [sellerAccountId, storageType] = key.split('|')
      const mine = snapshots.filter(row => row.sellerAccountId === sellerAccountId && row.storageType === storageType)
      const report = mine.find(row => row.sourceKind === 'REPORT' && row.utilizationPct !== null)
      const file = mine.find(row => row.sourceKind === 'FILE_IMPORT')
      return {
        sellerAccountId,
        storeName: storeNames.get(sellerAccountId) ?? '',
        storageType,
        storageTypeLabel: storageTypeLabel(storageType),
        report: report ? { utilization: num(report.utilizationPct) as number, month: report.snapshotDate.toISOString().slice(0, 7) } : null,
        limit: file
          ? {
              limitQty: num(file.limitQty),
              usedQty: num(file.usedQty),
              usedRatio: num(file.utilizationPct),
              captureDate: file.snapshotDate.toISOString().slice(0, 10),
              sourceFileName: file.sourceFileName,
              importedBy: file.importedBy ? nameOrFormer(names, file.importedBy) : null,
              importedAt: file.syncedAt.toISOString(),
            }
          : null,
      }
    })
  }

  /** 最近 6 个自然月（不含当月，月度费用要月结后才出）；某类费用某月没有任何记录时为 null。 */
  private async fees(tenantId: string, scope: ResolvedScope, today: string): Promise<StorageCapacityResponse['fees']> {
    const months = previousMonths(today, FEE_MONTHS)
    const grouped = await this.prisma.storageFeeRecord.groupBy({
      by: ['chargeMonth', 'feeKind'],
      where: { tenantId, ...storeWhere(scope), chargeMonth: { gte: new Date(`${months[0]}T00:00:00Z`) } },
      _sum: { amount: true },
    })
    const cell = (month: string, kind: string): number | null => {
      const rows = grouped.filter(row => row.chargeMonth.toISOString().slice(0, 10) === month && row.feeKind === kind)
      return rows.length ? round2(rows.reduce((total, row) => total + (num(row._sum.amount) ?? 0), 0)) : null
    }
    const list: FeeMonth[] = months.map(month => ({
      month: month.slice(0, 7),
      storage: cell(month, 'STORAGE'),
      overage: cell(month, 'OVERAGE'),
      longTerm: cell(month, 'LONGTERM'),
      utilization: cell(month, 'UTILIZATION'),
    }))
    const withData = list.filter(item => [item.storage, item.overage, item.longTerm, item.utilization].some(value => value !== null))
    return { months: list, latestMonth: withData.length ? withData[withData.length - 1].month : null }
  }

  /** 每个店铺最新一份规划快照里的单件体积与体积单位。 */
  private async volumes(tenantId: string, scope: ResolvedScope): Promise<Map<string, { volume: number; unit: string | null }>> {
    const latest = await this.prisma.inventoryPlanningSnapshot.groupBy({ by: ['sellerAccountId'], where: { tenantId, ...storeWhere(scope) }, _max: { snapshotDate: true } })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    const result = new Map<string, { volume: number; unit: string | null }>()
    if (pairs.length === 0) return result
    const rows = await this.prisma.inventoryPlanningSnapshot.findMany({
      where: { tenantId, itemVolume: { not: null }, OR: pairs } as Prisma.InventoryPlanningSnapshotWhereInput,
      select: { sellerAccountId: true, sku: true, itemVolume: true, volumeUnit: true },
      take: 20_000,
    })
    for (const row of rows) if (row.itemVolume !== null) result.set(`${row.sellerAccountId}|${row.sku}`, { volume: num(row.itemVolume) as number, unit: row.volumeUnit })
    return result
  }

  /** 占体积大但周转慢的 SKU：可售天数 ≥ 90、被规则判为冗余或库龄有风险，按占用体积从大到小。 */
  private suggestions(rows: Awaited<ReturnType<InventoryLoaderService['load']>>['items'], volumes: Map<string, { volume: number; unit: string | null }>): CapacitySuggestion[] {
    const list: CapacitySuggestion[] = []
    for (const { row } of rows) {
      if (row.quantity.sellable <= 0) continue
      const cover = row.assessment.daysOfCover ?? row.cover.amazonDaysOfSupply
      const reasons: string[] = []
      if (cover !== null && cover >= SLOW_COVER_DAYS) reasons.push(`可售天数 ${Math.round(cover)} 天`)
      if (row.assessment.risk === 'EXCESS') reasons.push('库存规则判为冗余')
      if (row.age.atRisk) reasons.push('库龄接近附加费档位')
      if (reasons.length === 0) continue
      const volume = volumes.get(`${row.sellerAccountId}|${row.sku}`)
      list.push({
        sellerAccountId: row.sellerAccountId,
        storeName: row.storeName,
        sku: row.sku,
        title: row.title,
        occupiedVolume: volume ? round2(volume.volume * row.quantity.sellable) : null,
        volumeUnit: volume?.unit ?? null,
        sellable: row.quantity.sellable,
        daysOfCover: cover === null ? null : Math.round(cover),
        nextMonthStorage: row.fees.nextMonthStorage,
        action: row.advice.ourAction ?? '',
        actionLabel: row.advice.ourAction ? INVENTORY_ACTION_LABEL[row.advice.ourAction] : '评估降价或移除（暂无规则建议）',
        reason: reasons.join('；'),
      })
    }
    return list
      .sort((a, b) => (b.occupiedVolume ?? -1) - (a.occupiedVolume ?? -1) || (b.nextMonthStorage ?? -1) - (a.nextMonthStorage ?? -1) || b.sellable - a.sellable || a.sku.localeCompare(b.sku))
      .slice(0, SUGGESTION_LIMIT)
  }
}
