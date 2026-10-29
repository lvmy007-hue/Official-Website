import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../api'
import { renderWithApp } from '../../test/render'
import { dateTimeColumn, moneyColumn, numberColumn, percentColumn, textColumn, miniTrendColumn } from './columns'
import { MassiveGrid, COMPARE_MAX, COMPARE_MIN, type MassiveGridProps } from './MassiveGrid'
import { SimpleGrid } from './SimpleGrid'
import { buildTrendPath, MiniTrend } from '../metric/MiniTrend'
import type { CursorFetcher } from './cursor-datasource'

type Row = { id: string; name: string; sales: number; margin: number; at: string; trend: number[] }

const columns = [
  textColumn<Row>('名称', 'name'),
  moneyColumn<Row>('销售额', 'sales', { signed: true }),
  percentColumn<Row>('利润率', 'margin'),
  dateTimeColumn<Row>('时间', 'at'),
  numberColumn<Row>('件数', 'sales'),
  miniTrendColumn<Row>('趋势', row => row.trend),
]

const emptyState = { kind: 'empty' as const, domain: '本页展示订单明细', prerequisite: '先授权店铺并同步订单' }

function baseProps(fetchPage: CursorFetcher<Row>): MassiveGridProps<Row> {
  return { gridId: 'test-grid', columns, fetchPage, getRowId: row => row.id, resetKey: 'k1', emptyState, sortableFields: { sales: 'sales' } }
}

describe('表格列', () => {
  it('金额带币种、百分比、时间带时区、数字等宽右对齐', () => {
    const money = moneyColumn<Row>('销售额', 'sales', { signed: true })
    const format = money.valueFormatter as (p: { value: unknown; data?: Row }) => string
    expect(format({ value: 1234.5 })).toBe('+$1,234.50')
    expect(format({ value: null })).toBe('—')
    expect(money.type).toBe('rightAligned')
    const eur = moneyColumn<Row>('x', 'sales', { currency: () => 'EUR' })
    expect((eur.valueFormatter as (p: { value: unknown; data?: Row }) => string)({ value: 5, data: {} as Row })).toBe('EUR 5.00')
    expect((percentColumn<Row>('p', 'margin').valueFormatter as (p: { value: unknown }) => string)({ value: 0.123 })).toBe('12.3%')
    expect((dateTimeColumn<Row>('t', 'at').valueFormatter as (p: { value: unknown }) => string)({ value: '2026-10-20T10:00:00Z' })).toBe('2026-10-20 03:00 PDT')
    expect(numberColumn<Row>('n', 'sales').cellClass).toBe('erp-num')
  })

  it('成本类指标越低越好：负变化用正向色', () => {
    const cost = moneyColumn<Row>('费用', 'sales', { signed: true, goodWhen: 'down' })
    const cellClass = cost.cellClass as (p: { value: number }) => string
    expect(cellClass({ value: -5 })).toContain('erp-tone-positive')
    expect(cellClass({ value: 5 })).toContain('erp-tone-negative')
  })

  it('迷你趋势：折线路径、点数不足时显示占位', () => {
    expect(buildTrendPath([1], 96, 24)).toBe('')
    expect(buildTrendPath([1, 2, 3], 96, 24).startsWith('M2.0 22.0')).toBe(true)
    // 全部相同的值不应产生 NaN
    expect(buildTrendPath([5, 5, 5], 96, 24)).not.toContain('NaN')
    const { unmount } = renderWithApp(<MiniTrend points={[1, 3, 2]} label="销量趋势" />)
    expect(screen.getByRole('img', { name: /销量趋势：3 个点/ })).toBeInTheDocument()
    unmount()
    renderWithApp(<MiniTrend points={[1]} label="销量趋势" />)
    expect(screen.getByLabelText('销量趋势：数据不足')).toBeInTheDocument()
  })
})

