import { US_MARKETPLACE, type TransactionStatus } from '../../connectors/sp-api-v2'
import type { JsonObject } from '../../types'
import { validDate } from '../shared'

// 财务新版接口（Finances v2024-06-19 listTransactions）响应解析。字段依据官方模型文件 finances_2024-06-19.json：
//   交易：transactionId、transactionType、transactionStatus、description、postedDate、totalAmount{currencyAmount,currencyCode}、
//         relatedIdentifiers[{relatedIdentifierName,relatedIdentifierValue}]、items[]、breakdowns、sellingPartnerMetadata、marketplaceDetails
//   明细：items[].breakdowns 是嵌套树；items[].contexts 里 ProductContext 带 asin、sku。
// 原则：新增字段与未知枚举值不报错；没有的数据保持为空。

export type ParsedFeeLine = { sourceEventId: string; eventType: string; path: string; amount: number; currency: string; asin?: string; sellerSku?: string }

export type ParsedTransaction = {
  transactionId: string
  transactionType: string
  /** 规范化为官方三种状态之一（大小写不敏感，官方示例里就有 Released 的写法）；接口没给或出现未知新状态时为空，原值见 statusRaw。 */
  status?: TransactionStatus
  statusRaw?: string
  description?: string
  postedAt: Date
  amount: number
  currency: string
  amazonOrderId?: string
  settlementId?: string
  relatedIdentifiers: Array<{ name: string; value: string }>
  accountType: string
  /** 递延交易的预计释放日（DeferredContext.maturityDate；多个取最晚的，保守）；接口没给就是空。 */
  maturityAt?: Date
  lines: ParsedFeeLine[]
}

export type TransactionSkip = { skipped: 'NO_TRANSACTION_ID' | 'NO_POSTED_DATE' | 'NO_AMOUNT' | 'NOT_US_MARKETPLACE' }

const asRecord = (value: unknown): JsonObject | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)
const asArray = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonObject => item !== null) : [])
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const money = (value: unknown) => {
  const record = asRecord(value)
  const raw = record?.currencyAmount
  const amount = raw === null || raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return Number.isFinite(amount) ? { amount, currency: text(record?.currencyCode) ?? 'USD' } : undefined
}
const STATUSES: readonly TransactionStatus[] = ['DEFERRED', 'RELEASED', 'DEFERRED_RELEASED']
const statusOf = (value: unknown): TransactionStatus | undefined => {
  const upper = text(value)?.toUpperCase()
  return STATUSES.find(status => status === upper)
}
/** 官方示例里 breakdowns 有时是数组、有时是 { breakdowns: [...] } 对象：两种都认。 */
const breakdownsOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? asArray(value) : asArray(asRecord(value)?.breakdowns))

function leavesOf(transactionId: string, item: JsonObject, itemIndex: number, fallbackType: string, fallbackCurrency: string): ParsedFeeLine[] {
  const context = asArray(item.contexts).find(entry => entry.contextType === 'ProductContext')
  const asin = text(context?.asin)
  const sellerSku = text(context?.sku)
  const lines: ParsedFeeLine[] = []
  const walk = (nodes: JsonObject[], trail: string[], indexes: string) => {
    nodes.forEach((node, index) => {
      const type = text(node.breakdownType) ?? 'Unknown'
      const here = [...trail, type]
      const position = `${indexes}.${index}`
      const children = breakdownsOf(node.breakdowns)
      const amount = money(node.breakdownAmount)
      if (children.length > 0) {
        walk(children, here, position)
      } else if (amount) {
        const path = here.join('/')
        lines.push({ sourceEventId: `${transactionId}:${itemIndex}:${position}`.slice(0, 180), eventType: type, path, amount: amount.amount, currency: amount.currency, asin, sellerSku })
      }
    })
  }
  walk(breakdownsOf(item.breakdowns), [], String(itemIndex))
  if (lines.length === 0) {
    // 没有拆分明细：用该行合计作为一条明细，类别取交易类型
    const total = money(item.totalAmount)
    if (total)
      lines.push({
        sourceEventId: `${transactionId}:${itemIndex}:total`.slice(0, 180),
        eventType: fallbackType,
        path: fallbackType,
        amount: total.amount,
        currency: total.currency || fallbackCurrency,
        asin,
        sellerSku,
      })
  }
  return lines
}

/**
 * 预计释放日：官方模型里递延原因放在上下文里（contextType = DeferredContext，带 maturityDate），交易层与明细行层都可能出现，两处都找。
 * 对照的是官方模型文件的描述，没有拿真实响应核对；找不到就是空（页面写“接口未提供”，不用下单日推算）。多个取最晚的。
 */
export function maturityOf(raw: JsonObject): Date | undefined {
  const contexts = [...asArray(raw.contexts), ...asArray(raw.items).flatMap(item => asArray(item.contexts))]
  const dates = contexts
    .filter(context => context.contextType === 'DeferredContext' || context.maturityDate !== undefined)
    .map(context => validDate(context.maturityDate))
    .filter((date): date is Date => date !== null)
  return dates.length > 0 ? new Date(Math.max(...dates.map(date => date.getTime()))) : undefined
}

export function parseTransaction(raw: JsonObject): ParsedTransaction | TransactionSkip {
  const transactionId = text(raw.transactionId)
  if (!transactionId) return { skipped: 'NO_TRANSACTION_ID' }
  const postedAt = validDate(raw.postedDate)
  if (!postedAt) return { skipped: 'NO_POSTED_DATE' }
  const total = money(raw.totalAmount)
  if (!total) return { skipped: 'NO_AMOUNT' }
  const metadata = asRecord(raw.sellingPartnerMetadata)
  const marketplaceId = text(asRecord(raw.marketplaceDetails)?.marketplaceId) ?? text(metadata?.marketplaceId) ?? US_MARKETPLACE
  if (marketplaceId !== US_MARKETPLACE) return { skipped: 'NOT_US_MARKETPLACE' }

  const relatedIdentifiers = asArray(raw.relatedIdentifiers)
    .map(entry => ({ name: text(entry.relatedIdentifierName) ?? '', value: text(entry.relatedIdentifierValue) ?? '' }))
    .filter(entry => entry.name && entry.value)
  const identifier = (name: string) => relatedIdentifiers.find(entry => entry.name === name)?.value
  const transactionType = text(raw.transactionType) ?? 'Unknown'
  const items = asArray(raw.items)
  return {
    transactionId,
    transactionType,
    status: statusOf(raw.transactionStatus),
    statusRaw: text(raw.transactionStatus),
    description: text(raw.description),
    postedAt,
    amount: total.amount,
    currency: total.currency,
    amazonOrderId: identifier('ORDER_ID'),
    settlementId: identifier('SETTLEMENT_ID'),
    relatedIdentifiers,
    accountType: text(metadata?.accountType) ?? '',
    maturityAt: maturityOf(raw),
    lines: items.flatMap((item, index) => leavesOf(transactionId, item, index, transactionType, total.currency)),
  }
}
