import { FEES_ROLE_PENDING } from '@nova/api-contracts'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 费用预估（Product Fees API v0，P6-29）。路径依据官方文档整理，尚未用真实店铺核对：
//   POST /products/fees/v0/items/{asin}/feesEstimate?IdType=ASIN
// 官方没有“只按尺寸”的接口，必须带 ASIN。403 = 缺“定价”或“商品刊登”角色。
// 同一进程内两次调用至少间隔 1 秒（接口侧的频率限制；企业每分钟的新参数上限在 API 里）。

export const feeEstimatePath = (asin: string) => `/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`
export const FEE_ESTIMATE_MIN_GAP_MS = 1000
export { FEES_ROLE_PENDING }

let lastAt = 0

export function takeFeeSlot(now: number, minGap = FEE_ESTIMATE_MIN_GAP_MS): { ok: boolean; waitMs: number } {
  if (now - lastAt < minGap) return { ok: false, waitMs: minGap - (now - lastAt) }
  lastAt = now
  return { ok: true, waitMs: 0 }
}

export function resetFeeSlot() {
  lastAt = 0
}

const amountOf = (node: unknown): number | null => {
  if (!node || typeof node !== 'object') return null
  const raw = (node as { Amount?: unknown; amount?: unknown }).Amount ?? (node as { amount?: unknown }).amount
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(value) ? value : null
}

/** 从费用预估响应里取出佣金与配送费。状态不是 Success 时金额可能为空。 */
export function readFeeEstimate(payload: unknown): { referral: number | null; fulfillment: number | null; currency: string | null; status: string } {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const body = (root.payload && typeof root.payload === 'object' ? root.payload : root) as Record<string, unknown>
  const result = (body.FeesEstimateResult && typeof body.FeesEstimateResult === 'object' ? body.FeesEstimateResult : body) as Record<string, unknown>
  const status = typeof result.Status === 'string' ? result.Status : 'Unknown'
  const estimate = (result.FeesEstimate && typeof result.FeesEstimate === 'object' ? result.FeesEstimate : {}) as Record<string, unknown>
  const list = Array.isArray(estimate.FeeDetailList) ? estimate.FeeDetailList : []
  let referral: number | null = null
  let fulfillment = 0
  let fulfillmentSeen = false
  let currency: string | null = null
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const fee = row.FinalFee ?? row.FeeAmount
    const value = amountOf(fee)
    const code = fee && typeof fee === 'object' ? (fee as { CurrencyCode?: unknown }).CurrencyCode : undefined
    if (typeof code === 'string' && code) currency = code
    const type = String(row.FeeType ?? '')
    if (type === 'ReferralFee') referral = value
    if (type === 'FBAFees' || type === 'FBAPerUnitFulfillmentFee' || type === 'FBAPerOrderFulfillmentFee') {
      fulfillment += value ?? 0
      fulfillmentSeen = true
    }
  }
  return { referral, fulfillment: fulfillmentSeen ? fulfillment : null, currency, status }
}

export const isFeesForbidden = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403

export class ProductFeesApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 对一个 ASIN、一个售价估算佣金与配送费。间隔不足时抛出可重试的 FEES_RATE_WAIT。 */
  async estimate(asin: string, price: number) {
    const slot = takeFeeSlot(Date.now())
    if (!slot.ok) throw new Error('FEES_RATE_WAIT')
    return this.client.request({
      method: 'POST',
      path: feeEstimatePath(asin),
      query: { IdType: 'ASIN' },
      body: {
        FeesEstimateRequest: {
          MarketplaceId: US_MARKETPLACE,
          IsAmazonFulfilled: true,
          PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: price }, Shipping: { CurrencyCode: 'USD', Amount: 0 } },
          Identifier: `fee-${asin}`,
        },
      },
    })
  }
}
