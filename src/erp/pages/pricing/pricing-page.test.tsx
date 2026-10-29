import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { listResponse, noPriceRow, ok, priceRow, pricingHandlers, runView, writeOk } from './pricing-fixtures.test-helper'

// 定价与购物车（P4-11）：假服务端返回固定数据，验证价格列表（没有数据写“尚无记录”而不是 0、利润率带“估算”）、
// 健康筛选与排序随请求带出、改价先校验预览再提交（价格与预览编号随请求带出）、写入按钮按服务端判断的权限与开关禁用并写明原因。

const pages: LivePages = { PricingPage: { load: () => import('./PricingPage') } }
const url = '/app/pricing'
afterEach(() => vi.unstubAllGlobals())
const CHANGE = /^改\s?价$/

const open = async (response = () => listResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url, pages, me, handlers: pricingHandlers(response, extra) })
  const page = within(await screen.findByTestId('pricing-page'))
  await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
  return { app, page }
}
const calls = (app: { calls: Array<{ path: string; search: string; method: string }> }, path: string, method = 'GET') => app.calls.filter(call => call.path === path && call.method === method)

describe('定价：价格列表', () => {
  it('有价格的行：价格、推荐报价、最低竞争价、预期获胜价、差距、购物车获得率与健康；利润率带“估算”标签', async () => {
    const { page } = await open()
    const row = page.getByText('玻璃保鲜盒套装').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('link', { name: '玻璃保鲜盒套装' }).getAttribute('href')).toContain('/app/pricing/SKU-1')
    expect(within(row).getByRole('link', { name: '玻璃保鲜盒套装' }).getAttribute('href')).toContain('storeId=st1')
    expect(row).toHaveTextContent('$24.99')
    expect(row).toHaveTextContent('$23.50')
    expect(row).toHaveTextContent('$22.50')
    expect(row).toHaveTextContent('$23.99')
    expect(row).toHaveTextContent('+$1.00')
    expect(row).toHaveTextContent('62.0%')
    expect(row).toHaveTextContent('价格高于预期获胜价')
    expect(row).toHaveTextContent('21.0%')
    expect(within(row).getAllByText('估算').length).toBe(2)
    expect(row).toHaveTextContent('$26.99 → $24.99')
    expect(row).toHaveTextContent('最低 $20.00')
  })

  it('没有价格记录的行：全部写“尚无记录”（不写 0），没有护栏写“未设置”', async () => {
    const { page } = await open()
    const row = page.getByText('没有价格记录的商品').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(7)
    expect(row).toHaveTextContent('未设置')
    expect(row).not.toHaveTextContent('$0.00')
  })

  it('还没接入：顶部写明原因，列表为空时给出前置条件', async () => {
    mountApp({
      url,
      pages,
      handlers: pricingHandlers(() =>
        listResponse({ state: 'NOT_CONNECTED', note: '还没有同步到价格：连接店铺并授权“定价”角色后显示', items: [], summary: { total: 0, health: [], withPrice: 0, withoutPrice: 0 } }),
      ),
    })
    const page = within(await screen.findByTestId('pricing-page'))
    expect(await page.findByText(/还没有同步到价格/, {}, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({ url, pages, handlers: { ...pricingHandlers(() => listResponse()), '/pricing': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('pricing-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('玻璃保鲜盒套装')).toBeNull()
  }, 30_000)
})

describe('定价：筛选、排序与分页', () => {
  it('点健康状态卡片筛选，请求带 health 并回到第一页；再点取消', async () => {
    const { app, page } = await open()
    fireEvent.click(page.getByRole('button', { name: '价格高于预期获胜价（点击筛选）' }))
    await waitFor(() => expect(calls(app, '/pricing').some(call => new URLSearchParams(call.search).get('health') === 'ABOVE_EXPECTED')).toBe(true))
    expect(page.getByRole('button', { name: '价格高于预期获胜价（点击筛选）' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(page.getByRole('button', { name: '价格高于预期获胜价（点击筛选）' }))
    await waitFor(() => expect(page.getByRole('button', { name: '价格高于预期获胜价（点击筛选）' })).toHaveAttribute('aria-pressed', 'false'))
  })

  it('改排序字段与方向随请求带出', async () => {
    const { app, page } = await open()
    await userEvent.click(page.getByRole('button', { name: '排序方向' }))
    await waitFor(() => expect(calls(app, '/pricing').some(call => new URLSearchParams(call.search).get('sort') === 'gap:asc')).toBe(true))
  })

  it('下一页用服务端给的游标', async () => {
    const response = (): ReturnType<typeof listResponse> => listResponse({ pageInfo: { hasMore: true, nextCursor: 'c2', approxTotal: 40 } as never })
    const { app, page } = await open(response)
    await userEvent.click(page.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(calls(app, '/pricing').some(call => new URLSearchParams(call.search).get('cursor') === 'c2')).toBe(true))
  })
})

describe('定价：改价（校验预览 → 提交）', () => {
  const flow = (preview = runView()) => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
    const extra: Record<string, Handler> = {
      '/pricing/SKU-1/validate': (_url, init) => {
        bodies.push({ path: 'validate', body: JSON.parse(String(init?.body)) })
        return ok({ run: runView({ kind: 'VALIDATE', status: 'PENDING', statusLabel: '排队中', validation: null, usableUntil: null }), state: 'QUEUED' })
      },
      '/listings/runs/r1': () => ok(preview),
      '/pricing/SKU-1': (_url, init) => {
        bodies.push({ path: 'update', body: JSON.parse(String(init?.body)) })
        return ok({
          run: runView({ id: 'r2', kind: 'PATCH', kindLabel: '修改价格', status: 'PENDING', statusLabel: '排队中', validation: null, usableUntil: null, previewRunId: 'r1' }),
          state: 'QUEUED',
        })
      },
      '/listings/runs/r2': () => ok(runView({ id: 'r2', kind: 'PATCH', kindLabel: '修改价格', status: 'SUCCEEDED', statusLabel: '已完成', validation: null, usableUntil: null })),
    }
    return { bodies, extra }
  }
  const fill = async (value = '22.99') => {
    fireEvent.click(screen.getAllByRole('button', { name: CHANGE })[0]!)
    const drawer = within(await screen.findByTestId('price-change-drawer'))
    await userEvent.type(drawer.getByRole('spinbutton', { name: '新价格' }), value)
    return drawer
  }

  it('校验通过后才出现“提交改价”；请求带价格与预览编号；结果显示在抽屉里', async () => {
    const { bodies, extra } = flow()
    await open(() => listResponse(), extra)
    const drawer = await fill()
    expect(drawer.queryByRole('button', { name: '提交改价' })).toBeNull()
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByText('校验通过')).toBeInTheDocument()
    expect(bodies[0]).toMatchObject({ path: 'validate', body: { storeId: 'st1', price: 22.99 } })
    await userEvent.click(await drawer.findByRole('button', { name: '提交改价' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(bodies.some(entry => entry.path === 'update')).toBe(true))
    expect(bodies.find(entry => entry.path === 'update')?.body).toMatchObject({ storeId: 'st1', price: 22.99, previewRunId: 'r1' })
    expect(await drawer.findByText('改价结果')).toBeInTheDocument()
  })

  it('校验没通过：显示亚马逊给的问题，没有“提交改价”', async () => {
    const { extra } = flow(
      runView({ kind: 'VALIDATE', validation: 'INVALID', usableUntil: null, issues: [{ code: '90220', severity: 'ERROR', message: '价格低于允许的最低值', attributeNames: ['purchasable_offer'] }] }),
    )
    await open(() => listResponse(), extra)
    const drawer = await fill('0.5')
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByText('校验未通过')).toBeInTheDocument()
    expect(drawer.getByText(/价格低于允许的最低值/)).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '提交改价' })).toBeNull()
  })

  it('改了价格就要重新校验：已出现的“提交改价”随之消失', async () => {
    const { extra } = flow()
    await open(() => listResponse(), extra)
    const drawer = await fill()
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    await drawer.findByRole('button', { name: '提交改价' })
    await userEvent.type(drawer.getByRole('spinbutton', { name: '新价格' }), '1')
    await waitFor(() => expect(drawer.queryByRole('button', { name: '提交改价' })).toBeNull())
  })

  it('服务端拒绝（护栏拦截）：显示服务端给的原因，不显示成功', async () => {
    const { extra } = flow()
    extra['/pricing/SKU-1/validate'] = () => ({ status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '价格低于护栏的最低价 $20.00' } } })
    await open(() => listResponse(), extra)
    const drawer = await fill('10')
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByText(/价格低于护栏的最低价/)).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '提交改价' })).toBeNull()
  })

  it('改价开关未开启：校验可以做，“提交改价”禁用', async () => {
    const { extra } = flow()
    const update = { allowed: false, step: 'SWITCH' as const, reason: '该类写入的开关未开启', remedyPath: '/app/settings/integrations' }
    await open(() => listResponse({ write: { ...writeOk, update } }), extra)
    const drawer = await fill()
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByRole('button', { name: '提交改价' })).toBeDisabled()
  })

  it('没有改价权限：行上的“改价”禁用', async () => {
    await open(() => listResponse(), {}, { ...defaultMe, permissions: ['pricing.read'] })
    expect(screen.getAllByRole('button', { name: CHANGE })[0]).toBeDisabled()
  })

  it('价格填不对：页面就拦住，不发请求', async () => {
    const { bodies, extra } = flow()
    await open(() => listResponse(), extra)
    const drawer = await fill('0')
    expect(await drawer.findByText('价格要大于 0')).toBeInTheDocument()
    expect(drawer.getByRole('button', { name: '校验预览' })).toBeDisabled()
    expect(bodies).toHaveLength(0)
  })

  it('列表里的占位数据不会出现在另一行：没有价格的行也能打开改价抽屉并显示“尚无记录”', async () => {
    const { page } = await open(() => listResponse({ items: [noPriceRow(), priceRow()] }))
    expect(page.getByText('没有价格记录的商品')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: CHANGE })[0]!)
    const drawer = within(await screen.findByTestId('price-change-drawer'))
    expect(drawer.getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
  })
})
