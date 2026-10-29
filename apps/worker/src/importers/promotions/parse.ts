// 促销接口响应解析（Promotions API v2025-12-01，I-17）：纯函数，不访问数据库与网络。
// 字段按官方模型：促销 PromotionSummary.{promotionId, promotionTitle, promotionType, couponType, status, schedule{startDate,endDate}, budget, benefit, feeSnapshot,
// trackingId, createdDate, lastUpdatedDate, selection{selectionId,revisionId,type}, issues, latestRevision{revisionStatus}}；
// 商品清单 selection.selectionDetails.{items[{asin,sku,benefit,budget}], issues[{code,message,severity,identifier}], pagination{nextToken}}。
// 必填字段缺失的行整行跳过并计数，不猜、不补默认值；开始时间缺失时依次用创建时间、更新时间代替（列表要按开始时间排序）。

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const int = (value: unknown): number | null => {
  const parsed = num(value)
  return parsed !== null && Number.isInteger(parsed) ? parsed : null
}
function when(value: unknown): Date | null {
  const raw = text(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
const TITLE_MAX = 500
const MESSAGE_MAX = 1000
/** 单个促销保存的问题条数上限（超过的丢弃，数量照常计入 errorCount / warningCount）。 */
export const ISSUES_KEPT = 50

export interface ParsedIssue {
  code: string
  message: string
  severity: string
}
export interface ParsedItemIssue extends ParsedIssue {
  asin: string
  sku: string
}

function issueOf(raw: unknown): ParsedIssue | null {
  const item = record(raw)
  const code = text(item?.code)
  const message = text(item?.message)
  if (!item || !code || !message) return null
  return { code: code.slice(0, 100), message: message.slice(0, MESSAGE_MAX), severity: text(item.severity)?.toUpperCase() === 'ERROR' ? 'ERROR' : 'WARNING' }
}

export interface ParsedBudget {
  type: string
  value: number
  currency: string | null
}
function budgetOf(raw: unknown): ParsedBudget | null {
  const item = record(raw)
  const type = text(item?.type)
  const value = num(item?.value)
  if (!item || !type || value === null || value < 0) return null
  return { type: type.toUpperCase(), value, currency: text(item.currencyCode) }
}

export interface ParsedPromotion {
  promotionId: string
  title: string
  type: string
  couponType: string | null
  status: string
  revisionStatus: string | null
  startAt: Date
  endAt: Date | null
  createdAt: Date | null
  updatedAt: Date
  mappingId: string | null
  budget: ParsedBudget | null
  benefit: Loose | null
  fee: Loose | null
  selection: { type: string; id: string | null; revision: number | null } | null
  issues: ParsedIssue[]
  errorCount: number
  warningCount: number
}

export function parsePromotions(body: unknown): { promotions: ParsedPromotion[]; skipped: number; nextToken: string | null } {
  const root = record(body)
  const promotions: ParsedPromotion[] = []
  let skipped = 0
  for (const raw of list(root?.promotions)) {
    const item = record(raw)
    const promotionId = text(item?.promotionId)
    const type = text(item?.promotionType)
    const status = text(item?.status)
    const updatedAt = when(item?.lastUpdatedDate)
    if (!item || !promotionId || !type || !status || !updatedAt) {
      skipped += 1
      continue
    }
    const schedule = record(item.schedule)
    const createdAt = when(item.createdDate)
    const selection = record(item.selection)
    const selectionType = text(selection?.type)?.toUpperCase()
    const issues = list(item.issues).flatMap(entry => issueOf(entry) ?? [])
    const fee = record(record(item.feeSnapshot)?.previewedFeeRates)
    promotions.push({
      promotionId,
      title: (text(item.promotionTitle) ?? '（无标题）').slice(0, TITLE_MAX),
      type: type.toUpperCase(),
      couponType: text(item.couponType)?.toUpperCase() ?? null,
      status: status.toUpperCase(),
      revisionStatus: text(record(item.latestRevision)?.revisionStatus)?.toUpperCase() ?? null,
      startAt: when(schedule?.startDate) ?? createdAt ?? updatedAt,
      endAt: when(schedule?.endDate),
      createdAt,
      updatedAt,
      mappingId: text(item.trackingId),
      budget: budgetOf(item.budget),
      benefit: record(item.benefit),
      fee,
      selection: selectionType ? { type: selectionType, id: text(selection?.selectionId), revision: int(selection?.revisionId) } : null,
      issues: issues.slice(0, ISSUES_KEPT),
      errorCount: issues.filter(issue => issue.severity === 'ERROR').length,
      warningCount: issues.filter(issue => issue.severity !== 'ERROR').length,
    })
  }
  return { promotions, skipped, nextToken: text(record(root?.pagination)?.nextToken) }
}

export interface ParsedItem {
  asin: string
  sku: string
  benefitType: string | null
  discountType: string | null
  percentOff: number | null
  amountOff: number | null
  fixedPrice: number | null
  currency: string | null
  perCustomerUses: number | null
  budgetType: string | null
  budgetValue: number | null
}

export function parseSelection(body: unknown): { items: ParsedItem[]; issues: ParsedItemIssue[]; skipped: number; nextToken: string | null } {
  const details = record(record(record(body)?.selection)?.selectionDetails)
  const items: ParsedItem[] = []
  let skipped = 0
  for (const raw of list(details?.items)) {
    const item = record(raw)
    const asin = text(item?.asin)?.toUpperCase() ?? ''
    const sku = text(item?.sku) ?? ''
    if (!item || (!asin && !sku)) {
      skipped += 1
      continue
    }
    const benefit = record(item.benefit)
    const discount = record(benefit?.discount)
    const price = record(benefit?.price)
    const budget = budgetOf(item.budget)
    items.push({
      asin,
      sku,
      benefitType: text(benefit?.type)?.toUpperCase() ?? null,
      discountType: text(discount?.type)?.toUpperCase() ?? null,
      percentOff: num(discount?.percentOff),
      amountOff: num(discount?.amountOff),
      fixedPrice: num(price?.amount),
      currency: text(price?.currencyCode) ?? text(discount?.currencyCode),
      perCustomerUses: int(benefit?.perCustomerUses),
      budgetType: budget?.type ?? null,
      budgetValue: budget?.value ?? null,
    })
  }
  const issues = list(details?.issues).flatMap((entry): ParsedItemIssue[] => {
    const issue = issueOf(entry)
    const identifier = record(record(entry)?.identifier)
    return issue ? [{ ...issue, asin: text(identifier?.asin)?.toUpperCase() ?? '', sku: text(identifier?.sku) ?? '' }] : []
  })
  return { items, issues, skipped, nextToken: text(record(details?.pagination)?.nextToken) }
}

/** 商品级问题落到商品行：标识里有 SKU 就按 ASIN 与 SKU 同时匹配，只有 ASIN 就匹配该 ASIN 的所有行。 */
export function issuesOfItem(item: { asin: string; sku: string }, issues: readonly ParsedItemIssue[]): ParsedIssue[] {
  return issues
    .filter(issue => (issue.sku ? issue.sku === item.sku && (!issue.asin || issue.asin === item.asin) : issue.asin !== '' && issue.asin === item.asin))
    .map(({ code, message, severity }) => ({ code, message, severity }))
    .slice(0, 20)
}
