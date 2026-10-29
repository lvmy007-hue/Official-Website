import type { PpDimension } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { memberNames } from '../../platform/people'
import { storeWhere } from '../auth'
import { mergeTotals, type SkuGroup, type Totals } from '../profit'
import type { BrAccess } from './business-reports-access.service'
import { bareRef, keyOf, rowIdOf, type Caps } from './product-performance-dim'
import { catalogWhere, loadCatalog, loadPeriod, unitKey, type PeriodFacts, type ProductRef } from './product-performance-load'
import { accOf, calcRow, emptyAcc, emptyPeriod, mergePeriod, NO_FACTS, type CalcRow, type Period } from './product-performance-math'

// 商品表现宽表的“行”装配（P6-22）：把 店铺 × ASIN 的事实按维度合并成行。
// 基本单元是 店铺 × ASIN；父 ASIN、品牌、品类、负责人、店铺、ASIN 都是把单元合并；SKU 维度一个 SKU 一行：
// 利润按 SKU 精确取；销售、流量、广告按 ASIN 统计，所以只有 ASIN 在该店铺下只有一个 SKU 时才归到这个 SKU，多个 SKU 时这几组留空并写明原因（不平均拆分）。

export type Filters = { dimension: PpDimension; parentAsin?: string; q?: string; brand?: string; category?: string; owner?: string }

interface Unit {
  key: string
  storeId: string
  asin: string
  refs: ProductRef[]
  rep: ProductRef
}

export interface RowInfo {
  dimension: PpDimension
  title: string | null
  subtitle: string | null
  imageUrl: string | null
  asin: string | null
  sku: string | null
  storeName: string | null
  childCount: number | null
  hasChildren: boolean
  multiSku: boolean
}

export interface Assembled {
  rows: CalcRow[]
  infos: Map<string, RowInfo>
  truncated: boolean
  hasData: boolean
}

const parentOf = (ref: ProductRef) => ref.parentAsin ?? ref.asin

function passes(unit: Unit, input: Filters): boolean {
  const { rep } = unit
  if (input.parentAsin && parentOf(rep) !== input.parentAsin) return false
  if (input.brand && rep.brand !== input.brand) return false
  if (input.category && rep.category !== input.category) return false
  if (input.owner && rep.ownerUserId !== input.owner) return false
  if (input.q) {
    const needle = input.q.toLowerCase()
    const texts = unit.refs.length > 0 ? unit.refs.flatMap(ref => [ref.asin, ref.parentAsin, ref.sku, ref.title, ref.brand]) : [unit.asin]
    return texts.some(text => text?.toLowerCase().includes(needle))
  }
  return true
}

interface ProfitMaps {
  bySku: Map<string, Totals>
  byUnit: Map<string, Totals>
  skus: Map<string, { storeId: string; sku: string; asin: string | null }>
}

const merge = (map: Map<string, Totals>, key: string, totals: Totals) => map.set(key, map.has(key) ? mergeTotals(map.get(key)!, totals) : totals)

function profitMaps(groups: readonly SkuGroup[], skuAsin: ReadonlyMap<string, string>): ProfitMaps {
  const maps: ProfitMaps = { bySku: new Map(), byUnit: new Map(), skus: new Map() }
  for (const group of groups) {
    const skuId = `${group.sellerAccountId}|${group.sku}`
    const asin = group.asin ?? skuAsin.get(skuId) ?? null
    merge(maps.bySku, skuId, group.totals)
    if (!maps.skus.has(skuId)) maps.skus.set(skuId, { storeId: group.sellerAccountId, sku: group.sku, asin })
    if (asin) merge(maps.byUnit, unitKey(group.sellerAccountId, asin), group.totals)
  }
  return maps
}

const distinct = (values: Iterable<string>) => [...new Set(values)]
const storeLabel = (stores: readonly string[]) => (stores.length === 1 ? stores[0]! : `${stores.length} 个店铺`)

