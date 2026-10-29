import {
  ALLOCATION_RULE_BASIS_LABEL,
  PROFIT_ITEM_LIMITS,
  effectiveTargetOf,
  monthStartDate,
  monthText,
  transactionTypeKey,
  type AllocationFeeItemOption,
  type AllocationRuleBasis,
  type AllocationRuleRow,
} from '@nova/api-contracts'
import { appError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ensureProfitDictionary } from '../profit-items'

const DAY_MS = 86_400_000

export interface RuleRecord {
  id: string
  feeItemId: string
  basis: string
  manualWeights: unknown
  effectiveMonth: Date
  version: number
  createdBy: string | null
  updatedAt: Date
}

/** 下一个月的第一天（UTC）。 */
export const nextMonthStart = (month: string): Date => {
  const start = monthStartDate(month)
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
}

export const toWeights = (value: unknown): Record<string, number> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const [key, weight] of Object.entries(value as Record<string, unknown>)) if (typeof weight === 'number' && weight > 0) out[key] = weight
  return out
}

/** 这些月份里，哪些有已关账（CLOSED）的期间覆盖（任一店铺的期间与该月有重叠即算）。 */
export async function lockedMonths(prisma: PrismaService, tenantId: string, months: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(months)].sort()
  if (unique.length === 0) return new Set()
  const first = monthStartDate(unique[0] as string)
  const last = nextMonthStart(unique[unique.length - 1] as string)
  const periods = await prisma.accountingPeriod.findMany({
    where: { tenantId, status: 'CLOSED', periodStart: { lt: last }, periodEnd: { gte: first } },
    select: { periodStart: true, periodEnd: true },
    take: 2000,
  })
  const locked = new Set<string>()
  for (const month of unique) {
    const start = monthStartDate(month)
    const end = nextMonthStart(month)
    if (periods.some(period => period.periodStart < end && period.periodEnd >= start)) locked.add(month)
  }
  return locked
}

export interface FeeItemInfo extends AllocationFeeItemOption {
  group: string
}

/**
 * 可以配置分摊规则的费用项：利润项目字典里接收交易明细、且不是销售额与代收代缴税的项目（销售额与税不是“费用”）。
 * 第一次读取会生成第一版字典；近 90 天没有 SKU 的费用明细笔数按映射到该项目的交易类型汇总。
 */
export async function loadFeeItems(prisma: PrismaService, tenantId: string, userId: string | null, now: Date): Promise<FeeItemInfo[]> {
  await ensureProfitDictionary(prisma, tenantId, userId, now)
  const [items, mappings, seen] = await Promise.all([
    prisma.profitItem.findMany({
      where: { tenantId },
      select: { id: true, parentId: true, name: true, group: true, systemKey: true, sort: true, level: true },
      orderBy: [{ level: 'asc' }, { sort: 'asc' }],
      take: 1000,
    }),
    prisma.profitItemMapping.findMany({ where: { tenantId }, select: { transactionType: true, itemId: true }, take: PROFIT_ITEM_LIMITS.maxMappings }),
    prisma.fbaFeeEvent.groupBy({
      by: ['feeCategory', 'feeSubtype'],
      where: { tenantId, OR: [{ sellerSku: null }, { sellerSku: '' }], postedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
      _count: { _all: true },
      orderBy: [{ feeCategory: 'asc' }, { feeSubtype: 'asc' }],
      take: PROFIT_ITEM_LIMITS.discoverMax,
    }),
  ])
  const byId = new Map(items.map(item => [item.id, item]))
  const nodes = new Map(items.map(item => [item.id, { id: item.id, parentId: item.parentId, group: item.group, systemKey: item.systemKey }]))
  const counts = new Map(seen.map(row => [transactionTypeKey(row.feeCategory, row.feeSubtype), row._count._all]))
  const perItem = new Map<string, number>()
  for (const mapping of mappings) perItem.set(mapping.itemId, (perItem.get(mapping.itemId) ?? 0) + (counts.get(mapping.transactionType) ?? 0))
  const pathOf = (id: string): string => {
    const names: string[] = []
    let current = byId.get(id)
    for (let depth = 0; current && depth < 4; depth += 1) {
      names.unshift(current.name)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return names.join(' / ')
  }
  const options: FeeItemInfo[] = []
  for (const item of items) {
    const target = effectiveTargetOf(nodes.get(item.id) as { id: string; parentId: string | null; group: string; systemKey: string | null }, nodes)
    if (target === null || target === 'REVENUE' || target === 'EXCLUDED') continue
    options.push({ id: item.id, name: item.name, path: pathOf(item.id), group: item.group, storeLevelLines90d: perItem.get(item.id) ?? 0 })
  }
  return options.sort((a, b) => b.storeLevelLines90d - a.storeLevelLines90d || a.path.localeCompare(b.path))
}

export async function requireFeeItem(prisma: PrismaService, tenantId: string, userId: string | null, feeItemId: string, now: Date): Promise<FeeItemInfo> {
  const hit = (await loadFeeItems(prisma, tenantId, userId, now)).find(item => item.id === feeItemId)
  if (!hit) throw appError('VALIDATION_FAILED', '这个费用项不存在或不能配置分摊（销售额与代收代缴税不是费用）', { fieldErrors: { feeItemId: ['请选择可分摊的费用项'] } })
  return hit
}

export function ruleRow(record: RuleRecord, item: { name: string; path: string } | undefined, locked: boolean): AllocationRuleRow {
  const basis = record.basis as AllocationRuleBasis
  return {
    id: record.id,
    feeItemId: record.feeItemId,
    feeItemName: item?.name ?? '（已删除的费用项）',
    feeItemPath: item?.path ?? '',
    basis,
    basisLabel: ALLOCATION_RULE_BASIS_LABEL[basis] ?? record.basis,
    manualWeights: toWeights(record.manualWeights),
    effectiveMonth: monthText(record.effectiveMonth),
    version: record.version,
    locked,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt.toISOString(),
  }
}
