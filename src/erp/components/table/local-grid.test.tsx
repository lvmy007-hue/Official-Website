import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithApp } from '../../test/render'
import { numberColumn, textColumn } from './columns'
import { LocalGrid } from './LocalGrid'

// 本地分页表格（P6-28）：整份数据已在页面里，只在本地按页切片；数据引用变化回到第 1 页，空数据显示页面给的说明。

type Row = { id: string; name: string; units: number }
const makeRows = (count: number, prefix = '商品'): Row[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}`, units: i }))
const columns = [{ ...textColumn<Row>('名称', 'name'), pin: 'left' as const }, numberColumn<Row>('件数', 'units')]
const emptyState = { kind: 'empty' as const, domain: '本地数据', prerequisite: '范围内没有数据' }
const base = { gridId: 'local-test', columns, getRowId: (row: Row) => row.id, emptyState, initialPageSize: 20 as const }

describe('本地分页表格', () => {
  it('按页切片：第 1 页 20 行，点第 2 页显示后面的行；总数来自整份数据', async () => {
    renderWithApp(<LocalGrid<Row> {...base} rows={makeRows(45)} />)
    expect(await screen.findByText('商品0')).toBeInTheDocument()
    expect(screen.queryByText('商品20')).toBeNull()
    expect(await screen.findByText('共 45 条')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('2'))
    expect(await screen.findByText('商品20')).toBeInTheDocument()
  })

  it('数据换了（引用变化）：回到第 1 页并显示新数据', async () => {
    const { rerender } = renderWithApp(<LocalGrid<Row> {...base} rows={makeRows(45)} />)
    await screen.findByText('商品0')
    await userEvent.click(screen.getByTitle('2'))
    await screen.findByText('商品20')
    rerender(<LocalGrid<Row> {...base} rows={makeRows(3, '新品')} />)
    expect(await screen.findByText('新品0')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('商品20')).toBeNull())
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })

  it('没有数据：显示页面给的空状态说明，不画空表', async () => {
    renderWithApp(<LocalGrid<Row> {...base} rows={[]} />)
    expect(await screen.findByText(/范围内没有数据/)).toBeInTheDocument()
  })
})
