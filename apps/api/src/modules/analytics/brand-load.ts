import { BA_ROW_LIMIT, type BaAdvertising } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, storeWhere, type ResolvedScope } from '../auth'

// 品牌分析各页共用的取数（P4-04）：只读，一律带企业与数据范围条件。官方没给的列是空（不是 0），这里原样带回 null。

export const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
export const CURRENCY = 'USD'
export const asDay = (text: string) => new Date(`${text}T00:00:00Z`)
export const dayOf = (date: Date) => date.toISOString().slice(0, 10)

/** 价格、金额只认美元：币种存在且不是美元的行当作没给，避免把别的币种当美元加总。 */
export const usd = (value: { toString(): string } | null | undefined, currency: string | null | undefined): number | null => (currency && currency !== CURRENCY ? null : num(value))

export interface ProductRef {
  id: string
  asin: string
  title: string
  brand: string | null
}

/** 范围内的商品（按 ASIN 去重）：标题、品牌与 ASIN 360 编号；品牌分析的“我方 ASIN”就是它。 */
export async function loadProducts(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<ProductRef[]> {
  const rows = await prisma.fbaProduct.findMany({
    where: { tenantId, ...storeWhere(scope) },
    distinct: ['asin'],
    select: { id: true, asin: true, title: true, brand: true },
    orderBy: [{ asin: 'asc' }, { id: 'asc' }],
    take: BA_ROW_LIMIT,
  })
  return rows.map(row => ({ id: row.id, asin: row.asin.toUpperCase(), title: row.title, brand: row.brand?.trim() || null }))
}

/** 已有数据的周期起始日（最近的在前）。model 是五张表之一对应的取数函数。 */
export const toStarts = (rows: ReadonlyArray<{ periodStart: Date }>): string[] => rows.map(row => dayOf(row.periodStart))

/**
 * 搜索词的投放状态（只对页面上显示的词查）：
 * 范围内没有任何广告账户同步过（或没有关键词）→ 尚未接入；有已启用的同名关键词 → 已投放；只有暂停 → 已暂停；否则未投放。
 * 比较时两边都转小写；只比关键词文本，不区分匹配方式。
 */
export async function loadAdvertising(prisma: PrismaService, tenantId: string, scope: ResolvedScope, queries: readonly string[]): Promise<Map<string, BaAdvertising>> {
  const result = new Map<string, BaAdvertising>()
  if (queries.length === 0) return result
  const connected = await prisma.adsKeyword.findFirst({ where: { tenantId, ...adsRelationWhere(scope) }, select: { id: true } })
  if (!connected) {
    for (const query of queries) result.set(query, 'NOT_CONNECTED')
    return result
  }
  const rows = await prisma.adsKeyword.findMany({
    where: { tenantId, ...adsRelationWhere(scope), text: { in: [...queries] }, state: { in: ['ENABLED', 'PAUSED'] } },
    select: { text: true, state: true },
    take: BA_ROW_LIMIT,
  })
  for (const query of queries) result.set(query, 'NONE')
  for (const row of rows) {
    const key = row.text.toLowerCase()
    if (result.get(key) === 'ADVERTISED') continue
    result.set(key, row.state === 'ENABLED' ? 'ADVERTISED' : 'PAUSED')
  }
  return result
}
