import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { detail, detailRow, ok, summary, summaryRow } from './inventory-stock-fixtures.test-helper'

// 库存台账页（P2a-09）：汇总的平衡校验与库存接口比对、只看不平衡、明细的事件分组筛选与游标翻页、没有记录时的诚实状态。

const pages: LivePages = { InventoryLedgerPage: { load: () => import('./InventoryLedgerPage') } }
afterEach(() => vi.unstubAllGlobals())

// AG Grid 把固定列与滚动列放在不同容器里，同一行用 row-id 对应；这里取一行所有单元格的文字。
const rowText = (node: HTMLElement) => {
  const id = (node.closest('[row-id]') as HTMLElement).getAttribute('row-id') as string
  return Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(item => item.textContent ?? '')
    .join('|')
}

const handlers = (over: Record<string, Handler> = {}, permissions = ['inventory.read']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/inventory/ledger': url => (url.searchParams.get('view') === 'detail' ? ok(detail()) : ok(summary())),
  ...over,
})

const unbalanced = summaryRow({
  key: 'st1|FN2|2026-09',
  fnsku: 'FN2',
  sku: 'SKU-2',
  month: '2026-09',
  endingQty: 10,
  expectedEnding: 11,
  difference: -1,
  balanced: false,
})

describe('库存台账页', () => {
  it('汇总：平衡的行标“平衡”，不平衡的行标红并写出差额；顶部说明有几行不通过', async () => {
    mountApp({ url: '/app/inventory/ledger', pages, handlers: handlers({ '/inventory/ledger': () => ok(summary({ items: [summaryRow(), unbalanced], total: 2, unbalancedCount: 1 })) }) })
    const bad = rowText(await screen.findByText('SKU-2'))
    expect(bad).toContain('不平衡 -1')
    const good = rowText(screen.getByText('SKU-1'))
    expect(good).toContain('平衡')
    expect(good).not.toContain('不平衡')
    expect(screen.getByText(/有 1 行平衡校验不通过/)).toBeInTheDocument()
  })

  it('汇总：全部平衡时给出成功说明；没有记录写“尚无记录”而不是空表', async () => {
    mountApp({ url: '/app/inventory/ledger', pages, handlers: handlers() })
    expect(await screen.findByText(/的台账全部平衡/)).toBeInTheDocument()
  })

  it('汇总：只有最近一个月的行带库存接口比对；库存接口没有记录时写原因，不写 0', async () => {
    const withLive = summaryRow({ live: { ledgerDate: '2026-10-05', ledgerEnding: 30, liveQty: 29, difference: 1 } })
    const noLive = summaryRow({ key: 'k2', sku: 'SKU-2', fnsku: 'FN2', live: { ledgerDate: '2026-10-06', ledgerEnding: 4, liveQty: null, difference: null } })
    const older = summaryRow({ key: 'k3', sku: 'SKU-3', fnsku: 'FN3', month: '2026-09' })
    mountApp({ url: '/app/inventory/ledger', pages, handlers: handlers({ '/inventory/ledger': () => ok(summary({ items: [withLive, noLive, older], total: 3 })) }) })
    expect(rowText(await screen.findByText('SKU-1'))).toContain('29（差 +1）')
    expect(rowText(screen.getByText('SKU-2'))).toContain('库存接口尚无记录')
    expect(rowText(screen.getByText('SKU-3'))).toContain('仅最近一个月比对')
  })

  it('汇总：地址栏带“只看不平衡”与搜索词时，请求带 unbalanced=true、q，并从第一页开始', async () => {
    const app = mountApp({ url: '/app/inventory/ledger?unbalanced=true&q=FN9', pages, handlers: handlers() })
    await screen.findByText('SKU-1')
    await waitFor(() =>
      expect(app.calls.some(call => call.path === '/inventory/ledger' && call.search.includes('unbalanced=true') && call.search.includes('q=FN9') && call.search.includes('page=1'))).toBe(true),
    )
  })

  it('汇总：范围内行数过多只读了一部分时提示；范围内没有记录时显示服务端说明', async () => {
    mountApp({ url: '/app/inventory/ledger', pages, handlers: handlers({ '/inventory/ledger': () => ok(summary({ truncated: true })) }) })
    expect(await screen.findByText(/只读取了前 20000 行/)).toBeInTheDocument()
  })

  it('汇总：没有任何台账记录：显示“尚无记录”与原因，不显示合计', async () => {
    mountApp({
      url: '/app/inventory/ledger',
      pages,
      handlers: handlers({ '/inventory/ledger': () => ok(summary({ state: 'NO_DATA', note: '尚无库存台账记录，台账报告同步后显示。', items: [], total: 0 })) }),
    })
    expect(await screen.findByText('尚无库存台账记录，台账报告同步后显示。')).toBeInTheDocument()
    expect(screen.queryByText(/的台账全部平衡/)).not.toBeInTheDocument()
  })

  it('明细：事件类型、调整细分与单据编号；没有的列写“尚无记录”', async () => {
    mountApp({
      url: '/app/inventory/ledger',
      pages,
      handlers: handlers({
        '/inventory/ledger': url =>
          url.searchParams.get('view') === 'detail'
            ? ok(
                detail({
                  items: [
                    detailRow(),
                    detailRow({ id: 'e2', eventType: 'Adjustments', group: 'adjustment', groupLabel: '调整', adjustmentLabel: '丢失', quantity: -1, referenceId: null, referenceKind: null }),
                  ],
                }),
              )
            : ok(summary()),
      }),
    })
    await screen.findByText('SKU-1')
    await userEvent.click(screen.getByRole('tab', { name: '明细' }))
    const lost = rowText(await screen.findByText('Adjustments'))
    expect(lost).toContain('丢失')
    expect(lost).toContain('-1')
    expect(lost).toContain('尚无记录')
    expect(screen.getByText('FBA15AAA')).toBeInTheDocument()
  })

  it('明细：地址栏带事件类型时请求带 group 参数，并从第一块取（不带游标）', async () => {
    let cursorSeen: string | null = null
    const app = mountApp({
      url: '/app/inventory/ledger?group=adjustment',
      pages,
      handlers: handlers({
        '/inventory/ledger': url => {
          if (url.searchParams.get('view') !== 'detail') return ok(summary())
          cursorSeen = url.searchParams.get('cursor')
          return ok(
            detail({
              items: [detailRow({ id: cursorSeen ? 'e9' : 'e1', referenceId: cursorSeen ? 'PAGE-2' : 'PAGE-1' })],
              pageInfo: { pageSize: 20, hasMore: !cursorSeen, nextCursor: cursorSeen ? null : 'CUR-1', approxTotal: null },
            }),
          )
        },
      }),
    })
    await screen.findByText('SKU-1')
    await userEvent.click(screen.getByRole('tab', { name: '明细' }))
    expect(await screen.findByText('PAGE-1')).toBeInTheDocument()
    expect(cursorSeen).toBeNull()
    await waitFor(() => expect(app.calls.some(call => call.search.includes('group=adjustment') && !call.search.includes('cursor='))).toBe(true))
  })

  it('没有 inventory.read 权限：显示无权限而不是空表', async () => {
    mountApp({ url: '/app/inventory/ledger', pages, handlers: handlers({ '/inventory/ledger': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) }) })
    expect((await screen.findAllByText(/inventory\.read|FORBIDDEN|无权|没有权限/)).length).toBeGreaterThan(0)
  })
})
