import { describe, expect, it, beforeEach } from 'vitest'
import { UpstreamHttpError } from './http-error'
import { ProductFeesApi, isFeesForbidden, readFeeEstimate, resetFeeSlot, takeFeeSlot } from './product-fees-api'

const payload = {
  payload: {
    FeesEstimateResult: {
      Status: 'Success',
      FeesEstimate: {
        FeeDetailList: [
          { FeeType: 'ReferralFee', FeeAmount: { Amount: 3, CurrencyCode: 'USD' } },
          { FeeType: 'FBAFees', FinalFee: { Amount: 4.08, CurrencyCode: 'USD' } },
        ],
      },
    },
  },
}

describe('费用预估解析与频率', () => {
  beforeEach(() => resetFeeSlot())

  it('读出佣金与配送费', () => {
    expect(readFeeEstimate(payload)).toMatchObject({ referral: 3, fulfillment: 4.08, currency: 'USD', status: 'Success' })
  })

  it('两次调用间隔不足时不放行', () => {
    expect(takeFeeSlot(1_000).ok).toBe(true)
    expect(takeFeeSlot(1_500)).toMatchObject({ ok: false })
    expect(takeFeeSlot(2_000).ok).toBe(true)
  })

  it('403 认作没有费用预估权限；间隔不足抛出可重试错误', async () => {
    const forbidden = new UpstreamHttpError('SP_API_403', 403, undefined, 'api')
    expect(isFeesForbidden(forbidden)).toBe(true)
    const client = { request: async () => payload }
    const api = new ProductFeesApi(client as never)
    await api.estimate('B0TEST0001', 20)
    await expect(api.estimate('B0TEST0001', 20)).rejects.toThrow('FEES_RATE_WAIT')
  })
})
