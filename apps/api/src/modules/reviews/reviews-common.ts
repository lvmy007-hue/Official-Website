import type { CursorPageInfo, ReviewStoreRef, ReviewsQuery } from '@nova/api-contracts'
import { AppError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'
import { storeWhere, type ResolvedScope } from '../auth'
import { validZone } from '../overview'

// 评价与反馈模块的公共部分（P4-13）：偏移游标（签名并绑定全部条件，与竞品、定价模块同一做法；模块之间只能经 index 引用，这里各留一份很小的实现）、可见店铺、取数小工具。

let codec: ReturnType<typeof createCursorCodec> | undefined
const cursorCodec = () => (codec ??= createCursorCodec(resolveCursorKey()))
const invalid = () => new AppError(400, 'CURSOR_INVALID', '翻页游标无效或查询条件已变化，请从第一页重新加载')

export function decodeOffset(token: string | undefined, binding: string): number {
  if (!token) return 0
  const payload = cursorCodec().decode(token)
  const offset = Number(payload.k)
  if (payload.b !== binding || payload.f !== 'offset' || !Number.isInteger(offset) || offset < 0) throw invalid()
  return offset
}

export function pageOf<T>(items: readonly T[], offset: number, pageSize: number, binding: string): { page: T[]; pageInfo: CursorPageInfo } {
  const page = items.slice(offset, offset + pageSize)
  const end = offset + page.length
  const hasMore = end < items.length
  const nextCursor = hasMore ? cursorCodec().encode({ v: 1, b: binding, f: 'offset', r: 'asc', t: 'n', k: String(end), i: '' }) : null
  return { page, pageInfo: { pageSize, nextCursor, hasMore, approxTotal: items.length } }
}

/** 页签服务的输入：stores 是成员范围内的全部店铺（下拉用），visible 是按店铺筛选收窄后的店铺（评分与请求评价页签用它读数据）。 */
export interface ReviewsTabInput {
  tenantId: string
  scope: ResolvedScope
  permissions: readonly string[]
  query: ReviewsQuery
  rawQuery: Record<string, string>
  stores: ReviewStoreRef[]
  visible: ReviewStoreRef[]
  now: Date
}

/** 范围内的店铺（按名称排序）；店铺不多，上限 500。 */
export async function storesOf(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<ReviewStoreRef[]> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...storeWhere(scope, 'id') },
    select: { id: true, displayName: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName }))
}

export const SEP = '\u001f'
export const keyOf = (storeId: string, value: string) => `${storeId}${SEP}${value}`
export const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
export const ymd = (date: Date): string => date.toISOString().slice(0, 10)
export const DAY_MS = 86_400_000
export const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
export const textCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** 企业时区；取不到按 UTC。 */
export async function zoneOf(prisma: PrismaService, tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  return validZone(tenant?.timezone)
}

/** 成员显示名（用户编号 → 名称）；取不到的不在表里。 */
export async function memberNames(prisma: PrismaService, tenantId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(id => id !== ''))]
  if (ids.length === 0) return new Map()
  const rows = await prisma.membership.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, user: { select: { displayName: true, email: true } } }, take: 500 })
  return new Map(rows.map(row => [row.userId, row.user.displayName || row.user.email]))
}

/** 商品标题（同店铺同 ASIN 取排在最前的 SKU）；ASIN 多时分批读取。 */
export async function titlesOf(prisma: PrismaService, tenantId: string, storeIds: readonly string[], asins: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (storeIds.length === 0 || asins.length === 0) return out
  for (const part of chunk([...new Set(asins)], 500)) {
    const rows = await prisma.fbaProduct.findMany({
      where: { tenantId, sellerAccountId: { in: [...storeIds] }, asin: { in: part } },
      select: { sellerAccountId: true, asin: true, title: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }],
      take: 19_999,
    })
    for (const row of rows) if (!out.has(keyOf(row.sellerAccountId, row.asin))) out.set(keyOf(row.sellerAccountId, row.asin), row.title)
  }
  return out
}
