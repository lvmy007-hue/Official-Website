import {
  FX_BASE_CURRENCY,
  buildDictionaryResolver,
  type DictionaryResolution,
  FX_FALLBACK_MAX_DAYS,
  INVENTORY_COSTING_SETTING,
  PROFIT_CURRENCY,
  normalizeCosting,
  pickEffectiveRate,
  resolveRateOn,
  type FxRow,
  type InventoryCosting,
} from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { CostLayer } from './costing'
import type { AdsInfo, FxLookup, SkuStreams } from './types'

// 利润日表用到的非聚合数据（P2b-09）：存货计价设置、成本版本与入库批次、汇率、广告花费。都在租户上下文里读。

type Db = Pick<PrismaClient, 'costVersion' | 'purchaseOrderLine' | 'landedCostAllocation' | 'fxRate' | 'adsProfile' | 'adsMetric' | 'tenantSetting'>
type DictionaryDb = Pick<PrismaClient, 'profitItem' | 'profitItemMapping'>
const DAY_MS = 86_400_000
const CAP = 20_000
const CHUNK = 500
const dayText = (value: Date) => value.toISOString().slice(0, 10)
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
const chunks = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))

/**
 * 利润项目字典（P6-18）：读出企业的项目与映射，生成交易明细的解析器。企业还没有字典（没人打开过字典页）返回 null，派生任务按内置口径归类、不写按项目拆分的金额。
 */
export async function loadDictionary(db: DictionaryDb, tenantId: string): Promise<((category: string, subtype: string | null | undefined) => DictionaryResolution) | null> {
  const items = await db.profitItem.findMany({ where: { tenantId }, select: { id: true, parentId: true, group: true, systemKey: true }, take: 1000 })
  if (items.length === 0) return null
  const mappings = await db.profitItemMapping.findMany({ where: { tenantId }, select: { transactionType: true, itemId: true }, take: 20_000 })
  return buildDictionaryResolver(items, mappings)
}

/** 企业设置的存货计价；没设置用默认值；取值不合法用默认值并返回 valid=false（派生结果里打标记）。 */
export async function loadCosting(db: Pick<Db, 'tenantSetting'>, tenantId: string): Promise<{ costing: InventoryCosting; valid: boolean }> {
  const row = await db.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: INVENTORY_COSTING_SETTING }, select: { valueJson: true } })
  return normalizeCosting(row?.valueJson)
}

export interface CostStreams {
  streams: Map<string, SkuStreams>
  /** 只有草稿状态成本版本的 SKU（没有任何生效版本）。 */
  draftOnly: Set<string>
  currencies: Set<string>
  /** 最早的批次日期，用来决定要往前读多少天销售才能接上先进先出等方法。 */
  earliest: string | null
}

/**
 * 生效（ACTIVE）的成本版本拆成三条成本流（采购、头程、其他）。入库批次的数量：采购收货生成的版本取采购单对应 SKU 的已收数量，
 * 头程分摊生成的版本取分摊的件数；手工与文件导入的版本没有数量，按价格版本处理（见 costing.ts）。草稿版本不参与计价，只用来提示。
 */
export async function loadCostStreams(db: Db, tenantId: string): Promise<CostStreams> {
  const versions = await db.costVersion.findMany({
    where: { tenantId, status: 'ACTIVE' },
    orderBy: [{ sku: 'asc' }, { versionNo: 'asc' }],
    take: CAP,
    select: { id: true, sku: true, effectiveFrom: true, currency: true, unitProductCost: true, unitFirstMileCost: true, unitDutyCost: true, unitOtherCost: true, source: true, sourceDocId: true },
  })
  const poIds = [...new Set(versions.filter(item => item.source === 'PURCHASE_RECEIPT' && item.sourceDocId).map(item => item.sourceDocId as string))]
  const received = new Map<string, number>()
  for (const part of chunks(poIds, CHUNK)) {
    const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: part } }, select: { purchaseOrderId: true, sellerSku: true, receivedQuantity: true }, take: CAP })
    for (const line of lines) received.set(`${line.purchaseOrderId}|${line.sellerSku}`, (received.get(`${line.purchaseOrderId}|${line.sellerSku}`) ?? 0) + line.receivedQuantity)
  }
  const allocated = new Map<string, number>()
  const fmIds = versions.filter(item => item.source === 'FIRST_MILE_ALLOCATION').map(item => item.id)
  for (const part of chunks(fmIds, CHUNK)) {
    const rows = await db.landedCostAllocation.findMany({ where: { tenantId, costVersionId: { in: part } }, select: { costVersionId: true, quantity: true }, take: CAP })
    for (const row of rows) if (row.costVersionId) allocated.set(row.costVersionId, (allocated.get(row.costVersionId) ?? 0) + row.quantity)
  }

  const streams = new Map<string, SkuStreams>()
  const currencies = new Set<string>()
  let earliest: string | null = null
  for (const version of versions) {
    const quantity =
      version.source === 'PURCHASE_RECEIPT' && version.sourceDocId
        ? (received.get(`${version.sourceDocId}|${version.sku}`) ?? 0)
        : version.source === 'FIRST_MILE_ALLOCATION'
          ? (allocated.get(version.id) ?? 0)
          : null
    const date = dayText(version.effectiveFrom)
    const entry = streams.get(version.sku) ?? { product: [], firstMile: [], other: [], duty: [] }
    const add = (stream: CostLayer[], cost: ReturnType<typeof num>) => {
      if (cost === null) return
      stream.push({ date, unitCost: cost, currency: version.currency, quantity })
      currencies.add(version.currency)
      if (quantity !== null && (earliest === null || date < earliest)) earliest = date
    }
    add(entry.product, num(version.unitProductCost))
    add(entry.firstMile, num(version.unitFirstMileCost))
    add(entry.duty as CostLayer[], num(version.unitDutyCost))
    add(entry.other, num(version.unitOtherCost))
    streams.set(version.sku, entry)
  }
  const drafts = await db.costVersion.findMany({ where: { tenantId, status: 'DRAFT' }, select: { sku: true }, distinct: ['sku'], take: CAP })
  const draftOnly = new Set(drafts.map(item => item.sku).filter(sku => !(streams.get(sku)?.product.length ?? 0)))
  return { streams, draftOnly, currencies, earliest }
}

