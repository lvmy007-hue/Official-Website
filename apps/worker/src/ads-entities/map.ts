import { ADS_REPORT_AD_PRODUCTS } from '@nova/api-contracts'
import type { AdsEntityRecord } from '../connectors/ads-v1-parse'
import type { JsonObject } from '../types'

// 广告统一接口实体 → 本地表的字段映射（P5-12A，importers.md A-01；纯函数，不碰网络与数据库）。
// 【未对真实广告账户验证】字段名按统一接口的命名约定写，每个字段都按“多个候选路径取第一个有值的”取；取不到的字段是 undefined，
// 写库时 undefined 表示“这次没给”：新建行留空（或用必填列的占位），更新时保持原值，不覆盖成空。第一次接真实账户时对照真实响应核对本文件。

export type EntityTable = 'campaigns' | 'adGroups' | 'ads' | 'keywords' | 'targets' | 'negatives'
export const ENTITY_TABLES: readonly EntityTable[] = ['campaigns', 'adGroups', 'ads', 'keywords', 'targets', 'negatives']

export type SkipReason = 'NO_PRODUCT' | 'NO_PARENT' | 'NO_EXPRESSION'
export const SKIP_LABEL: Record<SkipReason, string> = {
  NO_PRODUCT: '活动没有可识别的广告产品',
  NO_PARENT: '缺少上级编号（广告组或活动）',
  NO_EXPRESSION: '投放对象没有可读的表达式',
}

export type Planned = {
  table: EntityTable
  /** 同一张表内的行键：与写库时的唯一键一一对应（活动是“编号|广告产品”，其余是对象编号）。 */
  key: string
  values: Record<string, unknown>
  /** 行里没有活动编号时，用这个广告组编号去查它所在的活动（关键词与否定投放）。 */
  groupId?: string
  /** 亚马逊已归档、且本地表没有状态列的对象（否定投放）：不新建，已有的删除。 */
  remove?: boolean
}

const PRODUCTS: readonly string[] = ADS_REPORT_AD_PRODUCTS
const TARGET_KINDS: readonly string[] = ['KEYWORD', 'PRODUCT', 'CATEGORY', 'AUDIENCE']

const obj = (value: unknown): JsonObject => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {})
const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
const upper = (value: unknown) => text(value)?.toUpperCase()
const num = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}
/** 日期：支持 20261101 与带时间的 ISO 文本；取不出返回 undefined。 */
export function dateOf(value: unknown): Date | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const ms = Date.parse(/^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw)
  return Number.isNaN(ms) ? undefined : new Date(ms)
}
const first = <T>(...values: Array<T | undefined>): T | undefined => values.find(value => value !== undefined)

function campaignOf(rec: AdsEntityRecord): Planned | { skipped: SkipReason } {
  const raw = rec.raw
  const adProduct = upper(first(raw.adProduct, raw.product))
  if (!adProduct || !PRODUCTS.includes(adProduct)) return { skipped: 'NO_PRODUCT' }
  const budgetItem = obj(Array.isArray(raw.budgets) ? raw.budgets[0] : undefined)
  const money = obj(obj(obj(budgetItem.budgetValue).monetaryBudgetValue).monetaryBudget)
  const legacy = obj(raw.budget)
  const targeting = upper(raw.targetingType)
  return {
    table: 'campaigns',
    key: `${rec.entityId}|${adProduct}`,
    values: {
      externalCampaignId: rec.entityId,
      adProduct,
      name: rec.name,
      state: rec.state?.toUpperCase(),
      budget: first(num(money.value), num(legacy.budget), num(legacy.amount), num(legacy.value), num(raw.budget)),
      currency: upper(first(money.currencyCode, legacy.currencyCode)),
      budgetType: upper(first(budgetItem.recurrenceTimePeriod, legacy.budgetType, raw.budgetType)),
      startDate: dateOf(first(raw.startDateTime, raw.startDate)),
      endDate: dateOf(first(raw.endDateTime, raw.endDate)),
      portfolioId: text(raw.portfolioId),
      targetingType: targeting === 'AUTO' || targeting === 'MANUAL' ? targeting : undefined,
      bidStrategy: first(text(obj(obj(raw.optimizations).bidSettings).bidStrategy), text(raw.bidStrategy), text(obj(raw.dynamicBidding).strategy)),
      servingStatus: first(text(raw.servingStatus), text(obj(raw.extendedData).servingStatus)),
      raw,
    },
  }
}

function adGroupOf(rec: AdsEntityRecord): Planned | { skipped: SkipReason } {
  if (!rec.parentId) return { skipped: 'NO_PARENT' }
  const raw = rec.raw
  return {
    table: 'adGroups',
    key: rec.entityId,
    values: {
      adGroupId: rec.entityId,
      campaignId: rec.parentId,
      name: rec.name,
      state: rec.state?.toUpperCase(),
      defaultBid: first(num(raw.defaultBid), num(obj(raw.bid).defaultBid), num(obj(raw.bidSettings).defaultBid)),
    },
  }
}

