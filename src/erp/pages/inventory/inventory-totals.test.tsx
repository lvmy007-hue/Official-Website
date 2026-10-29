import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { list, NO_VIEWS, ok, summary, summaryText } from './inventory-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 库存健康的“范围内合计”行（P6-02 示范，现在是表头下方的固定汇总行）：数字只取服务端汇总，前端不求和；对不上口径时不显示。

const pages: LivePages = { InventoryHealthPage: { load: () => import('./InventoryHealthPage') } }
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['inventory.read'] }),
  '/inventory': () => ok(list()),
  '/grid-views': () => ok(NO_VIEWS),
  '/inventory/summary': () => ok(summary()),
  '/inventory/rules': () => ok({ state: 'NOT_CONNECTED', note: '', current: null, history: [] }),
  ...over,
})

describe('库存健康：范围内合计行', () => {
  it('全部库存页签：显示服务端合计；没有合计的列显示“—”；没数据的金额合计显示“—”而不是 $0.00', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    await waitFor(() => expect(summaryText()).toContain('1,234'))
    const text = summaryText()!
    expect(text).toContain('汇总')
    expect(text).toContain('1,234')
    expect(text).toContain('35')
    expect(text).not.toContain('$0.00')
    // 当前页只有一行（可售不是 1,234），说明合计不是前端把当前页加起来的
    expect(text).toContain('—')
  })

  it('切到其他页签或搜索时不显示合计（合计覆盖范围内全部库存，和筛选后的列表对不上）', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    await waitFor(() => expect(summaryText()).toContain('1,234'))
    await userEvent.click(screen.getByRole('tab', { name: '低库存' }))
    await waitFor(() => expect(summaryText()).toBeNull())
    await userEvent.click(screen.getByRole('tab', { name: '全部库存' }))
    await waitFor(() => expect(summaryText()).toContain('1,234'))
    await userEvent.type(screen.getByLabelText('搜索库存'), 'SKU-9{enter}')
    await waitFor(() => expect(summaryText()).toBeNull())
  })

  it('范围内 SKU 过多被截断时不显示合计（合计只含前一部分）', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers({ '/inventory/summary': () => ok(summary({ truncated: true })) }) })
    await screen.findByText('SKU-1')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(summaryText()).toBeNull()
  })

  it('汇总还没返回或读取失败：没有合计行，列表照常显示', async () => {
    mountApp({ url: '/app/inventory', pages, handlers: handlers({ '/inventory/summary': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: '服务出错' } } }) }) })
    await screen.findByText('SKU-1')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(summaryText()).toBeNull()
  })
})
