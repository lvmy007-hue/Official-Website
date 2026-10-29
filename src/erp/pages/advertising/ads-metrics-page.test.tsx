import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { campaignRows, metricsHandlers, metricsResponse } from './ads-metrics-fixtures.test-helper'

// 广告指标页（P3-15）：假服务端返回固定数据，验证默认请求、合计与明细的显示（空值写“—”不当 0）、没有数据与读取失败、
// 币种与截断的提示、活动链接、换数据集与时间粒度随请求带出、翻页、导出当前页、图表（图表组件在这里替换成占位）。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsMetricsPage: { load: () => import('./AdsMetricsPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/metrics'
const page = () => screen.findByTestId('ads-metrics-page')
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr, [role=row]') as HTMLElement
const lastParams = (calls: Array<{ path: string; search: string }>) => new URLSearchParams([...calls].reverse().find(call => call.path === '/ads/metrics')?.search ?? '')
const choose = async (label: string, option: string) => {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByText(option, { selector: '.ant-select-item-option-content' }))
}

describe('广告指标', () => {
  it('默认请求：活动日指标按日、花费销售额与广告成本销售比；合计与明细按指标格式显示', async () => {
    const app = mountApp({ url, pages, handlers: metricsHandlers() })
    await page()
    const first = await rowOf('2026-09-07')
    expect(first).toHaveTextContent('$6.00')
    expect(first).toHaveTextContent('$20.00')
    expect(first).toHaveTextContent('30.00%')
    const params = lastParams(app.calls)
    expect(Object.fromEntries(params)).toMatchObject({ dataset: 'CAMPAIGN', dims: 'date', metrics: 'spend,sales,acos', grain: 'day' })
    const totals = screen.getByTestId('ads-metrics-totals')
    expect(totals).toHaveTextContent('$9.00')
    expect(totals).toHaveTextContent('45.00%')
    expect(screen.getByText(/未选择日期范围，当前显示 2026-09-23 至 2026-10-22/)).toBeInTheDocument()
  })

  it('没有的值写“—”，不写 0：没有销售额的行、完全没有金额的行', async () => {
    mountApp({ url, pages, handlers: metricsHandlers() })
    await page()
    const second = await rowOf('2026-09-08')
    expect(second).toHaveTextContent('$3.00')
    expect(second).not.toHaveTextContent('$0.00')
    expect(second.querySelectorAll('.erp-num').length).toBeGreaterThan(0)
    const third = await rowOf('2026-09-14')
    expect(third).toHaveTextContent('—')
    expect(third).not.toHaveTextContent('$')
  })

  it('有日期维度画趋势', async () => {
    mountApp({ url, pages, handlers: metricsHandlers() })
    expect(await screen.findByLabelText('广告指标趋势')).toBeInTheDocument()
  })

  it('活动维度：有详情页的活动链到详情页，没有的只显示名称；可勾选对象在图表里对比', async () => {
    mountApp({ url, pages, handlers: metricsHandlers(() => metricsResponse({ dimensions: ['campaign'], items: campaignRows() })) })
    const first = await rowOf('春季活动')
    expect(within(first).getByRole('link', { name: '春季活动' })).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
    const second = await rowOf('C2')
    expect(within(second).queryByRole('link')).toBeNull()
    expect(second).toHaveTextContent('—') // 花费 1、销售额 0、广告成本销售比没有（销售额为 0 不能相除）
    expect(await screen.findByLabelText('广告指标对象对比')).toBeInTheDocument()
    expect(within(first).getByRole('checkbox')).toBeInTheDocument()
  })

  it('没有记录：写“尚无记录”和原因，合计也写“尚无记录”，没有图表与 0', async () => {
    const note = '这个数据集里所选范围内没有记录：对应的广告报告任务还没有导入过数据'
    mountApp({ url, pages, handlers: metricsHandlers(() => metricsResponse({ state: 'NO_DATA', note, items: [], totals: { spend: null, sales: null, acos: null }, groupCount: 0 })) })
    const noted = await screen.findByTestId('ads-metrics-note')
    expect(noted).toHaveTextContent('尚无记录')
    expect(noted).toHaveTextContent('还没有导入过数据')
    expect(screen.getByTestId('ads-metrics-totals')).toHaveTextContent('尚无记录')
    expect(screen.queryByLabelText('广告指标趋势')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  it('非美元行与读取上限：如实提示没有计入、合计只覆盖已读到的部分', async () => {
    mountApp({ url, pages, handlers: metricsHandlers(() => metricsResponse({ otherCurrencyRows: 4, truncated: true })) })
    expect(await screen.findByTestId('ads-metrics-currency')).toHaveTextContent('有 4 行是非美元数据')
    expect(screen.getByTestId('ads-metrics-truncated')).toHaveTextContent('只读取了一部分')
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({ url, pages, handlers: { '/ads/metrics': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('2026-09-07')).toBeNull()
  })

  it('换数据集：维度与指标回到该数据集的默认组合并随请求带出；时间粒度改成周', async () => {
    const app = mountApp({ url, pages, handlers: metricsHandlers() })
    await rowOf('2026-09-07')
    await choose('数据集', '搜索词日指标')
    await vi.waitFor(() => expect(Object.fromEntries(lastParams(app.calls))).toMatchObject({ dataset: 'SEARCH_TERM', dims: 'searchTerm', metrics: 'spend,sales,orders' }))
    expect(lastParams(app.calls).get('grain')).toBeNull()
    await choose('数据集', '活动日指标')
    fireEvent.click(await screen.findByRole('radio', { name: '周' }))
    await vi.waitFor(() => expect(lastParams(app.calls).get('grain')).toBe('week'))
  })

  it('翻页：下一页带游标，回到上一页显示第 1 页', async () => {
    const app = mountApp({
      url,
      pages,
      handlers: metricsHandlers(urlObj => (urlObj.searchParams.get('cursor') ? metricsResponse() : metricsResponse({ pageInfo: { pageSize: 50, nextCursor: 'c2', hasMore: true, approxTotal: 120 } }))),
    })
    await rowOf('2026-09-07')
    await userEvent.click(screen.getByRole('button', { name: '下一页' }))
    await vi.waitFor(() => expect(lastParams(app.calls).get('cursor')).toBe('c2'))
    await userEvent.click(await screen.findByRole('button', { name: '上一页' }))
    expect(await screen.findByText(/第 1 页/)).toBeInTheDocument()
  })

  it('导出当前页：生成 CSV（表头中文、空值留空不写 0）', async () => {
    const blobs: Blob[] = []
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = (blob: Blob | MediaSource) => (blobs.push(blob as Blob), 'blob:test')
    URL.revokeObjectURL = () => undefined
    onTestFinished(() => {
      Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke })
    })
    mountApp({ url, pages, handlers: metricsHandlers() })
    await rowOf('2026-09-07')
    await userEvent.click(screen.getByRole('button', { name: '导出当前页' }))
    expect(blobs).toHaveLength(1)
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blobs[0]!)
    })
    expect(text).toContain('日期,花费,广告销售额,广告成本销售比')
    expect(text).toContain('2026-09-07,6,20,0.3')
    expect(text).toContain('2026-09-14,,,')
  })
})