describe('海量表格', () => {
  const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `商品${i}`, sales: i, margin: 0.1, at: '2026-10-20T10:00:00Z', trend: [1, 2, 3] }))

  it('挂载后从第一块取数：不带游标、每块 100 行', async () => {
    const fetchPage = vi.fn<CursorFetcher<Row>>(async () => ({ items: rows(3), nextCursor: null, approxTotal: 3 }))
    renderWithApp(<MassiveGrid {...baseProps(fetchPage)} />)
    await waitFor(() => expect(fetchPage).toHaveBeenCalled())
    expect(fetchPage.mock.calls[0]![0]).toMatchObject({ cursor: null, limit: 100 })
    expect(await screen.findByText('约 3 行')).toBeInTheDocument()
  })

  it('第一块没有数据：显示无数据状态（数据域说明与前置条件），不显示空表', async () => {
    renderWithApp(<MassiveGrid {...baseProps(async () => ({ items: [], nextCursor: null }))} />)
    expect(await screen.findByText('本页展示订单明细')).toBeInTheDocument()
    expect(screen.getByText(/先授权店铺并同步订单/)).toBeInTheDocument()
  })

  it('请求失败：显示服务端错误（带请求编号），点重试会重新取数', async () => {
    let fail = true
    const fetchPage = vi.fn<CursorFetcher<Row>>(async () => {
      if (fail) throw new ApiError(500, 'INTERNAL', '服务出错', undefined, { requestId: 'req-9' })
      return { items: rows(2), nextCursor: null }
    })
    renderWithApp(<MassiveGrid {...baseProps(fetchPage)} />)
    expect(await screen.findByText(/请求编号：req-9/)).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    await waitFor(() => expect(screen.queryByText(/请求编号：req-9/)).toBeNull())
    expect(fetchPage.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('筛选条件变化（resetKey）：丢弃旧游标，从第一块重新取', async () => {
    const fetchPage = vi.fn<CursorFetcher<Row>>(async () => ({ items: rows(2), nextCursor: null }))
    const { rerender } = renderWithApp(<MassiveGrid {...baseProps(fetchPage)} />)
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    rerender(<MassiveGrid {...baseProps(fetchPage)} resetKey="k2" />)
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2))
    expect(fetchPage.mock.calls[1]![0].cursor).toBeNull()
  })

  it('已应用条件个数；有条件时才出现“清除条件”', async () => {
    const onClear = vi.fn()
    const fetchPage = async () => ({ items: rows(1), nextCursor: null })
    const { rerender } = renderWithApp(<MassiveGrid {...baseProps(fetchPage)} appliedFilterCount={0} onClearFilters={onClear} />)
    expect(screen.getByText('已应用 0 个条件')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /清除条件/ })).toBeNull()
    rerender(<MassiveGrid {...baseProps(fetchPage)} appliedFilterCount={3} onClearFilters={onClear} />)
    expect(screen.getByText('已应用 3 个条件')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /清除条件/ }))
    expect(onClear).toHaveBeenCalled()
  })

  it('没有接口支撑的功能不显示：未传导出、保存视图、对比则没有对应按钮', () => {
    renderWithApp(<MassiveGrid {...baseProps(async () => ({ items: rows(1), nextCursor: null }))} />)
    expect(screen.queryByRole('button', { name: /导\s*出/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /保存视图/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /对比所选/ })).toBeNull()
    expect(screen.getByRole('button', { name: /列设置/ })).toBeInTheDocument()
  })

  it('导出：能力存在但不可用时禁用并说明；可用时调用', async () => {
    const fetchPage = async () => ({ items: rows(1), nextCursor: null })
    const { rerender } = renderWithApp(<MassiveGrid {...baseProps(fetchPage)} exportDisabledReason="缺少导出权限" />)
    expect(screen.getByRole('button', { name: /导\s*出/ })).toBeDisabled()
    const onExport = vi.fn(async () => undefined)
    rerender(<MassiveGrid {...baseProps(fetchPage)} onExport={onExport} />)
    await userEvent.click(screen.getByRole('button', { name: /导\s*出/ }))
    expect(onExport).toHaveBeenCalledTimes(1)
  })

  it('对比模式：未选够时禁用并说明范围（2 至 5 个）', () => {
    expect([COMPARE_MIN, COMPARE_MAX]).toEqual([2, 5])
    renderWithApp(<MassiveGrid {...baseProps(async () => ({ items: rows(1), nextCursor: null }))} onCompare={() => undefined} />)
    expect(screen.getByRole('button', { name: /对比所选/ })).toBeDisabled()
  })

  it('列配置：取消勾选某列后记在本机，下次打开仍然隐藏', async () => {
    window.localStorage.clear()
    const fetchPage = async () => ({ items: rows(1), nextCursor: null })
    const first = renderWithApp(<MassiveGrid {...baseProps(fetchPage)} />)
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '利润率' }))
    expect(JSON.parse(window.localStorage.getItem('erp.grid.test-grid.hidden-columns')!)).toEqual(['margin'])
    first.unmount()
    renderWithApp(<MassiveGrid {...baseProps(fetchPage)} />)
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    expect(await screen.findByRole('checkbox', { name: '利润率' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '名称' })).toBeChecked()
  })

  it('没有开启服务端视图的表格：工具栏里没有视图入口（不做假按钮），沿用本机列配置', () => {
    renderWithApp(<MassiveGrid {...baseProps(async () => ({ items: rows(1), nextCursor: null }))} />)
    expect(screen.queryByRole('button', { name: /视图/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /另存为/ })).toBeNull()
  })
})

describe('中小表格', () => {
  const emptyProps = { emptyState: { kind: 'empty' as const, domain: '成员列表', prerequisite: '先邀请成员' } }
  const cols = [{ title: '姓名', dataIndex: 'name' }]

  it('首次加载显示骨架；出错显示错误状态与重试；无数据显示说明', async () => {
    const onRetry = vi.fn()
    const { rerender } = renderWithApp(<SimpleGrid gridId="test.simple" columns={cols} rows={undefined} loading rowKey={r => (r as { name: string }).name} {...emptyProps} />)
    expect(screen.getByLabelText('正在加载')).toBeInTheDocument()
    rerender(<SimpleGrid gridId="test.simple" columns={cols} rows={undefined} error={new ApiError(500, 'X', '出错了')} onRetry={onRetry} rowKey={r => (r as { name: string }).name} {...emptyProps} />)
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(onRetry).toHaveBeenCalled()
    rerender(<SimpleGrid gridId="test.simple" columns={cols} rows={[]} rowKey={r => (r as { name: string }).name} {...emptyProps} />)
    expect(await screen.findByText('成员列表')).toBeInTheDocument()
  })
})
