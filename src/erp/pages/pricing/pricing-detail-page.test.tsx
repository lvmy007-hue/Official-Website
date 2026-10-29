import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { detailResponse, ok, ruleRun, simulation } from './pricing-fixtures.test-helper'

// 单品定价详情（P4-11）：价格历史、报价与竞争、调价记录（前后对照）、事件、护栏、待确认建议、价格模拟器；没有数据写“尚无记录”，不写 0。

// jsdom 里没有画布，图表容器换成占位（图表配置本身由 pricing-detail-options 的纯函数生成）
vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { PricingSkuDetailPage: { load: () => import('./PricingSkuDetailPage') } }
const url = '/app/pricing/SKU-1?storeId=st1'
afterEach(() => vi.unstubAllGlobals())

const open = async (response = () => detailResponse(), extra: Record<string, Handler> = {}, me = defaultMe, path = url) => {
  const app = mountApp({ url: path, pages, me, handlers: { '/pricing/SKU-1': () => ok(response()), ...extra } })
  const page = within(await screen.findByTestId('pricing-detail-page'))
  return { app, page }
}

describe('单品定价详情', () => {
  it('摘要、报价与竞争、调价记录（前后对照）、事件与护栏', async () => {
    const { app, page } = await open()
    await page.findByTestId('pricing-detail-summary', {}, { timeout: 15_000 })
    const summary = within(page.getByTestId('pricing-detail-summary'))
    expect(summary.getByText('$24.99')).toBeInTheDocument()
    expect(summary.getByText('$23.99')).toBeInTheDocument()
    expect(summary.getByText('62.0%')).toBeInTheDocument()
    expect(summary.getByText(/最低价 \$20\.00/)).toBeInTheDocument()
    expect(page.getByText('我方')).toBeInTheDocument()
    expect(within(page.getByTestId('pricing-adjustments')).getByTestId('price-compare')).toHaveTextContent('日均销量 3.5')
    expect(page.getByText('价格从 $26.99 变为 $24.99')).toBeInTheDocument()
    expect(page.getByText('整个店铺')).toBeInTheDocument()
    const request = app.calls.find(call => call.path === '/pricing/SKU-1')
    expect(new URLSearchParams(request?.search).get('storeId')).toBe('st1')
  })

  it('没有数据：历史、竞争报价、调价记录与事件写“尚无记录 / 前置条件”，不写 0', async () => {
    const { page } = await open(() =>
      detailResponse({
        row: detailResponse().row,
        history: { state: 'NO_DATA', note: '还没有价格记录', points: [] },
        offers: { state: 'NO_DATA', note: '还没有同步到竞争报价', observedAt: null, rows: [] },
        events: [],
        adjustments: [],
        guardrails: [],
        pendingRuns: [],
      }),
    )
    expect(await page.findByText(/还没有同步到竞争报价/, {}, { timeout: 10_000 })).toBeInTheDocument()
    expect(page.getByText(/还没有通过本系统调过价/)).toBeInTheDocument()
    expect(page.getByText(/还没有价格变化/)).toBeInTheDocument()
    expect(page.queryByTestId('pricing-pending')).toBeNull()
  })

  it('调价后观察期不满：写“观察中”，不给对照数字', async () => {
    const base = detailResponse()
    const { page } = await open(() => detailResponse({ adjustments: [{ ...base.adjustments[0]!, compare: { state: 'WAITING', note: '观察中：调价后满 3 天才对照', before: null, after: null } }] }))
    expect(await page.findByText('观察中：调价后满 3 天才对照', {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(page.queryByTestId('price-compare')).toBeNull()
  })

  it('待确认建议：确认进入改价抽屉并锁定为建议价', async () => {
    const { page } = await open(() => detailResponse({ pendingRuns: [ruleRun()] }))
    const pending = within(await page.findByTestId('pricing-pending', {}, { timeout: 15_000 }))
    await userEvent.click(pending.getByRole('button', { name: '确认调价' }))
    const drawer = within(await screen.findByTestId('price-change-drawer'))
    expect(drawer.getByRole('spinbutton', { name: '新价格' })).toHaveValue('23.99')
    expect(drawer.getByRole('spinbutton', { name: '新价格' })).toBeDisabled()
  })

  it('价格模拟器：提交店铺与价格；显示估算利润、护栏结论；弹性样本不足时只写原因', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { page } = await open(() => detailResponse(), {
      '/pricing/SKU-1/simulation': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok(simulation())
      },
    })
    const box = within(await page.findByTestId('pricing-simulator', {}, { timeout: 15_000 }))
    await userEvent.type(box.getByRole('spinbutton', { name: '模拟价格' }), '22.99')
    await userEvent.click(box.getByRole('button', { name: '开始模拟' }))
    expect(await box.findByText('价格不高于预期获胜价')).toBeInTheDocument()
    expect(bodies[0]).toEqual({ storeId: 'st1', price: 22.99 })
    expect(box.getByText('$4.20')).toBeInTheDocument()
    expect(box.getByText('18.0%')).toBeInTheDocument()
    expect(box.getByText('价格变动样本不足，不给价格弹性')).toBeInTheDocument()
    expect(box.getByText('通过')).toBeInTheDocument()
  })

  it('模拟器：护栏不通过时列出原因', async () => {
    const { page } = await open(() => detailResponse(), {
      '/pricing/SKU-1/simulation': () => ok(simulation({ guardrail: { ok: false, violations: [{ code: 'BELOW_MIN', text: '低于最低价 $20.00' }] } })),
    })
    const box = within(await page.findByTestId('pricing-simulator', {}, { timeout: 15_000 }))
    await userEvent.type(box.getByRole('spinbutton', { name: '模拟价格' }), '10')
    await userEvent.click(box.getByRole('button', { name: '开始模拟' }))
    expect(await box.findByText('低于最低价 $20.00')).toBeInTheDocument()
  })

  it('没有权限看利润：服务端拒绝时显示原因，不显示示例数据', async () => {
    const { page } = await open(() => detailResponse(), { '/pricing/SKU-1/simulation': () => ({ status: 403, body: { error: { code: 'TENANT_ACCESS_DENIED', message: '没有查看利润的权限' } } }) })
    const box = within(await page.findByTestId('pricing-simulator', {}, { timeout: 15_000 }))
    await userEvent.type(box.getByRole('spinbutton', { name: '模拟价格' }), '22')
    await userEvent.click(box.getByRole('button', { name: '开始模拟' }))
    await waitFor(() => expect(box.queryByText('$4.20')).toBeNull())
  })

  it('缺少店铺参数：提示从列表进入，不发请求', async () => {
    const { app, page } = await open(() => detailResponse(), {}, defaultMe, '/app/pricing/SKU-1')
    expect(await page.findByText(/缺少店铺参数/, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/pricing/SKU-1')).toBe(false)
  })

  it('读取失败：显示错误', async () => {
    const { page } = await open(() => detailResponse(), { '/pricing/SKU-1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '没有这个商品' } } }) })
    expect(await page.findByText(/读取定价详情失败/, {}, { timeout: 20_000 })).toBeInTheDocument()
  }, 30_000)
})
