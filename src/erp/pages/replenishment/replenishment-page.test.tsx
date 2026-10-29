import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { NO_VIEWS, rowText } from '../inventory/inventory-fixtures.test-helper'
import { ok, rec, recommendations, snapshot, summary } from './replenishment-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 补货建议页（P2a-07，P6-09 迁到 PagedGrid）：批次与建议列表、行详情抽屉里的计算链、必断货量与人工规则、快捷筛选、批量动作、权限禁用。

const pages: LivePages = {
  ReplenishmentPage: { load: () => import('./ReplenishmentPage') },
  ReplenishmentBatchDetailPage: { load: () => import('./ReplenishmentBatchDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok(NO_VIEWS),
  '/replenishment/batches': () => ok({ items: [summary()], page: 1, pageSize: 20, total: 1 }),
  '/replenishment/recommendations': () => ok(recommendations()),
  ...over,
})

const lastDialog = async () => {
  const dialogs = await screen.findAllByRole('dialog')
  return dialogs[dialogs.length - 1]
}
/** 点列表里的一行（点任意单元格都会在右侧打开详情抽屉）。 */
const openRow = async (id: string) => {
  const cell = document.querySelector(`[row-id="${id}"] [col-id="risk"]`) as HTMLElement
  await userEvent.click(cell)
  return lastDialog()
}
const selectRow = async (id: string) => {
  await userEvent.click(document.querySelector(`[row-id="${id}"] .ag-selection-checkbox input`) as HTMLElement)
  return screen.findByRole('toolbar', { name: '批量操作' })
}

describe('补货建议页', () => {
  it('列表：风险、建议量、必断货量、建议发货日（距今天数）并列；没产出建议的 SKU 按原因计数', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers() })
    expect(await screen.findByText('没有销量记录，无法预测需求 3 个；无需补货 7 个')).toBeInTheDocument()
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    expect(rowText('r2')).toContain('SKU-B')
    expect(rowText('r1')).toContain('高风险（将断货）')
    // 必断货量 130，未计入；建议发货日 2026-10-30，距今 8 天
    expect(rowText('r1')).toContain('130')
    expect(rowText('r1')).toContain('未计入')
    expect(rowText('r1')).toContain('8 天后')
  })

  it('旧批次没有必断货量记录：写“旧批次没有记录”，不显示 0；已逾期的发货日标红字样', async () => {
    const legacy = rec({ supplyInLeadTime: null, supplyBeyondLeadTime: null, unavoidableShortage: null, unavoidableIncluded: null, shipInDays: -3 })
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/recommendations': () => ok(recommendations([legacy])) }) })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    expect(rowText('r1')).toContain('旧批次没有记录')
    expect(rowText('r1')).toContain('已逾期 3 天')
  })

  it('点一行打开抽屉：计算链逐步展开；供给与必断货页签写明提前期内外供给；亚马逊对照页签并排比较', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers() })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    const drawer = await openRow('r1')
    expect(await within(drawer).findByTestId('calc-steps')).toBeInTheDocument()
    expect(within(drawer).getByText(/第 1 步 需求预测/)).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('tab', { name: '供给与必断货' }))
    const supply = await within(drawer).findByTestId('supply-split')
    expect(within(supply).getByText('提前期内供给')).toBeInTheDocument()
    expect(within(supply).getByText(/未计入（策略开关默认关闭）/)).toBeInTheDocument()
    expect(within(drawer).getByText('这条建议没有命中人工预测规则，需求用模型预测。')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('tab', { name: '亚马逊对照' }))
    const compare = await within(drawer).findByTestId('amazon-compare')
    expect(within(compare).getByText(/我方少 60 件/)).toBeInTheDocument()
    expect(within(compare).getByText('亚马逊按其自己的预测日销计算，口径不同')).toBeInTheDocument()
  })

  it('命中人工预测规则：列表标“人工规则”，抽屉里列出规则、起止日期与取代天数；缺去年数据没生效的写明原因', async () => {
    const applied = [
      { id: 'o1', scopeType: 'SKU' as const, scopeId: 'SKU-A', mode: 'FIXED' as const, value: 20, from: '2026-11-01', to: '2026-11-30', rate: 20, days: 30, applied: true, note: null },
      {
        id: 'o2',
        scopeType: 'CATEGORY' as const,
        scopeId: '耳机',
        mode: 'YOY_FACTOR' as const,
        value: 1.2,
        from: '2026-12-01',
        to: '2026-12-10',
        rate: null,
        days: 0,
        applied: false,
        note: '去年同期没有销量记录，规则没有生效，这段时间按模型预测',
      },
    ]
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/recommendations': () => ok(recommendations([rec({ appliedOverride: applied })])) }) })
    await waitFor(() => expect(rowText('r1')).toContain('人工规则 1 条'))
    expect(rowText('r1')).toContain('未生效 1 条')
    const drawer = await openRow('r1')
    await userEvent.click(await within(drawer).findByRole('tab', { name: '供给与必断货' }))
    const list = await within(drawer).findByTestId('applied-overrides')
    expect(within(list).getByText(/固定日销 20 件\/天（日销 20.00 件\/天）：取代模型预测 30 天/)).toBeInTheDocument()
    expect(within(list).getByText(/未生效，去年同期没有销量记录/)).toBeInTheDocument()
  })

  it('亚马逊没有这条建议：写“尚无记录”，不显示 0', async () => {
    const noAmazon = rec({ amazon: { qty: null, shipDate: null, diffQty: null, diffReason: null, snapshotDate: null } })
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/recommendations': () => ok(recommendations([noAmazon])) }) })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    expect(rowText('r1')).toContain('尚无记录')
  })

  it('快捷筛选：“本周需发货”“已逾期”带 due 参数重新取数，再点一次取消', async () => {
    const app = mountApp({ url: '/app/replenishment', pages, handlers: handlers() })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    const week = screen.getByRole('button', { name: '本周需发货' })
    expect(week).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(week)
    await waitFor(() => expect(app.calls.some(call => call.path === '/replenishment/recommendations' && call.search.includes('due=WEEK'))).toBe(true))
    expect(screen.getByRole('button', { name: '本周需发货' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: '已逾期' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/replenishment/recommendations' && call.search.includes('due=OVERDUE'))).toBe(true))
    expect(screen.getByRole('button', { name: '本周需发货' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('还没有批次：说明先配置策略再计算，不显示空表', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/batches': () => ok({ items: [], page: 1, pageSize: 20, total: 0 }),
        '/replenishment/recommendations': () => ok({ batch: null, snapshot: null, items: [], page: 1, pageSize: 20, total: 0 }),
      }),
    })
    expect(await screen.findByText(/还没有计算过/)).toBeInTheDocument()
  })

  it('重新计算：提交后带上新批次重新取数', async () => {
    let posted = 0
    const app = mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/recompute': () => {
          posted += 1
          return { status: 201, body: { success: true, data: { batch: summary({ id: 'b2', batchNo: 'RB-20261022-002' }), snapshot: snapshot() } } }
        },
      }),
    })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    await userEvent.click(screen.getByRole('button', { name: /重新计算/ }))
    const dialog = await lastDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /开始计算/ }))
    await waitFor(() => expect(posted).toBe(1))
    await waitFor(() => expect(app.calls.some(call => call.path === '/replenishment/recommendations' && call.search.includes('batchId=b2'))).toBe(true))
  })

  it('批量采纳：勾选后出现批量操作条，提交带上建议编号与动作；没勾选时不显示动作条', async () => {
    let body: { items: Array<Record<string, unknown>> } | undefined
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1/decisions': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: { updated: 1, batchStatus: 'CONFIRMED' } } }
        },
      }),
    })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    expect(screen.queryByRole('toolbar', { name: '批量操作' })).not.toBeInTheDocument()
    const bar = await selectRow('r1')
    await userEvent.click(within(bar).getByRole('button', { name: /^采\s?纳$/ }))
    const dialog = await lastDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /^采\s?纳$/ }))
    await waitFor(() => expect(body).toEqual({ items: [{ recommendationId: 'r1', action: 'ADOPT' }] }))
  })

  it('没有“生成补货计划”权限：重新计算与批量动作都禁用', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({}, ['replenishment.read']) })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    expect(screen.getByRole('button', { name: /重新计算/ })).toBeDisabled()
    const bar = await selectRow('r1')
    expect(within(bar).getByRole('button', { name: /^采\s?纳$/ })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: /生成采购单草稿/ })).toBeDisabled()
  })

  it('搜索带 q 参数重新取数', async () => {
    const app = mountApp({ url: '/app/replenishment', pages, handlers: handlers() })
    await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
    await userEvent.type(screen.getByLabelText('搜索建议'), 'SKU-B{enter}')
    await waitFor(() => expect(app.calls.some(call => call.path === '/replenishment/recommendations' && call.search.includes('q=SKU-B'))).toBe(true))
  })

  it('建议接口失败：显示服务端原因，不渲染空表', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({ '/replenishment/recommendations': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '批次不存在' } } }) }),
    })
    expect((await screen.findAllByText(/批次不存在/)).length).toBeGreaterThan(0)
  })
})
