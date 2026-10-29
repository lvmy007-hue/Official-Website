import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { freshness, list, NO_POLICY_NOTE, NO_VIEWS, ok, policy, row, rowText, summary } from './inventory-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 库存健康页（P2a-06）：8 张指标卡、4 张图、7 个页签、没有规则时的诚实状态、规则抽屉。

const pages: LivePages = { InventoryHealthPage: { load: () => import('./InventoryHealthPage') } }
afterEach(() => vi.unstubAllGlobals())

const me = (permissions: string[]) => ({ ...defaultMe, permissions })
const handlers = (over: Record<string, Handler> = {}, permissions = ['inventory.read']): Record<string, Handler> => ({
  '/auth/me': () => ok(me(permissions)),
  '/inventory': () => ok(list()),
  '/grid-views': () => ok(NO_VIEWS),
  '/inventory/summary': () => ok(summary()),
  '/inventory/rules': () => ok({ state: 'NOT_CONNECTED', note: NO_POLICY_NOTE, current: null, history: [] }),
  ...over,
})

describe('库存健康页', () => {
  it('没有配置规则：写明“尚未配置库存规则”，风险列不给任何等级，未算出的卡片写原因而不是 0', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers() })
    expect(await screen.findByText('尚未配置库存规则')).toBeInTheDocument()
    await screen.findByText('SKU-1')
    await waitFor(() => expect(rowText('inv1')).toContain('尚未配置规则'))
    expect(within(screen.getAllByTestId('metric-card')[0]!).getByText('1,234')).toBeInTheDocument()
    expect(screen.getAllByText(/需要先配置库存规则/).length).toBeGreaterThan(0)
    expect(screen.getByRole('img', { name: '各店铺库存结构堆叠柱图' })).toBeInTheDocument()
  })

  it('7 个页签齐全；切换页签带上 tab 参数并回到第一页', async () => {
    const app = mountApp({ url: '/app/inventory', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    for (const label of ['全部库存', '低库存', '冗余', '库龄风险', '滞留', '不可售', '在途']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '低库存' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/inventory' && call.search.includes('tab=low') && call.search.includes('page=1'))).toBe(true))
  })

  it('搜索会带 q 参数重新取数', async () => {
    const app = mountApp({ url: '/app/inventory', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    await userEvent.type(screen.getByLabelText('搜索库存'), 'SKU-9{enter}')
    await waitFor(() => expect(app.calls.some(call => call.path === '/inventory' && call.search.includes('q=SKU-9'))).toBe(true))
  })

  it('筛选写在地址栏里：带条件的链接（刷新、复制）原样恢复页签、风险与搜索，并显示已生效条件；地址里不认识的取值被丢掉', async () => {
    const app = mountApp({ url: '/app/inventory?tab=low&risk=HIGH&q=SKU-9&qs=a1,A1,b2&bogus=1', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    const call = app.calls.find(item => item.path === '/inventory')!
    const params = new URLSearchParams(call.search)
    expect(params.get('tab')).toBe('low')
    expect(params.get('risk')).toBe('HIGH')
    expect(params.get('q')).toBe('SKU-9')
    expect(params.get('qs')).toBe('a1,A1,b2')
    expect(params.has('bogus')).toBe(false)
    expect(screen.getByRole('tab', { name: '低库存' })).toHaveAttribute('aria-selected', 'true')
    const tags = within(screen.getByRole('list', { name: '已生效的条件' }))
    expect(tags.getByText(/SKU-9/)).toBeInTheDocument()
    expect(tags.getByText(/批量精确）：2 项/)).toBeInTheDocument()
  })

  it('默认视图保存了“低库存”页签：打开页面就套用并带 tab 参数；另一个失效的条件提示“有 N 个条件已失效”', async () => {
    const saved = {
      id: 'v1',
      gridId: 'inventory.health',
      kind: 'VIEW',
      scope: 'USER',
      name: '只看低库存',
      config: { hidden: [], order: [], widths: {}, pinned: {}, sort: null, filters: { tab: 'low', shop: 'S1' }, dimension: null },
      isDefault: true,
      version: 1,
      mine: true,
      canEdit: true,
      owner: { id: 'u1', name: '林然' },
      updatedAt: '2026-10-26T08:00:00.000Z',
    }
    const app = mountApp({ url: '/app/inventory', pages, handlers: handlers({ '/grid-views': () => ok({ ...NO_VIEWS, items: [saved] }) }) })
    await waitFor(() => expect(app.calls.some(call => call.path === '/inventory' && call.search.includes('tab=low'))).toBe(true))
    expect(await screen.findByText('有 1 个条件已失效，已忽略')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '低库存' })).toHaveAttribute('aria-selected', 'true')
  })

  it('点 SKU 在右侧抽屉里看行详情，不离开列表；点之前不取详情；抽屉有 6 项指标、页签与“在新页签打开完整详情”', async () => {
    const detail = { row: row(), policy: null, suggestions: [], freshness: freshness, productId: null }
    const app = mountApp({
      url: '/app/inventory',
      pages,
      handlers: handlers({
        '/inventory/inv1': () => ok(detail),
        '/inventory/inv1/structure': () => ok({ state: 'OK', note: null, from: '2026-09-22', to: '2026-10-22', points: [] }),
      }),
    })
    await screen.findByText('SKU-1')
    expect(app.calls.some(call => call.path === '/inventory/inv1')).toBe(false)
    await userEvent.click(screen.getByRole('link', { name: 'SKU-1' }))
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('可售数量')).toBeInTheDocument()
    expect(within(drawer).getByRole('tab', { name: '库存台账' })).toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: '在新页签打开完整详情' })).toHaveAttribute('href', expect.stringContaining('/app/inventory/inv1'))
    expect(screen.getByRole('heading', { name: '库存健康' })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/inventory/inv1')).toBe(true)
  })

  it('点 SKU 时按住 Ctrl 是链接的原生行为：不打开抽屉', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    fireEvent.click(screen.getByRole('link', { name: 'SKU-1' }), { ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('范围内 SKU 过多：提示只读取了前 5000 个', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers({ '/inventory': () => ok(list({ truncated: true })) }) })
    expect(await screen.findByText(/只读取了前 5000 个/)).toBeInTheDocument()
  })

  it('已配置规则：显示风险等级、可售天数与预计断货日；近期无销量写“近期无销量”', async () => {
    const assessed = row({
      assessment: {
        state: 'OK',
        reason: null,
        risk: 'HIGH',
        daysOfCover: 12.5,
        noDemand: false,
        stockoutDate: '2026-11-03',
        fastestLeadDays: 45,
        fastestReplenishDate: null,
        targetDays: 60,
        policyVersion: 2,
      },
    })
    const quiet = row({
      id: 'inv2',
      sku: 'SKU-2',
      assessment: { ...assessed.assessment, risk: 'EXCESS', daysOfCover: null, noDemand: true, stockoutDate: null },
    })
    mountApp({
      url: '/app/inventory',
      pages,
      handlers: handlers({
        '/inventory': () => ok(list({ items: [assessed, quiet], total: 2, policyState: 'OK', policyNote: null })),
        '/inventory/summary': () => ok(summary({ policyState: 'OK', policyNote: null, policyVersion: 2 })),
      }),
    })
    await screen.findByText('SKU-1')
    await waitFor(() => expect(rowText('inv1')).toContain('高风险（将断货）'))
    expect(rowText('inv1')).toContain('12.5')
    expect(rowText('inv1')).toContain('2026-11-03')
    expect(rowText('inv2')).toContain('近期无销量')
    expect(screen.queryByText('尚未配置库存规则')).not.toBeInTheDocument()
  })

  it('没有任何库存：写明前置条件，不显示示例行', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers({ '/inventory': () => ok(list({ items: [], total: 0 })) }) })
    expect(await screen.findByText(/范围内没有 FBA 库存记录/)).toBeInTheDocument()
  })

  it('规则抽屉：有写权限时提交新版本，带上当前版本号与调整原因', async () => {
    let putBody: Record<string, unknown> | undefined
    const current = policy()
    const app = mountApp({
      url: '/app/inventory',
      pages,
      handlers: handlers(
        {
          '/inventory/rules': (_url, init) => {
            if (init?.method === 'PUT') {
              putBody = JSON.parse(String(init.body))
              return ok(policy({ versionNo: 3 }))
            }
            return ok({ state: 'OK', note: null, current, history: [current] })
          },
        },
        ['inventory.read', 'replenishment.policy.write'],
      ),
    })
    await screen.findByText('SKU-1')
    await userEvent.click(screen.getByRole('button', { name: /库存规则/ }))
    const drawer = await screen.findByRole('dialog')
    expect((await within(drawer).findAllByText('旺季前调长提前期', { exact: false })).length).toBeGreaterThan(0)
    await userEvent.click(within(drawer).getByRole('button', { name: /保存新版本/ }))
    const dialogs = await screen.findAllByRole('dialog')
    const form = dialogs[dialogs.length - 1]
    await userEvent.type(within(form).getByLabelText('调整原因'), '提前期调到 50 天')
    await userEvent.click(within(form).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(putBody).toMatchObject({ expectedVersionNo: 2, leadTimeDays: 45, changeReason: '提前期调到 50 天' }))
    expect(app.calls.filter(call => call.path === '/inventory/rules' && call.method === 'PUT')).toHaveLength(1)
  })

  it('规则抽屉：没有写权限时只能看，保存按钮禁用', async () => {
    const current = policy()
    mountApp({ url: '/app/inventory', pages, handlers: handlers({ '/inventory/rules': () => ok({ state: 'OK', note: null, current, history: [current] }) }) })
    await screen.findByText('SKU-1')
    await userEvent.click(screen.getByRole('button', { name: /库存规则/ }))
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByRole('button', { name: /保存新版本/ })).toBeDisabled()
  })
})