function adOf(rec: AdsEntityRecord): Planned | { skipped: SkipReason } {
  if (!rec.parentId) return { skipped: 'NO_PARENT' }
  const raw = rec.raw
  const product = obj(raw.product)
  return {
    table: 'ads',
    key: rec.entityId,
    values: { adId: rec.entityId, adGroupId: rec.parentId, asin: first(text(raw.asin), text(product.asin)), sku: first(text(raw.sku), text(product.sku)), state: rec.state?.toUpperCase() },
  }
}

/** 投放对象的内容：关键词、商品、类目、受众四选一；都没有时退回通用的 expression 文本。 */
function targetContent(raw: JsonObject): { kind: string; expression: string; matchType: string | undefined } | null {
  const details = obj(raw.targetDetails)
  const keywordTarget = obj(details.keywordTarget)
  const matchType = upper(first(raw.matchType, obj(raw.keyword).matchType, keywordTarget.matchType))
  const keyword = first(text(raw.keywordText), text(raw.keyword), text(obj(raw.keyword).text), text(keywordTarget.keyword))
  if (keyword) return { kind: 'KEYWORD', expression: keyword, matchType }
  const asin = first(text(raw.asin), text(obj(raw.product).asin), text(obj(details.productTarget).asin))
  if (asin) return { kind: 'PRODUCT', expression: asin, matchType }
  const category = first(text(obj(raw.category).id), text(raw.categoryId), text(obj(raw.category).name))
  if (category) return { kind: 'CATEGORY', expression: category, matchType }
  const audience = first(text(obj(raw.audience).id), text(raw.audienceId))
  if (audience) return { kind: 'AUDIENCE', expression: audience, matchType }
  const expression = text(raw.expression)
  if (!expression) return null
  const kind = upper(raw.targetType ?? raw.kind)
  return { kind: kind && TARGET_KINDS.includes(kind) ? kind : 'PRODUCT', expression, matchType }
}

/** 统一接口的 targets 资源：否定的进否定投放表，非否定的关键词进关键词表，其余进投放对象表。 */
function targetOf(rec: AdsEntityRecord): Planned | { skipped: SkipReason } {
  const raw = rec.raw
  const content = targetContent(raw)
  if (!content) return { skipped: 'NO_EXPRESSION' }
  const state = rec.state?.toUpperCase()
  const bid = first(num(raw.bid), num(obj(raw.bid).bid), num(obj(raw.bid).value))
  const campaignId = text(raw.campaignId)
  if (raw.negative === true || raw.isNegative === true) {
    if (!rec.parentId && !campaignId) return { skipped: 'NO_PARENT' }
    return {
      table: 'negatives',
      key: rec.entityId,
      groupId: rec.parentId,
      remove: state === 'ARCHIVED',
      values: { negativeId: rec.entityId, level: rec.parentId ? 'AD_GROUP' : 'CAMPAIGN', campaignId, adGroupId: rec.parentId, expression: content.expression, matchType: content.matchType ?? '' },
    }
  }
  if (!rec.parentId) return { skipped: 'NO_PARENT' }
  if (content.kind === 'KEYWORD') {
    return {
      table: 'keywords',
      key: rec.entityId,
      groupId: rec.parentId,
      values: { keywordId: rec.entityId, campaignId, adGroupId: rec.parentId, text: content.expression, matchType: content.matchType ?? '', bid, state },
    }
  }
  return {
    table: 'targets',
    key: rec.entityId,
    values: { targetId: rec.entityId, adGroupId: rec.parentId, kind: content.kind, expression: content.expression, matchType: content.matchType, bid, state },
  }
}

export function planEntity(rec: AdsEntityRecord): Planned | { skipped: SkipReason } {
  switch (rec.entityType) {
    case 'CAMPAIGN':
      return campaignOf(rec)
    case 'AD_GROUP':
      return adGroupOf(rec)
    case 'AD':
      return adOf(rec)
    case 'TARGET':
      return targetOf(rec)
    default:
      return { skipped: 'NO_PARENT' }
  }
}

/** 广告组合（旧接口 /v2/portfolios/extended）→ 本地行；没有编号返回 null。 */
export function planPortfolio(item: JsonObject): { key: string; values: Record<string, unknown> } | null {
  const portfolioId = text(first(item.portfolioId, item.id))
  if (!portfolioId) return null
  const budget = obj(item.budget)
  return {
    key: portfolioId,
    values: {
      portfolioId,
      name: text(item.name),
      status: upper(first(item.state, item.status)),
      budgetCap: first(num(budget.amount), num(budget.budget), num(budget.value)),
      budgetPeriod: upper(first(budget.policy, budget.budgetPeriod)),
      budgetStart: dateOf(budget.startDate),
      budgetEnd: dateOf(budget.endDate),
      currency: upper(budget.currencyCode),
    },
  }
}
