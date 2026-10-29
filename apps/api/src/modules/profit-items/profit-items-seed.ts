import { randomUUID } from 'node:crypto'
import { PROFIT_DICTIONARY_KIND, PROFIT_ITEM_LIMITS, SYSTEM_PROFIT_ITEMS, defaultTargetOfType, transactionTypeKey } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'

// 利润项目字典的第一版（P6-18）：第一次打开字典页时自动生成。
// 一级项目 6 个（分组）、二级项目 = 利润桥各项（外加代收代缴税）；交易类型映射按内置的九类归并规则生成：
// 取最近 180 天费用事件里出现过的“分类/子类型”，逐个按内置口径归到对应的系统项目。之后新出现的类型不会自动映射，会在“未映射”里列出提醒补全。
// 并发打开时靠唯一键（企业 + systemKey、企业 + 交易类型、企业 + 种类 + 版本号）去重，输的一方什么也不写。

const SEED_DAYS = 180
const DAY_MS = 86_400_000

export interface DictionarySnapshot {
  items: Array<{ id: string; parentId: string | null; level: number; name: string; group: string; sign: number; isSystem: boolean; systemKey: string | null; sort: number }>
  mappings: Array<{ transactionType: string; itemId: string }>
}

/** 版本快照：该版本字典的完整内容，用来回看与审计。 */
export const snapshotOf = (snapshot: DictionarySnapshot): Prisma.InputJsonObject => ({
  items: snapshot.items.map(item => ({ ...item })),
  mappings: snapshot.mappings.map(mapping => ({ ...mapping })),
})

/** 企业还没有字典时生成第一版；返回是否由这次调用生成。 */
export async function ensureProfitDictionary(prisma: PrismaService, tenantId: string, userId: string | null, now: Date = new Date()): Promise<boolean> {
  const existing = await prisma.metricVersion.findFirst({ where: { tenantId, kind: PROFIT_DICTIONARY_KIND }, select: { id: true } })
  if (existing) return false
  return prisma.$transaction(
    async tx => {
      const again = await tx.metricVersion.findFirst({ where: { tenantId, kind: PROFIT_DICTIONARY_KIND }, select: { id: true } })
      if (again) return false
      const seen = await tx.fbaFeeEvent.groupBy({
        by: ['feeCategory', 'feeSubtype'],
        where: { tenantId, postedAt: { gte: new Date(now.getTime() - SEED_DAYS * DAY_MS) } },
        _count: { _all: true },
        orderBy: [{ feeCategory: 'asc' }, { feeSubtype: 'asc' }],
        take: PROFIT_ITEM_LIMITS.discoverMax,
      })
      const ids = new Map(SYSTEM_PROFIT_ITEMS.map(item => [item.key, randomUUID()]))
      const row = (item: (typeof SYSTEM_PROFIT_ITEMS)[number], level: number) => ({
        id: ids.get(item.key) as string,
        tenantId,
        parentId: item.parent === null ? null : (ids.get(item.parent) as string),
        level,
        name: item.name,
        group: item.group,
        sign: item.sign,
        isSystem: true,
        systemKey: item.key,
        sort: item.sort,
      })
      await tx.profitItem.createMany({ data: SYSTEM_PROFIT_ITEMS.filter(item => item.parent === null).map(item => row(item, 1)), skipDuplicates: true })
      await tx.profitItem.createMany({ data: SYSTEM_PROFIT_ITEMS.filter(item => item.parent !== null).map(item => row(item, 2)), skipDuplicates: true })
      // 并发时可能已有别人写入的系统项目（编号不同）：以数据库里的为准
      const items = await tx.profitItem.findMany({
        where: { tenantId },
        select: { id: true, parentId: true, level: true, name: true, group: true, sign: true, isSystem: true, systemKey: true, sort: true },
        take: 1000,
      })
      const byKey = new Map(items.map(item => [item.systemKey, item.id]))
      const mappings = seen.map(type => {
        const transactionType = transactionTypeKey(type.feeCategory, type.feeSubtype)
        return { tenantId, transactionType, itemId: byKey.get(defaultTargetOfType(transactionType)) as string }
      })
      await tx.profitItemMapping.createMany({ data: mappings, skipDuplicates: true })
      await tx.metricVersion.createMany({
        data: [
          {
            tenantId,
            kind: PROFIT_DICTIONARY_KIND,
            versionNo: 1,
            status: 'ACTIVE',
            effectiveFrom: now,
            createdBy: userId,
            config: snapshotOf({ items, mappings: mappings.map(({ transactionType, itemId }) => ({ transactionType, itemId })) }),
          },
        ],
        skipDuplicates: true,
      })
      return true
    },
    { timeout: 30_000, maxWait: 10_000 },
  )
}