/**
 * 汇率（1 美元折合多少外币）：手工覆盖优先，其次当天实际获取的，最后才是沿用前值的；当天没有就向前最多 FX_FALLBACK_MAX_DAYS 天，再没有就是缺失。
 * 美元对美元恒为 1。
 */
export async function loadFx(db: Pick<Db, 'fxRate'>, tenantId: string, currencies: Iterable<string>, range: { from: string; to: string }): Promise<FxLookup> {
  const quotes = [...new Set([...currencies].filter(code => code !== FX_BASE_CURRENCY))]
  const byCurrency = new Map<string, Map<string, FxRow>>()
  if (quotes.length > 0) {
    const rows = await db.fxRate.findMany({
      where: {
        tenantId,
        baseCurrency: FX_BASE_CURRENCY,
        quoteCurrency: { in: quotes },
        rateDate: { gte: new Date(Date.parse(`${range.from}T00:00:00Z`) - FX_FALLBACK_MAX_DAYS * DAY_MS), lte: new Date(`${range.to}T00:00:00Z`) },
      },
      select: { quoteCurrency: true, rateDate: true, rate: true, source: true, isFallback: true, isManualOverride: true },
      take: CAP,
    })
    const grouped = new Map<string, Map<string, FxRow[]>>()
    for (const row of rows) {
      const days = grouped.get(row.quoteCurrency) ?? new Map<string, FxRow[]>()
      const day = dayText(row.rateDate)
      days.set(day, [...(days.get(day) ?? []), { rateDate: day, rate: Number(row.rate.toString()), source: row.source, isFallback: row.isFallback, isManualOverride: row.isManualOverride }])
      grouped.set(row.quoteCurrency, days)
    }
    for (const [currency, days] of grouped) byCurrency.set(currency, new Map([...days].map(([day, list]) => [day, pickEffectiveRate(list) as FxRow])))
  }
  return (currency, day) => {
    if (currency === FX_BASE_CURRENCY) return { rate: 1, source: 'SAME_CURRENCY', carriedForward: false }
    const days = byCurrency.get(currency)
    const hit = days ? resolveRateOn(day, days) : null
    return hit ? { rate: hit.row.rate, source: hit.row.source, carriedForward: hit.carriedForward || hit.row.isFallback } : null
  }
}

/**
 * 每个店铺的广告花费：只取已绑定店铺的广告账户。有花费记录的日期范围内，没有记录的日子算 0；范围之外是“不知道”（返回给调用方当作没有数据）。
 * 非美元账户不计入（利润日表目前只算美元）。reportDate 当作该店铺的日历日。
 */
export async function loadAds(db: Pick<Db, 'adsProfile' | 'adsMetric'>, tenantId: string, range: { from: string; to: string }): Promise<Map<string, AdsInfo>> {
  const out = new Map<string, AdsInfo>()
  const profiles = await db.adsProfile.findMany({ where: { tenantId, sellerAccountId: { not: null } }, select: { id: true, sellerAccountId: true, currencyCode: true }, take: 2000 })
  const storeOf = new Map(profiles.map(profile => [profile.id, profile.sellerAccountId as string]))
  const info = (store: string) => out.get(store) ?? out.set(store, { first: null, last: null, byDay: new Map(), nonUsd: false }).get(store)!
  const usdIds: string[] = []
  for (const profile of profiles) {
    if (profile.currencyCode === PROFIT_CURRENCY) usdIds.push(profile.id)
    else info(profile.sellerAccountId as string).nonUsd = true
  }
  if (usdIds.length === 0) return out
  const spans = await db.adsMetric.groupBy({
    by: ['adsProfileId'],
    where: { tenantId, adsProfileId: { in: usdIds }, entityType: 'CAMPAIGN', cost: { not: null } },
    _min: { reportDate: true },
    _max: { reportDate: true },
  })
  for (const span of spans) {
    const entry = info(storeOf.get(span.adsProfileId) as string)
    const first = span._min.reportDate ? dayText(span._min.reportDate) : null
    const last = span._max.reportDate ? dayText(span._max.reportDate) : null
    if (first && (entry.first === null || first < entry.first)) entry.first = first
    if (last && (entry.last === null || last > entry.last)) entry.last = last
  }
  const sums = await db.adsMetric.groupBy({
    by: ['adsProfileId', 'reportDate'],
    where: {
      tenantId,
      adsProfileId: { in: usdIds },
      entityType: 'CAMPAIGN',
      cost: { not: null },
      reportDate: { gte: new Date(`${range.from}T00:00:00Z`), lt: new Date(Date.parse(`${range.to}T00:00:00Z`) + DAY_MS) },
    },
    _sum: { cost: true },
  })
  for (const row of sums) {
    const entry = info(storeOf.get(row.adsProfileId) as string)
    const day = dayText(row.reportDate)
    entry.byDay.set(day, (entry.byDay.get(day) ?? 0) + (num(row._sum.cost) ?? 0))
  }
  return out
}
