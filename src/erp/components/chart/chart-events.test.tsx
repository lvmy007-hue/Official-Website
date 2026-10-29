import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EChartsOption } from 'echarts'
import type { EventItem, EventsResponse } from '@nova/api-contracts'
import { jsonResponse } from '../../test/app-harness'
import { renderWithApp } from '../../test/render'
import { ChartPanel } from './ChartPanel'
import { chartBoundaryGap, chartCategories, chartGrid, optionToTable, withHighlight } from './chart-link'
import { bandPosition, categoryIndexOfDay, eventRange, placeEvents } from './event-band-utils'
import { useChartLink } from './use-chart-link'

// 事件带、图表与表格联动、图表转表格（P6-06）。

const mocks = vi.hoisted(() => ({ option: undefined as unknown, handler: undefined as undefined | ((params: { name?: unknown; seriesName?: unknown }) => void) }))
vi.mock('./ErpChart', () => ({
  ErpChart: ({ ariaLabel, option, onReady }: { ariaLabel: string; option: unknown; onReady?: (chart: unknown) => void }) => {
    mocks.option = option
    useEffect(() => {
      onReady?.({
        on: (_event: string, handler: (params: { name?: unknown; seriesName?: unknown }) => void) => {
          mocks.handler = handler
        },
      })
    }, [onReady])
    return <div role="img" aria-label={ariaLabel} />
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.option = undefined
  mocks.handler = undefined
})

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03']
const option: EChartsOption = {
  grid: { left: 56, right: 16 },
  xAxis: { type: 'category', data: DAYS },
  yAxis: {},
  series: [
    { name: '销售额', type: 'line', data: [1, 2, 3] },
    { name: '件数', type: 'bar', data: [4, null, 6] },
  ],
}

const event = (over: Partial<EventItem> = {}): EventItem => ({
  id: 'e1',
  type: 'PRICE',
  occurredAt: '2026-10-02T10:00:00.000Z',
  day: '2026-10-02',
  title: '改价 19.99 → 17.99',
  summary: '人工改价',
  link: '/app/products/p1',
  actor: '甲',
  ...over,
})
const response = (over: Partial<EventsResponse> = {}): EventsResponse => ({ items: [], truncated: false, truncatedTypes: [], unavailableTypes: [], ...over })

function stubEvents(body: EventsResponse | { status: number }) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(String(input))
      if ('status' in body) return jsonResponse(body.status, { error: { code: 'INTERNAL', message: '服务出错' } })
      return jsonResponse(200, { success: true, data: body })
    }),
  )
  return calls
}

