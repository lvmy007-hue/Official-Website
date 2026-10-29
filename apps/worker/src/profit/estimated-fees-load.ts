import {
  effectiveTargetOf,
  isEstimatedFeeTarget,
  isEstimatedScopeType,
  isLineTarget,
  unmappedKeyOf,
  type DictionaryResolution,
  type EstimatedMode,
  type EstimatedPeriod,
  type EstimatedStatus,
} from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { actualDayKey, actualMonthKey, EMPTY_ESTIMATES, type EstimateInputs, type EstimateRule } from './estimated-fees'

// 预估与自定义费用的读取（P6-20）：规则来自 EstimatedFee；冲销用的“实际费用出账”按店铺、项目键、日（及月）取一份集合。都在租户上下文里读。

type Db = Pick<PrismaClient, 'estimatedFee' | 'profitItem' | 'fbaProduct' | '$queryRawUnsafe'>
type Resolver = (category: string, subtype: string | null | undefined) => DictionaryResolution
const CAP = 20_000
const dayText = (value: Date) => value.toISOString().slice(0, 10)
const modeOf = (value: string): EstimatedMode | null => (value === 'FIXED' || value === 'PERCENT_OF_SALES' ? value : null)
const periodOf = (value: string): EstimatedPeriod | null => (value === 'DAILY' || value === 'MONTHLY' ? value : null)
const statusOf = (value: string): EstimatedStatus | null => (value === 'ACTIVE' || value === 'INACTIVE' ? value : null)

const LOCAL_DAY = `((e."postedAt" AT TIME ZONE 'UTC') AT TIME ZONE $4)::date`
const ACTUAL_SQL = `
SELECT DISTINCT e."sellerAccountId" AS "sellerAccountId", e."feeCategory" AS "category", e."feeSubtype" AS "subtype", to_char(${LOCAL_DAY}, 'YYYY-MM-DD') AS "day"
FROM "FbaFeeEvent" e
WHERE e."tenantId" = $1 AND e."amount" <> 0
  AND e."postedAt" >= (($2::date)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'
  AND e."postedAt" < ((($3::date) + 1)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'`

/**
 * 读出在 range 内有效的规则、冲销用的实际费用集合、品类对照。企业没有字典、没有规则、规则的费用项不再接收花费（被改成广告等）时返回空。
 * 按月的规则要看整月，所以实际费用从起始月第一天读起。
 */
export async function loadEstimates(db: Db, tenantId: string, range: { from: string; to: string }, timeZone: string, resolve: Resolver | null): Promise<EstimateInputs> {
  if (!resolve) return EMPTY_ESTIMATES
  const fees = await db.estimatedFee.findMany({
    where: { tenantId, status: 'ACTIVE', from: { lte: new Date(`${range.to}T00:00:00Z`) }, OR: [{ to: null }, { to: { gte: new Date(`${range.from}T00:00:00Z`) } }] },
    select: { id: true, itemId: true, scopeType: true, scopeId: true, mode: true, value: true, period: true, from: true, to: true, status: true },
    orderBy: { id: 'asc' },
    take: CAP,
  })
  if (fees.length === 0) return EMPTY_ESTIMATES
  const items = await db.profitItem.findMany({ where: { tenantId }, select: { id: true, parentId: true, group: true, systemKey: true }, take: 1000 })
  const byId = new Map(items.map(item => [item.id, item]))
  const rules: EstimateRule[] = []
  for (const fee of fees) {
    const item = byId.get(fee.itemId)
    const target = item ? effectiveTargetOf(item, byId) : null
    const mode = modeOf(fee.mode)
    const period = periodOf(fee.period)
    const status = statusOf(fee.status)
    if (!item || !isEstimatedFeeTarget(target) || !isEstimatedScopeType(fee.scopeType) || !mode || !period || !status) continue
    rules.push({
      id: fee.id,
      itemId: fee.itemId,
      scopeType: fee.scopeType,
      scopeId: fee.scopeId,
      mode,
      value: Number(fee.value.toString()),
      period,
      from: dayText(fee.from),
      to: fee.to ? dayText(fee.to) : null,
      status,
      itemKey: item.id,
      target,
      actualKeys: [item.id, ...(item.systemKey && isLineTarget(item.systemKey) ? [unmappedKeyOf(item.systemKey)] : [])],
    })
  }
  if (rules.length === 0) return EMPTY_ESTIMATES

  const wanted = new Set(rules.flatMap(rule => rule.actualKeys))
  const actualFrom = rules.some(rule => rule.period === 'MONTHLY') ? `${range.from.slice(0, 7)}-01` : range.from
  const events = await db.$queryRawUnsafe<Array<{ sellerAccountId: string; category: string; subtype: string | null; day: string }>>(ACTUAL_SQL, tenantId, actualFrom, range.to, timeZone)
  const actual = new Set<string>()
  for (const event of events) {
    const key = resolve(event.category, event.subtype).itemKey
    if (!wanted.has(key)) continue
    actual.add(actualDayKey(event.sellerAccountId, key, event.day))
    actual.add(actualMonthKey(event.sellerAccountId, key, event.day))
  }

  const categories = new Map<string, Set<string>>()
  if (rules.some(rule => rule.scopeType === 'CATEGORY')) {
    const products = await db.fbaProduct.findMany({ where: { tenantId }, select: { sellerSku: true, productType: true, categoryPath: true }, take: CAP })
    for (const product of products) {
      const names = categories.get(product.sellerSku) ?? new Set<string>()
      if (product.productType) names.add(product.productType)
      if (product.categoryPath) names.add(product.categoryPath)
      categories.set(product.sellerSku, names)
    }
  }
  return { rules, actual, categories }
}