function describe(dimension: PpDimension, key: string, members: readonly Unit[], owners: ReadonlyMap<string, string>): RowInfo {
  const first = members[0]!.rep
  const asins = distinct(members.map(unit => unit.asin))
  const storeNames = distinct(members.map(unit => unit.rep.storeName))
  const base: RowInfo = {
    dimension,
    title: null,
    subtitle: null,
    imageUrl: first.imageUrl,
    asin: null,
    sku: null,
    storeName: storeLabel(storeNames),
    childCount: null,
    hasChildren: false,
    multiSku: false,
  }
  switch (dimension) {
    case 'asin': {
      const refs = members.flatMap(unit => unit.refs)
      return { ...base, title: first.title || null, subtitle: refs.length > 1 ? `${refs.length} 个 SKU` : null, asin: key, sku: refs.length === 1 ? refs[0]!.sku : null }
    }
    case 'parentAsin': {
      const own = members.find(unit => unit.asin === key)?.rep ?? first
      return { ...base, title: own.title || null, subtitle: `${asins.length} 个子体`, asin: key, imageUrl: own.imageUrl, childCount: asins.length, hasChildren: asins.length > 1 || asins[0] !== key }
    }
    case 'store':
      return { ...base, title: first.storeName, subtitle: `${asins.length} 个 ASIN` }
    case 'owner':
      return { ...base, title: key ? (owners.get(key) ?? '已离开的成员') : '未设置负责人', subtitle: `${asins.length} 个 ASIN`, imageUrl: null }
    case 'brand':
      return { ...base, title: key || '未设置品牌', subtitle: `${asins.length} 个 ASIN`, imageUrl: null }
    case 'category':
      return { ...base, title: key || '未设置品类', subtitle: `${asins.length} 个 ASIN`, imageUrl: null }
    default:
      return base
  }
}

