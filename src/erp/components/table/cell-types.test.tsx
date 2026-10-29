import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { ICellRendererParams, ValueFormatterParams } from 'ag-grid-community'
import { ErpConfigProvider } from '../../theme/ErpConfigProvider'
import { moneyColumn } from './columns'
import { actionColumn, deltaColumn, dualRowColumn, estimateColumn, personColumn, productColumn, progressColumn, statusColumn, timeColumn, DeltaText } from './cell-types'
import type { ErpColDef } from './grid-types'

// 统一单元格类型（P6-02）：商品、金额（负数红色）、涨跌、双行、状态、进度、人员、时间、估算值、操作列。空值一律“—”。

type Row = { name: string | null; sales: number | null; prev: number | null; rate: number | null; status: string | null; done: number | null; at: string | null; owner: string | null; cur: string }

const row = (over: Partial<Row> = {}): Row => ({ name: '护腰带', sales: 120, prev: 100, rate: 0.2, status: 'OK', done: 0.456, at: '2026-10-20T10:00:00Z', owner: '张三', cur: 'EUR', ...over })
const params = (data: Row | undefined, value?: unknown, extra: Record<string, unknown> = {}) => ({ data, value, node: {}, ...extra }) as unknown as ICellRendererParams<Row>
const renderCell = <T,>(col: ErpColDef<T>, p: ICellRendererParams<T>) => {
  const Renderer = col.cellRenderer as (p: ICellRendererParams<T>) => ReactElement | null
  return render(<ErpConfigProvider>{Renderer(p)}</ErpConfigProvider>)
}
const format = <T,>(col: ErpColDef<T>, value: unknown, data?: T, extra: Record<string, unknown> = {}) =>
  (col.valueFormatter as (p: ValueFormatterParams<T>) => string)({ value, data, ...extra } as unknown as ValueFormatterParams<T>)

describe('商品列', () => {
  const col = productColumn<Row>('商品', r => ({ imageUrl: 'https://img.example/a.png', title: r.name, asin: 'B0TEST0001', sku: 'SKU-1', storeName: '美国主店', site: 'US' }))

  it('默认固定在左；显示标题、ASIN 与 SKU、店铺与站点代码（不用国旗表情）；图片不重复朗读', () => {
    expect(col.pin).toBe('left')
    const { container } = renderCell(col, params(row()))
    expect(screen.getByText('护腰带')).toBeInTheDocument()
    expect(screen.getByText('B0TEST0001 · SKU-1')).toBeInTheDocument()
    expect(screen.getByText('美国主店 · US')).toBeInTheDocument()
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
  })

  it('没有标题写“尚无标题”，没有图片用占位框；没有行数据（占位行）不渲染', () => {
    const { container } = renderCell(col, params(row({ name: null })))
    expect(screen.getByText('尚无标题')).toBeInTheDocument()
    const bare = productColumn<Row>('商品', () => ({}))
    const second = renderCell(bare, params(row()))
    expect(second.container.querySelector('img')).toBeNull()
    expect(container).toBeTruthy()
    expect(renderCell(col, params(undefined)).container.textContent).toBe('')
  })
})

describe('金额列', () => {
  it('带币种；负数默认红色，正数不着色；signed 时按好坏着色', () => {
    const plain = moneyColumn<Row>('销售额', 'sales')
    const cls = plain.cellClass as (p: { value: number | null }) => string
    expect(cls({ value: -5 })).toContain('erp-tone-negative')
    expect(cls({ value: 5 })).not.toContain('erp-tone-')
    expect(cls({ value: null })).not.toContain('erp-tone-')
    expect(format(plain, -5)).toBe('-$5.00')
  })

  it('币种随行变化时，汇总行用汇总接口给的币种，没有就显示“—”', () => {
    const col = moneyColumn<Row>('销售额', 'sales', { currency: r => r.cur })
    expect(format(col, 10, row())).toBe('EUR 10.00')
    expect(format(col, 10, undefined, { node: { rowPinned: 'top' }, context: { summaryCurrency: 'GBP' } })).toBe('GBP 10.00')
    expect(format(col, 10, undefined, { node: { rowPinned: 'top' }, context: {} })).toBe('—')
  })
})

