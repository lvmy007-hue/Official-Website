import { createHash } from 'node:crypto'

export type FeeLine = {
  eventType: string
  amount: number
  currency: string
  amazonOrderId?: string
  sellerSku?: string
  asin?: string
  settlementId?: string
  postedAt: Date
  description?: string
  sourceEventId: string
}

type Inherited = {
  amazonOrderId?: string
  sellerSku?: string
  asin?: string
  settlementId?: string
  postedAt?: Date
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function collectFeeLines(root: unknown) {
  const lines: FeeLine[] = []
  const walk = (node: unknown, inherited: Inherited, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, inherited, `${path}/${index}`))
      return
    }
    const record = asRecord(node)
    if (!record) return
    const next: Inherited = { ...inherited }
    if (typeof record.AmazonOrderId === 'string') next.amazonOrderId = record.AmazonOrderId
    if (typeof record.SellerSKU === 'string') next.sellerSku = record.SellerSKU
    if (typeof record.ASIN === 'string') next.asin = record.ASIN
    if (typeof record.SettlementId === 'string') next.settlementId = record.SettlementId
    const posted = record.PostedDate ?? record.TransactionDate ?? record.EventDate
    if (typeof posted === 'string' || posted instanceof Date) {
      const parsed = new Date(String(posted))
      if (!Number.isNaN(parsed.getTime())) next.postedAt = parsed
    }
    for (const [key, value] of Object.entries(record)) {
      const money = asRecord(value)
      if (money && ('CurrencyAmount' in money || 'CurrencyCode' in money) && !Array.isArray(value)) {
        const amount = Number(money.CurrencyAmount ?? 0)
        if (!Number.isFinite(amount)) continue
        const currency = String(money.CurrencyCode ?? 'USD')
        const eventType = String(record.ChargeType ?? record.FeeType ?? record.AdjustmentType ?? record.PromotionType ?? key)
        const postedAt = next.postedAt ?? new Date()
        const sourceEventId = createHash('sha256').update([path, key, eventType, next.amazonOrderId ?? '', next.sellerSku ?? '', amount, currency, postedAt.toISOString()].join('|')).digest('hex').slice(0, 40)
        lines.push({ eventType, amount, currency, amazonOrderId: next.amazonOrderId, sellerSku: next.sellerSku, asin: next.asin, settlementId: next.settlementId, postedAt, description: eventType, sourceEventId })
        continue
      }
      if (value && typeof value === 'object') walk(value, next, `${path}/${key}`)
    }
  }
  walk(root, {}, 'event')
  return lines
}