describe('事件带的纯函数', () => {
  it('只有按天递增的日期横轴才有事件带', () => {
    expect(eventRange(DAYS)).toEqual({ from: '2026-10-01', to: '2026-10-03' })
    expect(eventRange([])).toBeNull()
    expect(eventRange(['周一', '周二'])).toBeNull()
    expect(eventRange(['2026-10-03', '2026-10-01'])).toBeNull()
  })

  it('日图事件必须落在同一天；周图落在开始日不晚于事件日的最后一个桶，超出最后一个桶不画', () => {
    expect(categoryIndexOfDay(DAYS, '2026-10-02')).toBe(1)
    // 日图里缺了一天（间隔中位数仍是 1）：落在缺的那天的事件不挪到别的日子上
    expect(categoryIndexOfDay(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05'], '2026-10-03')).toBe(-1)
    const weeks = ['2026-09-14', '2026-09-21', '2026-09-28']
    expect(categoryIndexOfDay(weeks, '2026-09-23')).toBe(1)
    expect(categoryIndexOfDay(weeks, '2026-10-04')).toBe(2)
    expect(categoryIndexOfDay(weeks, '2026-10-05')).toBe(-1)
    expect(categoryIndexOfDay(weeks, '2026-09-10')).toBe(-1)
  })

  it('同一类型同一天合并成一个点并显示“N 个事件”；隐藏的类型与范围外的事件不画并计数', () => {
    const items = [
      event({ id: 'a', occurredAt: '2026-10-02T08:00:00.000Z' }),
      event({ id: 'b', occurredAt: '2026-10-02T09:00:00.000Z', title: '再改价' }),
      event({ id: 'c', type: 'ADS', title: '改预算' }),
      event({ id: 'd', day: '2026-12-01', title: '范围外' }),
    ]
    const { points, outside } = placeEvents(DAYS, items, new Set())
    expect(outside).toBe(1)
    expect(points.map(point => [point.type, point.index, point.count, point.label])).toEqual([
      ['PRICE', 1, 2, '2 个事件'],
      ['ADS', 1, null, '改预算'],
    ])
    expect(points[0]!.items.map(item => item.id)).toEqual(['b', 'a'])
    expect(placeEvents(DAYS, items, new Set(['PRICE'] as const)).points.map(point => point.type)).toEqual(['ADS'])
  })

  it('圆点位置：留白时在格子中间，贴边时从 0 排到 100，只有一格时居中', () => {
    expect(bandPosition(0, 4, true)).toBe(12.5)
    expect(bandPosition(3, 4, true)).toBe(87.5)
    expect(bandPosition(0, 4, false)).toBe(0)
    expect(bandPosition(3, 4, false)).toBe(100)
    expect(bandPosition(0, 1, true)).toBe(50)
  })
})

describe('图表联动与转表格的纯函数', () => {
  it('读横轴类目、绘图区留白与是否留白', () => {
    expect(chartCategories(option)).toEqual(DAYS)
    expect(chartGrid(option)).toEqual({ left: 56, right: 16 })
    expect(chartGrid({})).toEqual({ left: '10%', right: '10%' })
    expect(chartBoundaryGap(option)).toBe(true)
    expect(chartBoundaryGap({ xAxis: { type: 'category', boundaryGap: false, data: DAYS } })).toBe(false)
  })

  it('高亮系列：其余系列变淡；高亮类目：第一条系列加一条实线并保留原有标注；目标不存在原样返回', () => {
    const faded = withHighlight(option, { series: '销售额' })
    const [first, second] = faded.series as Array<{ lineStyle?: { opacity?: number } }>
    expect(first!.lineStyle?.opacity).toBeUndefined()
    expect(second!.lineStyle?.opacity).toBe(0.2)

    const withMark: EChartsOption = { ...option, series: [{ name: '销售额', type: 'line', data: [1, 2, 3], markLine: { data: [{ xAxis: '2026-10-01', name: '改价' }] } }] }
    const marked = withHighlight(withMark, { category: '2026-10-03' })
    const line = (marked.series as Array<{ markLine: { data: Array<{ xAxis: string }> } }>)[0]!.markLine
    expect(line.data.map(item => item.xAxis)).toEqual(['2026-10-01', '2026-10-03'])

    expect(withHighlight(option, { series: '不存在', category: '2099-01-01' })).toBe(option)
    expect(withHighlight(option, {})).toBe(option)
  })

  it('转表格：类目 × 系列；缺失的点是空值不补 0；饼图、散点图、数据比类目多的图不能转', () => {
    expect(optionToTable(option)).toEqual({
      categories: DAYS,
      series: [
        { name: '销售额', values: [1, 2, 3] },
        { name: '件数', values: [4, null, 6] },
      ],
    })
    expect(optionToTable({ series: [{ type: 'pie', data: [{ name: 'a', value: 1 }] }] })).toBeNull()
    expect(optionToTable({ xAxis: { type: 'category', data: DAYS }, series: [{ type: 'scatter', data: [[1, 2]] }] })).toBeNull()
    expect(optionToTable({ xAxis: { type: 'category', data: ['a'] }, series: [{ type: 'line', data: [1, 2] }] })).toBeNull()
  })

  it('联动状态：图上点选筛选并可取消，表格选行高亮并可取消，点选新的会清掉旧的高亮', () => {
    const { result } = renderHook(() => useChartLink())
    expect(result.current.chartProps).toMatchObject({ activeCategory: null, highlightSeries: null })
    act(() => result.current.onChartClick('2026-10-02', '销售额'))
    expect(result.current.filterCategory).toBe('2026-10-02')
    expect(result.current.chartProps).toMatchObject({ activeCategory: '2026-10-02', highlightSeries: '销售额' })
    act(() => result.current.onRowFocus({ category: '2026-10-03' }))
    expect(result.current.chartProps.activeCategory).toBe('2026-10-03')
    expect(result.current.filterCategory).toBe('2026-10-02')
    act(() => result.current.onRowFocus({ category: '2026-10-03' }))
    expect(result.current.chartProps.activeCategory).toBe('2026-10-02')
    act(() => result.current.onChartClick('2026-10-02', '销售额'))
    expect(result.current.filterCategory).toBeNull()
    act(() => result.current.onChartClick('2026-10-01'))
    act(() => result.current.clear())
    expect(result.current.chartProps.activeCategory).toBeNull()
  })
})

describe('图表容器：事件带', () => {
  it('按对象与图的日期范围取事件；每类一行，同一天多个事件合并，点开看详情与链接', async () => {
    const calls = stubEvents(
      response({
        items: [event({ id: 'a' }), event({ id: 'b', title: '再改价', summary: null, link: null }), event({ id: 'c', type: 'ALERT', title: '库存预警', link: '/app/alerts/x', actor: '系统' })],
      }),
    )
    renderWithApp(<ChartPanel title="销售趋势" ariaLabel="销售趋势图" option={option} eventSource={{ objectType: 'ASIN', objectId: 'p1' }} />)
    expect(await screen.findByTestId('event-band')).toBeInTheDocument()
    const url = new URL(calls[0]!, 'http://localhost')
    expect(url.pathname).toBe('/api/v1/events')
    expect(Object.fromEntries(url.searchParams)).toEqual({ objectType: 'ASIN', objectId: 'p1', from: '2026-10-01', to: '2026-10-03' })
    expect(screen.getByTestId('event-lane-PRICE')).toBeInTheDocument()
    expect(screen.getByTestId('event-lane-ALERT')).toBeInTheDocument()
    expect(screen.queryByTestId('event-lane-ADS')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '价格 2026-10-02：2 个事件' }))
    const detail = await screen.findByTestId('event-detail')
    expect(within(detail).getByText('改价 19.99 → 17.99')).toBeInTheDocument()
    expect(within(detail).getByText('再改价')).toBeInTheDocument()
    expect(within(detail).getAllByRole('link', { name: '查看详情' })).toHaveLength(1)
  })

  it('逐类开关：关掉“价格”后这一行消失，再打开恢复', async () => {
    stubEvents(response({ items: [event()] }))
    renderWithApp(<ChartPanel title="销售趋势" ariaLabel="销售趋势图" option={option} eventSource={{ objectType: 'ASIN', objectId: 'p1' }} />)
    const box = await screen.findByRole('checkbox', { name: /价格 1/ })
    await userEvent.click(box)
    expect(screen.queryByTestId('event-lane-PRICE')).toBeNull()
    await userEvent.click(box)
    expect(screen.getByTestId('event-lane-PRICE')).toBeInTheDocument()
  })

  it('没有事件、没有权限的类型、被截断的类型、图外事件都如实说明，不显示成“没有事件”', async () => {
    stubEvents(response({ items: [event({ day: '2026-12-01' })], truncated: true, truncatedTypes: ['PRICE'], unavailableTypes: ['ADS', 'AUDIT'] }))
    renderWithApp(<ChartPanel title="销售趋势" ariaLabel="销售趋势图" option={option} eventSource={{ objectType: 'ASIN', objectId: 'p1' }} />)
    const band = await screen.findByTestId('event-band')
    expect(band).toHaveTextContent('没有查看权限，未显示：广告变更、系统操作')
    expect(band).toHaveTextContent('只显示最近 200 条：价格')
    expect(band).toHaveTextContent('1 个事件不在图的日期范围内')
  })

  it('所选范围内没有事件：写明没有；读取失败：显示原因并可重试', async () => {
    stubEvents(response())
    const { unmount } = renderWithApp(<ChartPanel title="销售趋势" ariaLabel="销售趋势图" option={option} eventSource={{ objectType: 'ASIN', objectId: 'p1' }} />)
    expect(await screen.findByText('所选时间范围内没有事件')).toBeInTheDocument()
    unmount()
    stubEvents({ status: 500 })
    renderWithApp(<ChartPanel title="销售趋势" ariaLabel="销售趋势图" option={option} eventSource={{ objectType: 'ASIN', objectId: 'p1' }} />)
    expect(await screen.findByText(/事件加载失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })

  it('横轴不是日期、没传事件对象、超过 400 天：不请求或只给说明', async () => {
    const calls = stubEvents(response())
    renderWithApp(
      <ChartPanel
        title="分类"
        ariaLabel="分类图"
        option={{ xAxis: { type: 'category', data: ['甲', '乙'] }, yAxis: {}, series: [{ type: 'bar', data: [1, 2] }] }}
        eventSource={{ objectType: 'ASIN', objectId: 'p1' }}
      />,
    )
    renderWithApp(<ChartPanel title="无对象" ariaLabel="无对象图" option={option} />)
    const long: EChartsOption = { xAxis: { type: 'category', data: ['2025-01-01', '2026-10-01'] }, yAxis: {}, series: [{ type: 'line', data: [1, 2] }] }
    renderWithApp(<ChartPanel title="太长" ariaLabel="太长图" option={long} eventSource={{ objectType: 'ASIN', objectId: 'p1' }} />)
    expect(await screen.findByText(/时间范围超过 400 天/)).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })
})

describe('图表容器：联动与表格视图', () => {
  it('点图上的点把日期和系列名交给页面；传入的高亮日期和系列画进图', async () => {
    const onCategoryClick = vi.fn()
    const { rerender } = renderWithApp(<ChartPanel title="趋势" ariaLabel="趋势图" option={option} onCategoryClick={onCategoryClick} />)
    await waitFor(() => expect(mocks.handler).toBeDefined())
    mocks.handler!({ name: '2026-10-02', seriesName: '销售额' })
    mocks.handler!({ name: '2026-10-03' })
    expect(onCategoryClick.mock.calls).toEqual([
      ['2026-10-02', '销售额'],
      ['2026-10-03', undefined],
    ])

    rerender(<ChartPanel title="趋势" ariaLabel="趋势图" option={option} activeCategory="2026-10-02" highlightSeries="件数" />)
    const drawn = mocks.option as { series: Array<{ lineStyle?: { opacity?: number }; markLine?: { data: Array<{ xAxis: string }> } }> }
    expect(drawn.series[0]!.lineStyle?.opacity).toBe(0.2)
    expect(drawn.series[0]!.markLine?.data.map(item => item.xAxis)).toEqual(['2026-10-02'])
  })

  it('切换为表格：用 PagedGrid 展示同一份数据，缺失值显示“—”，可切回图表；饼图没有这个按钮', async () => {
    renderWithApp(<ChartPanel title="趋势" ariaLabel="趋势图" option={option} />)
    await userEvent.click(screen.getByRole('button', { name: '切换为表格' }))
    expect(screen.queryByRole('img', { name: '趋势图' })).toBeNull()
    expect(await screen.findByText('2026-10-02')).toBeInTheDocument()
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '下载图片' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '切换为图表' }))
    expect(screen.getByRole('img', { name: '趋势图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载图片' })).toBeInTheDocument()
  })

  it('表格视图只显示图上点选的那一天', async () => {
    renderWithApp(<ChartPanel title="趋势" ariaLabel="趋势图" option={option} tableFilterCategory="2026-10-03" />)
    await userEvent.click(screen.getByRole('button', { name: '切换为表格' }))
    expect(await screen.findByText('2026-10-03')).toBeInTheDocument()
    expect(screen.getByText('共 1 条')).toBeInTheDocument()
    expect(screen.queryByText('2026-10-01')).toBeNull()
  })

  it('饼图没有“切换为表格”，但仍可下载图片', () => {
    renderWithApp(<ChartPanel title="占比" ariaLabel="占比图" option={{ series: [{ type: 'pie', data: [{ name: 'a', value: 1 }] }] }} />)
    expect(screen.queryByRole('button', { name: '切换为表格' })).toBeNull()
    expect(screen.getByRole('button', { name: '下载图片' })).toBeInTheDocument()
  })
})
