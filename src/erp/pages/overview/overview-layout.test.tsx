import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { baseHandlers, ok } from './overview-fixtures.test-helper'

// 经营控制台：视图模板、个人布局、报表、大屏模式、权限。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { OverviewPage: { load: () => import('./OverviewPage') } }
afterEach(() => vi.unstubAllGlobals())

const mount = (handlers: Record<string, Handler> = {}, permissions?: string[]) =>
  mountApp({ url: '/app/overview', pages, me: permissions ? { ...defaultMe, permissions } : undefined, handlers: { ...baseHandlers(), ...handlers } })

const savedLayout = (filter: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ok({
    items: [
      {
        id: 'v1',
        pageKey: 'overview',
        name: '我的布局',
        filter,
        columns: [],
        sort: [],
        shared: false,
        isDefault: false,
        mine: true,
        owner: { id: 'u1', name: '林然' },
        version: 3,
        updatedAt: '2026-10-20T00:00:00Z',
        ...extra,
      },
    ],
    limit: 20,
  })

describe('视图模板与个人布局', () => {
  it('默认是经营者模板：全部区域与 7 张指标卡', async () => {
    mount()
    await screen.findByTestId('kpi-sales')
    for (const id of ['kpi-profit', 'kpi-margin', 'kpi-adsSpend', 'kpi-adsShare', 'kpi-stockRisk', 'kpi-anomalies']) expect(screen.getByTestId(id)).toBeInTheDocument()
    for (const id of [
      'trend-section',
      'queue-section',
      'store-compare-section',
      'asin-rank-section',
      'volatility-section',
      'ad-anomalies-section',
      'inventory-risk-section',
      'waterfall-section',
      'cash-section',
      'source-health-section',
    ])
      expect(await screen.findByTestId(id)).toBeInTheDocument()
  })

  it('切到财务模板：指标卡只有财务关心的，区域顺序和范围随模板，没有广告异常与库存风险', async () => {
    mount()
    await screen.findByTestId('kpi-sales')
    fireEvent.click(within(screen.getByLabelText('视图模板')).getByText('财务'))
    await waitFor(() => expect(screen.queryByTestId('kpi-stockRisk')).not.toBeInTheDocument())
    expect(screen.getByTestId('kpi-profit')).toBeInTheDocument()
    expect(screen.queryByTestId('ad-anomalies-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('asin-rank-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('cash-section')).toBeInTheDocument()
  })

  it('供应链模板：只有 3 张指标卡', async () => {
    mount()
    await screen.findByTestId('kpi-sales')
    fireEvent.click(within(screen.getByLabelText('视图模板')).getByText('供应链'))
    await waitFor(() => expect(screen.queryByTestId('kpi-profit')).not.toBeInTheDocument())
    expect(screen.getByTestId('kpi-stockRisk')).toBeInTheDocument()
    expect(screen.getByTestId('kpi-anomalies')).toBeInTheDocument()
    expect(screen.queryByTestId('kpi-adsSpend')).not.toBeInTheDocument()
  })

  it('保存为我的布局：新建一个仅本人可见的视图，页面标识 overview', async () => {
    const bodies: unknown[] = []
    const app = mount({
      '/views': (_url, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)))
          return { status: 201, body: { success: true, data: { id: 'v9' } } }
        }
        return ok({ items: [], limit: 20 })
      },
    })
    await screen.findByTestId('kpi-sales')
    const save = screen.getByRole('button', { name: '保存为我的布局' })
    expect(save).toBeDisabled()
    fireEvent.click(within(screen.getByLabelText('视图模板')).getByText('财务'))
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ pageKey: 'overview', name: '我的布局', shared: false, filterJson: { template: 'finance', hiddenSections: [], hiddenCards: [] } })
    expect(app.calls.filter(call => call.path === '/views' && call.method === 'POST')).toHaveLength(1)
  })

  it('已有个人布局：打开页面就按它显示，再保存走更新并带版本号', async () => {
    const patches: Array<{ path: string; body: unknown }> = []
    mount({
      '/views': () => savedLayout({ template: 'operation', hiddenSections: ['trend'], hiddenCards: ['adsShare'] }),
      '/views/v1': (url, init) => {
        patches.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
        return ok({ id: 'v1' })
      },
    })
    await screen.findByTestId('kpi-sales')
    expect(screen.queryByTestId('trend-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kpi-adsShare')).not.toBeInTheDocument()
    expect(screen.getByTestId('kpi-adsSpend')).toBeInTheDocument()
    expect(screen.getByTestId('kpi-stockRisk')).toBeInTheDocument()
    expect(screen.queryByTestId('kpi-profit')).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByLabelText('视图模板')).getByText('财务'))
    fireEvent.click(await screen.findByRole('button', { name: '保存为我的布局' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]!.body).toMatchObject({ version: 3, filterJson: { template: 'finance' } })
  })

  it('已保存的布局内容损坏时回到经营者模板，不报错', async () => {
    mount({ '/views': () => savedLayout({ template: 'nope' }) })
    expect(await screen.findByTestId('kpi-stockRisk')).toBeInTheDocument()
    expect(screen.getByTestId('cash-section')).toBeInTheDocument()
  })

  it('别人共享的同名视图不当作我的布局', async () => {
    mount({ '/views': () => savedLayout({ template: 'finance', hiddenSections: [], hiddenCards: [] }, { mine: false }) })
    expect(await screen.findByTestId('kpi-stockRisk')).toBeInTheDocument()
  })

  it('自定义：隐藏某个区域后不再显示，“放弃调整”恢复', async () => {
    mount()
    await screen.findByTestId('kpi-sales')
    fireEvent.click(screen.getByRole('button', { name: '自定义' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: '现金视角' }))
    await waitFor(() => expect(screen.queryByTestId('cash-section')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '放弃调整' }))
    expect(await screen.findByTestId('cash-section')).toBeInTheDocument()
  })

  it('没有“保存视图”权限：保存按钮禁用', async () => {
    mount({}, ['overview.read'])
    await screen.findByTestId('kpi-sales')
    fireEvent.click(within(screen.getByLabelText('视图模板')).getByText('财务'))
    expect(screen.getByRole('button', { name: '保存为我的布局' })).toBeDisabled()
  })
})