export async function assemble(prisma: PrismaService, access: BrAccess, input: Filters, caps: Caps): Promise<Assembled> {
  const { tenantId, scope, periods } = access
  const compare = periods.compare
  const [catalog, storeRows, current, previous] = await Promise.all([
    loadCatalog(prisma, catalogWhere(tenantId, scope)),
    prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: 500 }),
    loadPeriod(prisma, tenantId, scope, periods.period.from, periods.period.to, caps.profit),
    compare ? loadPeriod(prisma, tenantId, scope, compare.from, compare.to, caps.profit) : Promise.resolve<PeriodFacts | null>(null),
  ])
  const storeNames = new Map(storeRows.map(row => [row.id, row.displayName]))
  const refsByUnit = new Map<string, ProductRef[]>()
  const skuAsin = new Map<string, string>()
  for (const ref of catalog.products) {
    const key = unitKey(ref.storeId, ref.asin)
    refsByUnit.set(key, [...(refsByUnit.get(key) ?? []), ref])
    skuAsin.set(`${ref.storeId}|${ref.sku}`, ref.asin)
  }
  const now = profitMaps(current.profit, skuAsin)
  const before = previous ? profitMaps(previous.profit, skuAsin) : null
  const keys = new Set([...refsByUnit.keys(), ...current.facts.keys(), ...now.byUnit.keys(), ...(previous ? [...previous.facts.keys(), ...(before?.byUnit.keys() ?? [])] : [])])
  const units: Unit[] = []
  for (const key of [...keys].sort()) {
    const at = key.indexOf('|')
    const storeId = key.slice(0, at)
    const asin = key.slice(at + 1)
    if (!storeNames.has(storeId)) continue
    const refs = refsByUnit.get(key) ?? []
    const unit: Unit = { key, storeId, asin, refs, rep: refs[0] ?? bareRef(storeId, storeNames.get(storeId) ?? '', asin) }
    if (passes(unit, input)) units.push(unit)
  }
  const periodOf = (unit: Unit, facts: PeriodFacts | null, maps: ProfitMaps | null): Period | null =>
    facts ? { acc: accOf(facts.facts.get(unit.key) ?? NO_FACTS), profit: maps?.byUnit.get(unit.key) ?? null } : null
  const truncated = catalog.truncated || current.truncated || (previous?.truncated ?? false)
  const hasData = current.facts.size > 0 || current.profit.length > 0
  const finish = (grouped: Map<string, { cur: Period; prev: Period | null; members: Unit[] }>, infoOf: (key: string, members: Unit[]) => RowInfo): Assembled => {
    const rows: CalcRow[] = []
    const infos = new Map<string, RowInfo>()
    for (const [key, group] of grouped) {
      const id = rowIdOf(input.dimension, key)
      const info = infoOf(key, group.members)
      infos.set(id, info)
      rows.push(calcRow(id, info.title ?? key, group.cur, group.prev, caps.profit, caps.cost))
    }
    return { rows, infos, truncated, hasData }
  }

  const owners =
    input.dimension === 'owner'
      ? await memberNames(
          prisma,
          tenantId,
          units.map(unit => unit.rep.ownerUserId),
        )
      : new Map<string, string>()
  if (input.dimension !== 'sku') {
    const grouped = new Map<string, { cur: Period; prev: Period | null; members: Unit[] }>()
    for (const unit of units) {
      const key = keyOf(input.dimension, unit.rep)
      const held = grouped.get(key) ?? { cur: emptyPeriod(), prev: compare ? emptyPeriod() : null, members: [] }
      held.cur = mergePeriod(held.cur, periodOf(unit, current, now)!, mergeTotals)
      const prior = periodOf(unit, previous, before)
      if (held.prev && prior) held.prev = mergePeriod(held.prev, prior, mergeTotals)
      held.members.push(unit)
      grouped.set(key, held)
    }
    return finish(grouped, (key, members) => describe(input.dimension, key, members, owners))
  }

  // SKU 维度：一个 SKU 一行
  const grouped = new Map<string, { cur: Period; prev: Period | null; members: Unit[] }>()
  const single = (unit: Unit) => unit.refs.length === 1
  const skuPeriod = (unit: Unit, ref: ProductRef, facts: PeriodFacts | null, maps: ProfitMaps | null): Period | null =>
    facts ? { acc: single(unit) ? accOf(facts.facts.get(unit.key) ?? NO_FACTS) : emptyAcc(), profit: maps?.bySku.get(`${ref.storeId}|${ref.sku}`) ?? null } : null
  const multi = new Set<string>()
  for (const unit of units) {
    for (const ref of unit.refs) {
      const key = keyOf('sku', ref)
      if (!single(unit)) multi.add(key)
      grouped.set(key, { cur: skuPeriod(unit, ref, current, now)!, prev: skuPeriod(unit, ref, previous, before), members: [{ ...unit, refs: [ref], rep: ref }] })
    }
  }
  const filtered = Boolean(input.q || input.brand || input.category || input.owner || input.parentAsin)
  if (!filtered) {
    for (const [skuId, meta] of now.skus) {
      if (skuAsin.has(skuId) || !storeNames.has(meta.storeId)) continue
      const ref = { ...bareRef(meta.storeId, storeNames.get(meta.storeId) ?? '', meta.asin ?? ''), sku: meta.sku }
      const unit: Unit = { key: unitKey(meta.storeId, meta.asin ?? ''), storeId: meta.storeId, asin: meta.asin ?? '', refs: [ref], rep: ref }
      grouped.set(keyOf('sku', ref), {
        cur: { acc: emptyAcc(), profit: now.bySku.get(skuId) ?? null },
        prev: compare ? { acc: emptyAcc(), profit: before?.bySku.get(skuId) ?? null } : null,
        members: [unit],
      })
    }
  }
  const result = finish(grouped, (key, members) => {
    const ref = members[0]!.rep
    return {
      dimension: 'sku',
      title: ref.title || ref.sku,
      subtitle: [ref.asin, ref.sku].filter(Boolean).join(' · ') || null,
      imageUrl: ref.imageUrl,
      asin: ref.asin || null,
      sku: ref.sku,
      storeName: ref.storeName,
      childCount: null,
      hasChildren: false,
      multiSku: multi.has(key),
    }
  })
  return result
}
