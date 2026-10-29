import { Injectable } from '@nestjs/common'
import {
  PROFIT_DICTIONARY_KIND,
  PROFIT_ITEM_GROUP_LABEL,
  PROFIT_ITEM_LIMITS,
  PROFIT_ITEM_MANAGE,
  PROFIT_ITEM_READ,
  ProfitUnmappedQuerySchema,
  defaultTargetOfType,
  effectiveTargetOf,
  transactionTypeKey,
  transactionTypeLabel,
  type ProfitItemGroup,
  type ProfitItemRow,
  type ProfitItemsResponse,
  type ProfitMappingRow,
  type ProfitUnmappedResponse,
  type ProfitUnmappedRow,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { ensureProfitDictionary } from './profit-items-seed'

const DAY_MS = 86_400_000
export const NO_MANAGE_REASON = '修改利润项目字典需要 finance.profititem.manage 权限'
const NOTE =
  '利润项目字典决定利润分析里每笔交易归到哪个项目：映射与新项目保存后，利润日表在下一次重算（每 6 小时近 45 天）时才按新口径拆分；已关账的期间不重算，不受影响。没有映射的交易类型仍按内置口径计入利润，不会丢。'

export interface SeenType {
  transactionType: string
  count30d: number
  lastPostedAt: Date | null
}

/** 字典页的读取：项目树、映射、未映射的交易类型；第一次打开会自动生成第一版字典。 */
@Injectable()
export class ProfitItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 最近 90 天出现过的交易类型（分类/子类型）与近 30 天笔数、最近入账时间；类型数有上限。 */
  async seenTypes(tenantId: string, now: Date): Promise<SeenType[]> {
    const countFrom = new Date(now.getTime() - PROFIT_ITEM_LIMITS.countDays * DAY_MS)
    const [all, recent] = await Promise.all([
      this.prisma.fbaFeeEvent.groupBy({
        by: ['feeCategory', 'feeSubtype'],
        where: { tenantId, postedAt: { gte: new Date(now.getTime() - PROFIT_ITEM_LIMITS.discoverDays * DAY_MS) } },
        _max: { postedAt: true },
        orderBy: [{ feeCategory: 'asc' }, { feeSubtype: 'asc' }],
        take: PROFIT_ITEM_LIMITS.discoverMax,
      }),
      this.prisma.fbaFeeEvent.groupBy({
        by: ['feeCategory', 'feeSubtype'],
        where: { tenantId, postedAt: { gte: countFrom } },
        _count: { _all: true },
        orderBy: [{ feeCategory: 'asc' }, { feeSubtype: 'asc' }],
        take: PROFIT_ITEM_LIMITS.discoverMax,
      }),
    ])
    const counts = new Map(recent.map(row => [transactionTypeKey(row.feeCategory, row.feeSubtype), row._count._all]))
    return all.map(row => {
      const transactionType = transactionTypeKey(row.feeCategory, row.feeSubtype)
      return { transactionType, count30d: counts.get(transactionType) ?? 0, lastPostedAt: row._max.postedAt }
    })
  }

  async read(req: RequestWithContext, now = new Date()): Promise<ProfitItemsResponse> {
    const context = await this.context.authorize(req, PROFIT_ITEM_READ)
    const tenantId = context.tenantId
    const seeded = await ensureProfitDictionary(this.prisma, tenantId, context.userId, now)
    const [items, mappings, active, seen] = await Promise.all([
      this.prisma.profitItem.findMany({ where: { tenantId }, orderBy: [{ level: 'asc' }, { sort: 'asc' }, { name: 'asc' }], take: 1000 }),
      this.prisma.profitItemMapping.findMany({ where: { tenantId }, orderBy: { transactionType: 'asc' }, take: PROFIT_ITEM_LIMITS.maxMappings }),
      this.prisma.metricVersion.findFirst({ where: { tenantId, kind: PROFIT_DICTIONARY_KIND, status: 'ACTIVE' }, select: { versionNo: true } }),
      this.seenTypes(tenantId, now),
    ])
    const countOf = new Map(seen.map(type => [type.transactionType, type.count30d]))
    const mappedTypes = new Set(mappings.map(mapping => mapping.transactionType))
    const nodes = new Map(items.map(item => [item.id, { id: item.id, parentId: item.parentId, group: item.group, systemKey: item.systemKey }]))
    const perItem = new Map<string, { types: number; tx: number }>()
    for (const mapping of mappings) {
      const entry = perItem.get(mapping.itemId) ?? { types: 0, tx: 0 }
      entry.types += 1
      entry.tx += countOf.get(mapping.transactionType) ?? 0
      perItem.set(mapping.itemId, entry)
    }
    const canManage = hasPermission(context.permissions, PROFIT_ITEM_MANAGE)
    const rows: ProfitItemRow[] = items.map(item => ({
      id: item.id,
      parentId: item.parentId,
      level: item.level,
      name: item.name,
      group: item.group as ProfitItemGroup,
      groupLabel: PROFIT_ITEM_GROUP_LABEL[item.group as ProfitItemGroup] ?? item.group,
      sign: item.sign === -1 ? -1 : 1,
      isSystem: item.isSystem,
      systemKey: item.systemKey,
      sort: item.sort,
      txCount30d: perItem.get(item.id)?.tx ?? 0,
      mappedTypes: perItem.get(item.id)?.types ?? 0,
      acceptsMapping: effectiveTargetOf(nodes.get(item.id) as { id: string; parentId: string | null; group: string; systemKey: string | null }, nodes) !== null,
    }))
    const mappingRows: ProfitMappingRow[] = mappings.map(mapping => ({
      transactionType: mapping.transactionType,
      label: transactionTypeLabel(mapping.transactionType),
      itemId: mapping.itemId,
      txCount30d: countOf.get(mapping.transactionType) ?? 0,
    }))
    return {
      version: active?.versionNo ?? 1,
      items: rows,
      mappings: mappingRows,
      unmappedCount: seen.filter(type => !mappedTypes.has(type.transactionType)).length,
      totalTxCount30d: seen.reduce((sum, type) => sum + type.count30d, 0),
      canManage,
      manageBlockedReason: canManage ? null : NO_MANAGE_REASON,
      limits: { maxItems: PROFIT_ITEM_LIMITS.maxItems, maxDepth: PROFIT_ITEM_LIMITS.maxDepth, nameMax: PROFIT_ITEM_LIMITS.nameMax },
      seeded,
      note: NOTE,
    }
  }

  /** 没有映射的交易类型（最近 90 天出现过）：按近 30 天笔数从多到少，附内置口径下归到的项目。 */
  async unmapped(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitUnmappedResponse> {
    const context = await this.context.authorize(req, PROFIT_ITEM_READ)
    const query = ProfitUnmappedQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    await ensureProfitDictionary(this.prisma, tenantId, context.userId, now)
    const [items, mappings, seen] = await Promise.all([
      this.prisma.profitItem.findMany({ where: { tenantId, isSystem: true }, select: { id: true, name: true, systemKey: true }, take: 1000 }),
      this.prisma.profitItemMapping.findMany({ where: { tenantId }, select: { transactionType: true }, take: PROFIT_ITEM_LIMITS.maxMappings }),
      this.seenTypes(tenantId, now),
    ])
    const mapped = new Set(mappings.map(mapping => mapping.transactionType))
    const byKey = new Map(items.map(item => [item.systemKey, item]))
    const rows: ProfitUnmappedRow[] = seen
      .filter(type => !mapped.has(type.transactionType))
      .map(type => {
        const target = byKey.get(defaultTargetOfType(type.transactionType))
        return {
          transactionType: type.transactionType,
          label: transactionTypeLabel(type.transactionType),
          txCount30d: type.count30d,
          defaultItemId: target?.id ?? null,
          defaultItemName: target?.name ?? defaultTargetOfType(type.transactionType),
          lastPostedAt: type.lastPostedAt?.toISOString() ?? null,
        }
      })
    const sign = query.sort.dir === 'asc' ? 1 : -1
    rows.sort((a, b) => sign * (a.txCount30d - b.txCount30d) || a.transactionType.localeCompare(b.transactionType))
    const start = (query.page - 1) * query.pageSize
    return {
      items: rows.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: rows.length,
      note: '没有映射的交易类型仍按内置口径计入利润日表（不会丢），这里列出来提醒补全；补全后在下一次利润日表重算时按新项目拆分。',
    }
  }
}