describe('报表', () => {
  it('周报：按截止日往前 7 天，提交导出任务，范围沿用所选店铺', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const app = mountApp({
      url: '/app/overview?storeIds=st1',
      pages,
      handlers: {
        ...baseHandlers(),
        '/exports': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return { status: 202, body: { success: true, data: { id: 'x1', status: 'QUEUED' } } }
        },
      },
    })
    await screen.findByTestId('kpi-sales')
    fireEvent.click(screen.getByRole('button', { name: '生成报表' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('周报'))
    fireEvent.change(within(dialog).getByLabelText('截止日期'), { target: { value: '2026-10-10' } })
    expect(within(dialog).getByText('2026-10-04 至 2026-10-10')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /生\s*成/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ kind: 'overview-report', format: 'XLSX', filters: { storeIds: ['st1'], from: '2026-10-04', to: '2026-10-10', template: 'weekly' } })
    expect(await within(dialog).findByText(/已提交/)).toBeInTheDocument()
    expect(app.calls.filter(call => call.path === '/exports' && call.method === 'POST')).toHaveLength(1)
  })

  it('月报：截止日所在自然月；截止日晚于今天不能提交', async () => {
    mount()
    await screen.findByTestId('kpi-sales')
    fireEvent.click(screen.getByRole('button', { name: '生成报表' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('月报'))
    fireEvent.change(within(dialog).getByLabelText('截止日期'), { target: { value: '2026-09-15' } })
    expect(within(dialog).getByText('2026-09-01 至 2026-09-15')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('截止日期'), { target: { value: '2999-01-01' } })
    expect(within(dialog).getByText('请选择不晚于今天的日期')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /生\s*成/ })).toBeDisabled()
  })

  it('按法律主体筛选时提示报表不支持', async () => {
    mountApp({ url: '/app/overview?legalEntityIds=le1', pages, handlers: baseHandlers() })
    await screen.findByTestId('kpi-sales')
    fireEvent.click(screen.getByRole('button', { name: '生成报表' }))
    expect(await screen.findByText(/报表暂不支持按法律主体筛选/)).toBeInTheDocument()
  })

  it('没有导出权限：生成报表按钮禁用', async () => {
    mount({}, ['overview.read'])
    await screen.findByTestId('kpi-sales')
    expect(screen.getByRole('button', { name: '生成报表' })).toBeDisabled()
  })
})

describe('大屏模式', () => {
  it('进入后铺满窗口并可退出；Esc 也能退出', async () => {
    mount()
    await screen.findByTestId('kpi-sales')
    const page = screen.getByTestId('overview-page')
    expect(page.style.position).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '大屏模式' }))
    expect(await screen.findByRole('button', { name: '退出大屏' })).toHaveAttribute('aria-pressed', 'true')
    expect(page.style.position).toBe('fixed')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(page.style.position).toBe(''))
    expect(screen.getByRole('button', { name: '大屏模式' })).toBeInTheDocument()
  })

  it('刷新按钮重新读取各区域', async () => {
    const app = mount()
    await screen.findByTestId('kpi-sales')
    const before = app.calls.filter(call => call.path === '/overview/kpis').length
    fireEvent.click(screen.getByRole('button', { name: /刷\s*新/ }))
    await waitFor(() => expect(app.calls.filter(call => call.path === '/overview/kpis').length).toBeGreaterThan(before))
  })
})
