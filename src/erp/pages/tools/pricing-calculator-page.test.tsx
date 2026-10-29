import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { estimateFromRateCard, type PricingInput } from '@nova/api-contracts'

// 新品定价试算（P6-29）：比较多个售价，没有费用预估权限时写出原因，保存后出现在记录表。

const pages: LivePages = { PricingCalculatorPage: { load: () => import('./PricingCalculatorPage') } }
afterEach(() => vi.unstubAllGlobals())

const input: PricingInput = {
  purchaseCost: 5,
  firstMile: { method: 'NONE', unitPrice: 0 },
  lengthCm: 20,
  widthCm: 15,
  heightCm: 2,
  weightG: 200,
  category: 'STANDARD',
  prices: [20, 25],
  referenceAsin: null,
  storeId: null,
}

const view = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  reused: false,
  canSave: true,
  saved: false,
  name: null,
  estimatedAt: '2026-10-29T00:00:00.000Z',
  result: estimateFromRateCard(input, { state: 'NO_PERMISSION', message: '没有费用预估权限：这家店尚未获批定价角色。下面的数字按公开费率表估算（模型估算）。' }),
  ...over,
})

const handlers = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/tools/pricing-calculator/records': () => ({ body: { success: true, data: { items: [], total: 0, page: 1, pageSize: 50 } } }),
  ...extra,
})

describe('新品定价试算', () => {
  it('计算出利润，并写明没有费用预估权限', async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/tools/pricing-calculator',
      pages,
      handlers: handlers({
        '/tools/pricing-calculator/estimate': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return { body: { success: true, data: view() } }
        },
      }),
    })
    expect(await screen.findByRole('button', { name: '计算利润' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '计算利润' }))
    expect(await screen.findByText(/没有费用预估权限/)).toBeInTheDocument()
    expect(screen.getAllByText('模型估算').length).toBeGreaterThan(0)
    expect(bodies[0]).toMatchObject({ category: 'STANDARD', prices: [20, 25], purchaseCost: 5 })
  })
})
