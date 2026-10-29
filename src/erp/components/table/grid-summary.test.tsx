import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithApp } from '../../test/render'
import { moneyColumn, numberColumn, textColumn } from './columns'
import { MassiveGrid } from './MassiveGrid'
import type { FetchSummary, GridSummaryResponse } from './grid-types'

// 汇总行在无限滚动表格里（P6-02）：固定在表头下方、只取服务端口径、读取失败不拿 0 充数、币种随行变化时用汇总币种。

type Row = { id: string; name: string; units: number; sales: number; cur: string }
const rows = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, name: `商品${i}`, units: i + 1, sales: (i + 1) * 5, cur: 'EUR' }))
const emptyState = { kind: 'empty' as const, domain: '本页展示订单', prerequisite: '先同步订单' }
const base = (fetchSummary?: FetchSummary, currency?: (row: Row) => string) => ({
  gridId: 'sum-test',
  columns: [textColumn<Row>('名称', 'name'), numberColumn<Row>('件数', 'units'), moneyColumn<Row>('销售额', 'sales', currency ? { currency } : {})],
  fetchPage: async () => ({ items: rows(3), nextCursor: null }),
  getRowId: (row: Row) => row.id,
  resetKey: 'k1',
  emptyState,
  fetchSummary,
})
const pinned = () => document.querySelector('.ag-row-pinned') as HTMLElement | null

describe('无限滚动表格的汇总行', () => {
  it('显示服务端汇总：固定行里有“汇总”和服务端给的数；前端不求和（数据行共 6 件，汇总给 500 就显示 500）', async () => {
    renderWithApp(<MassiveGrid {...base(async () => ({ totals: { units: 500, sales: 12345.5 } }))} />)
    await screen.findByText('商品2')
    await waitFor(() => expect(pinned()?.textContent).toContain('汇总'))
    expect(pinned()?.textContent).toContain('500')
    expect(pinned()?.textContent).toContain('$12,345.50')
    expect(pinned()?.textContent).not.toContain('$30.00')
  })

  it('取汇总期间显示“汇总（加载中）”占位行，返回后换成数字', async () => {
    let release: (value: GridSummaryResponse) => void = () => undefined
    renderWithApp(<MassiveGrid {...base(() => new Promise<GridSummaryResponse>(resolve => (release = resolve)))} />)
    await screen.findByText('商品0')
    await waitFor(() => expect(pinned()?.textContent).toContain('汇总（加载中）'))
    release({ totals: { units: 9 } })
    await waitFor(() => expect(pinned()?.textContent).not.toContain('加载中'))
    expect(pinned()?.textContent).toContain('9')
  })

  it('汇总币种随行变化的金额列：汇总接口给了币种就带币种，没给就显示“—”', async () => {
    const first = renderWithApp(
      <MassiveGrid
        {...base(
          async () => ({ totals: { sales: 77 }, currency: 'EUR' }),
          r => r.cur,
        )}
      />,
    )
    await screen.findByText('商品0')
    await waitFor(() => expect(pinned()?.textContent).toContain('EUR 77.00'))
    first.unmount()
    renderWithApp(
      <MassiveGrid
        {...base(
          async () => ({ totals: { sales: 77 } }),
          r => r.cur,
        )}
      />,
    )
    await screen.findByText('商品0')
    await waitFor(() => expect(pinned()?.textContent).toContain('汇总'))
    expect(pinned()?.textContent).not.toContain('77')
  })

  it('响应格式不对（没有 totals）按失败处理；失败不显示汇总行，提示可重试', async () => {
    const bad = vi.fn(async () => ({}) as unknown as GridSummaryResponse)
    renderWithApp(<MassiveGrid {...base(bad)} />)
    expect(await screen.findByText(/汇总暂时读不到/)).toBeInTheDocument()
    expect(pinned()).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /重试汇总/ }))
    await waitFor(() => expect(bad).toHaveBeenCalledTimes(2))
  })

  it('汇总里的非数字被当成“没有值”显示“—”，不显示 NaN', async () => {
    renderWithApp(<MassiveGrid {...base(async () => ({ totals: { units: Number.NaN, sales: null } }))} />)
    await screen.findByText('商品0')
    await waitFor(() => expect(pinned()?.textContent).toContain('汇总'))
    expect(pinned()?.textContent).not.toContain('NaN')
  })

  it('筛选条件变化重新取汇总，并且取数请求带着新的 AbortSignal', async () => {
    const signals: AbortSignal[] = []
    const fetchSummary: FetchSummary = async ({ signal }) => {
      signals.push(signal)
      return { totals: { units: signals.length } }
    }
    const { rerender } = renderWithApp(<MassiveGrid {...base(fetchSummary)} />)
    await waitFor(() => expect(signals).toHaveLength(1))
    rerender(<MassiveGrid {...base(fetchSummary)} resetKey="k2" />)
    await waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
  })
})
