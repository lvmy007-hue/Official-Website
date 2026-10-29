import type { PrismaClient } from '@prisma/client'

// 预警规则范围的展开与静默时段（P5-01，09 章 9.1 规则配置）。
// 评估器只认 scope.sellerAccountIds（店铺）与 scope.skus（SKU）；规则页上配置的“主体”“品类”在每轮评估前展开成店铺与 SKU，
// 这样主体下新增的店铺、品类下新增的商品不用改规则就自动包含在内。
// 展开后如果一个也找不到，用“匹配不到任何对象”的占位值，而不是空列表——空列表在评估器里等于“不限制”，会让规则对全部对象报警。

const NO_MATCH = '__NO_MATCH__'
const DEFAULT_ZONE = 'America/Los_Angeles'
const PRODUCT_LIMIT = 5000
const STORE_LIMIT = 1000

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : null
}

export type ScopeDb = Pick<PrismaClient, 'sellerAccount' | 'fbaProduct'>

/** 把范围里的主体、品类展开成店铺、SKU；没有主体与品类时原样返回（不访问数据库）。 */
export async function expandRuleScope(db: ScopeDb, tenantId: string, scope: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entities = strings(scope.legalEntityIds)
  const categories = strings(scope.categories)
  if (!entities && !categories) return scope
  const result: Record<string, unknown> = { ...scope }
  const explicitStores = strings(scope.sellerAccountIds)
  let stores = explicitStores
  if (entities) {
    const rows = await db.sellerAccount.findMany({ where: { tenantId, legalEntityId: { in: entities } }, select: { id: true }, take: STORE_LIMIT })
    stores = [...new Set([...(explicitStores ?? []), ...rows.map(row => row.id)])]
    result.sellerAccountIds = stores.length > 0 ? stores : [NO_MATCH]
  }
  if (categories) {
    const products = await db.fbaProduct.findMany({
      where: { tenantId, ...(stores ? { sellerAccountId: { in: stores } } : {}), OR: categories.map(category => ({ categoryPath: { startsWith: category } })) },
      select: { sellerSku: true },
      distinct: ['sellerSku'],
      orderBy: { sellerSku: 'asc' },
      take: PRODUCT_LIMIT,
    })
    const skus = [...new Set([...(strings(scope.skus) ?? []), ...products.map(row => row.sellerSku)])]
    result.skus = skus.length > 0 ? skus : [NO_MATCH]
  }
  return result
}

export interface QuietHours {
  start: string
  end: string
}

export function readQuietHours(scope: Record<string, unknown>): QuietHours | null {
  const quiet = scope.quiet
  if (!quiet || typeof quiet !== 'object') return null
  const { start, end } = quiet as Record<string, unknown>
  const valid = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  return valid(start) && valid(end) && start !== end ? { start, end } : null
}

const minutesOf = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))

function minutesInZone(now: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const pick = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0)
  return pick('hour') * 60 + pick('minute')
}

/** 此刻是否在静默时段内（企业时区；开始晚于结束表示跨午夜，例如 22:00 到 08:00；时区无效回退到美国太平洋时区）。 */
export function isQuietNow(now: Date, zone: string | null | undefined, quiet: QuietHours | null): boolean {
  if (!quiet) return false
  let minutes: number
  try {
    minutes = minutesInZone(now, zone || DEFAULT_ZONE)
  } catch {
    minutes = minutesInZone(now, DEFAULT_ZONE)
  }
  const start = minutesOf(quiet.start)
  const end = minutesOf(quiet.end)
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}
