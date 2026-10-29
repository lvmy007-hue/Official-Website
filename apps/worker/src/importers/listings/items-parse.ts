import { LISTING_MARKETPLACE_ID, listingImpactOf, listingStatusOfSummary, type ListingImpact, type ListingSeverity } from '@nova/api-contracts'

// 刊登搜索结果的解析（Listings Items 2021-08-01，importers.md I-10）。字段依据官方文档整理，未经真实响应核对（CR-085）：
// 每个商品 { sku, summaries: [{ marketplaceId, asin, productType, conditionType, status: [...], itemName, mainImage: { link } }], issues: [{ code, message, severity, attributeNames, categories, enforcements }] }。
// 规则：没有 sku 的商品跳过；只取美国站的摘要；问题只收 ERROR 与 WARNING（INFO 不入库）；没有美国站摘要的商品照样收问题，但不写状态与内容。

export interface ParsedIssue {
  code: string
  attributeName: string
  category: string
  severity: ListingSeverity
  impact: ListingImpact
  message: string
}
export interface ParsedListing {
  sku: string
  asin: string
  hasSummary: boolean
  productType: string | null
  conditionType: string | null
  status: 'ACTIVE' | 'INACTIVE'
  amazonStatuses: string[]
  itemName: string | null
  mainImageUrl: string | null
  issues: ParsedIssue[]
}
export interface ParsedListings {
  items: ParsedListing[]
  nextToken: string | null
  skipped: number
}

const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const MESSAGE_MAX = 1000

export function parseIssue(raw: unknown): ParsedIssue | null {
  const issue = obj(raw)
  if (!issue) return null
  const severity = str(issue.severity).toUpperCase()
  if (severity !== 'ERROR' && severity !== 'WARNING') return null
  const code = str(issue.code)
  if (!code) return null
  const actions = list(obj(issue.enforcements)?.actions).map(action => str(obj(action)?.action))
  const categories = list(issue.categories).map(str).filter(Boolean)
  const attributes = list(issue.attributeNames).map(str).filter(Boolean)
  return {
    code: code.slice(0, 120),
    attributeName: (attributes[0] ?? '').slice(0, 120),
    category: (categories.find(item => item === 'MISSING_ATTRIBUTE' || item === 'INVALID_ATTRIBUTE') ?? categories[0] ?? '').slice(0, 60),
    severity,
    impact: listingImpactOf(actions),
    message: (str(issue.message) || code).slice(0, MESSAGE_MAX),
  }
}

export function parseListings(raw: unknown): ParsedListings {
  const root = obj(raw)
  if (!root) throw new Error('LISTINGS_RESPONSE_INVALID')
  const items: ParsedListing[] = []
  let skipped = 0
  for (const entry of list(root.items)) {
    const row = obj(entry)
    const sku = row ? str(row.sku) : ''
    if (!row || !sku) {
      skipped += 1
      continue
    }
    const summary = list(row.summaries)
      .map(obj)
      .find(item => item && str(item.marketplaceId) === LISTING_MARKETPLACE_ID)
    const statuses = summary ? list(summary.status).map(str).filter(Boolean) : []
    const seen = new Set<string>()
    const issues: ParsedIssue[] = []
    for (const raw of list(row.issues)) {
      const parsed = parseIssue(raw)
      if (!parsed) continue
      const key = `${parsed.code}|${parsed.attributeName}`
      if (seen.has(key)) continue // 同一个问题按（代码，属性）去重，唯一键保证幂等
      seen.add(key)
      issues.push(parsed)
    }
    items.push({
      sku: sku.slice(0, 200),
      asin: summary ? str(summary.asin).toUpperCase() : '',
      hasSummary: summary !== undefined && summary !== null,
      productType: summary ? str(summary.productType) || null : null,
      conditionType: summary ? str(summary.conditionType) || null : null,
      status: listingStatusOfSummary(statuses),
      amazonStatuses: statuses,
      itemName: summary ? str(summary.itemName) || null : null,
      mainImageUrl: summary ? str(obj(summary.mainImage)?.link) || null : null,
      issues,
    })
  }
  return { items, nextToken: str(obj(root.pagination)?.nextToken) || null, skipped }
}