describe('涨跌与双行', () => {
  it('涨显示向上箭头与正向色，跌显示向下箭头；成本类越低越好；没有可比数据显示“—”', () => {
    const { container, rerender } = render(<DeltaText ratio={0.123} />)
    expect(container.textContent).toBe('▲ 12.3%')
    expect(container.querySelector('.erp-tone-positive')).not.toBeNull()
    rerender(<DeltaText ratio={-0.05} />)
    expect(container.textContent).toBe('▼ 5.0%')
    expect(container.querySelector('.erp-tone-negative')).not.toBeNull()
    rerender(<DeltaText ratio={-0.05} goodWhen="down" />)
    expect(container.querySelector('.erp-tone-positive')).not.toBeNull()
    rerender(<DeltaText ratio={null} />)
    expect(container.textContent).toBe('—')
    rerender(<DeltaText ratio={0} />)
    expect(container.querySelector('.erp-tone-neutral')).not.toBeNull()
  })

  it('涨跌列：格式化带正负号', () => {
    expect(format(deltaColumn<Row>('同比', 'rate'), 0.2)).toBe('+20.0%')
    expect(format(deltaColumn<Row>('同比', 'rate'), null)).toBe('—')
  })

  it('双行：本期值，加上期值与涨跌；涨跌优先用服务端给的值，没有就按本期与上期算；上期为 0 或没有时不算', () => {
    const base = { colId: 'sales', current: (r: Row) => r.sales, previous: (r: Row) => r.prev, format: { kind: 'money' as const, currency: 'USD' } }
    const col = dualRowColumn<Row>('销售额', base)
    const { container } = renderCell(col, params(row()))
    expect(screen.getByText('$120.00')).toBeInTheDocument()
    expect(screen.getByText('上期 $100.00')).toBeInTheDocument()
    expect(container.textContent).toContain('▲ 20.0%')
    const served = renderCell(dualRowColumn<Row>('销售额', { ...base, change: () => 0.5 }), params(row()))
    expect(served.container.textContent).toContain('▲ 50.0%')
    const zero = renderCell(dualRowColumn<Row>('销售额', base), params(row({ prev: 0 })))
    expect(zero.container.textContent).toContain('上期 $0.00')
    expect(within(zero.container).queryByLabelText(/涨跌 /)).toBeNull()
    const missing = renderCell(dualRowColumn<Row>('销售额', base), params(row({ sales: null, prev: null })))
    expect(missing.container.textContent).toContain('—')
  })

  it('双行列的排序与汇总用本期值', () => {
    const col = dualRowColumn<Row>('销售额', { colId: 'sales', current: r => r.sales, previous: r => r.prev, format: { kind: 'number' } })
    expect((col.valueGetter as (p: { data?: Row }) => unknown)({ data: row() })).toBe(120)
    expect(format(col, 1234)).toBe('1,234')
  })
})

describe('状态、进度、人员、时间、估算值、操作', () => {
  it('状态标签：登记的取值显示中文名；没登记的原样显示不吞掉；空显示“—”', () => {
    const col = statusColumn<Row>('状态', 'status', { OK: { label: '正常', tone: 'success' } })
    expect(renderCell(col, params(row(), 'OK')).container.textContent).toBe('正常')
    expect(renderCell(col, params(row(), 'WEIRD')).container.textContent).toBe('WEIRD')
    expect(renderCell(col, params(row(), null)).container.textContent).toBe('—')
    expect(format(col, 'OK')).toBe('正常')
    expect(format(col, null)).toBe('—')
  })

  it('进度条：0 到 1 的比率，超出按边界；没有值显示“—”', () => {
    const col = progressColumn<Row>('完成度', 'done')
    const percentOf = (value: number | null) => renderCell(col, params(row(), value)).container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')
    expect(percentOf(0.456)).toBe('46')
    expect(percentOf(7)).toBe('100')
    expect(percentOf(-1)).toBe('0')
    expect(renderCell(col, params(row(), null)).container.textContent).toBe('—')
  })

  it('人员：姓名首字头像加姓名；没有人显示“—”', () => {
    const col = personColumn<Row>('负责人', r => (r.owner ? { name: r.owner } : null))
    const { container } = renderCell(col, params(row()))
    expect(container.textContent).toContain('张')
    expect(screen.getByText('张三')).toBeInTheDocument()
    expect(renderCell(col, params(row({ owner: null }))).container.textContent).toBe('—')
  })

  it('时间：带站点时区；悬停显示精确到秒的时间与时区名；可换站点时区', () => {
    const col = timeColumn<Row>('更新时间', 'at')
    expect(format(col, '2026-10-20T10:00:00Z')).toBe('2026-10-20 03:00 PDT')
    expect(format(col, null)).toBe('—')
    const tip = col.tooltipValueGetter as (p: { value: unknown }) => string | undefined
    expect(tip({ value: '2026-10-20T10:00:00Z' })).toBe('2026-10-20 03:00:00 PDT（站点时区 America/Los_Angeles）')
    expect(tip({ value: null })).toBeUndefined()
    const jp = timeColumn<Row>('更新时间', 'at', { timeZone: 'Asia/Tokyo' })
    expect(format(jp, '2026-10-20T10:00:00Z')).toMatch(/^2026-10-20 19:00 /)
  })

  it('估算值：有值带“估”角标并说明方法；没有值不带角标', () => {
    const col = estimateColumn<Row>('预估仓储费', 'sales', { format: { kind: 'money' }, method: '按近 30 天体积估算' })
    const { container } = renderCell(col, params(row(), 12.5))
    expect(container.textContent).toBe('$12.50估')
    expect(screen.getByLabelText('估算值：按近 30 天体积估算')).toBeInTheDocument()
    const none = renderCell(col, params(row(), null))
    expect(none.container.textContent).toBe('—')
  })

  it('操作列：固定在右、不排序；占位行不渲染', () => {
    const col = actionColumn<Row>(r => <button type="button">编辑{r.name}</button>)
    expect(col).toMatchObject({ pin: 'right', sortable: false, colId: 'actions' })
    renderCell(col, params(row()))
    expect(screen.getByRole('button', { name: '编辑护腰带' })).toBeInTheDocument()
    expect(renderCell(col, params(undefined)).container.textContent).toBe('')
  })
})
