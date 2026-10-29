import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { capacity, ok } from './inventory-stock-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 仓储容量与费用页（P2a-09）：利用率与限额分开显示并标注来源、费用没有记录写“尚无记录”、预测与跨档提醒、
// 尚未接入的项目、限额文件导入。

const pages: LivePages = { StorageCapacityPage: { load: () => import('./StorageCapacityPage') } }
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions = ['inventory.read', 'data.import']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/inventory/capacity': () => ok(capacity()),
  ...over,
})

describe('仓储容量与费用页', () => {
  it('利用率来自月度报告并标月份；还没导入限额时写“尚未导入”；费用没有记录的月份写“尚无记录”', async () => {
    mountApp({ url: '/app/inventory/capacity', pages, handlers: handlers() })
    expect(await screen.findByText('2026-09 月报告')).toBeInTheDocument()
    const row = screen.getByText('标准尺寸').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('尚未导入').length).toBeGreaterThanOrEqual(2)
    expect(within(row).getByText('尚未导入限额文件')).toBeInTheDocument()
    const empty = screen.getByText('2026-05').closest('tr, [role=row]') as HTMLElement
    expect(within(empty).getAllByText('尚无记录').length).toBe(4)
    const latest = screen.getByText('2026-09', { selector: 'td, .ag-cell *' }).closest('tr, [role=row]') as HTMLElement
    expect(within(latest).getByText('$15.00')).toBeInTheDocument()
    expect(within(latest).getByText('$7.00')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '近 6 个月仓储费堆叠柱图' })).toBeInTheDocument()
  })

  it('导入过限额：显示限额、已用、已用比与来源文件、采集日期、导入人', async () => {
    const base = capacity()
    const imported = capacity({
      utilization: [
        {
          ...base.utilization[0]!,
          limit: { limitQty: 10000, usedQty: 8000, usedRatio: 0.8, captureDate: '2026-10-19', sourceFileName: 'limits.csv', importedBy: '运营小王', importedAt: '2026-10-22T08:00:00Z' },
        },
      ],
    })
    mountApp({ url: '/app/inventory/capacity', pages, handlers: handlers({ '/inventory/capacity': () => ok(imported) }) })
    const row = (await screen.findByText('标准尺寸')).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('10,000')).toBeInTheDocument()
    expect(within(row).getByText('80.0%')).toBeInTheDocument()
    expect(within(row).getByText(/limits\.csv/)).toHaveTextContent('文件导入 · limits.csv · 采集 2026-10-19 · 导入人 运营小王')
  })

  it('预测：下月仓储费有预估值；库龄附加费预估没有数据写“尚无记录”；跨档提醒带估算增幅与最早、最晚跨档日', async () => {
    mountApp({ url: '/app/inventory/capacity', pages, handlers: handlers() })
    const forecast = (await screen.findByText('下月预测')).closest('.ant-card') as HTMLElement
    expect(within(forecast).getByText('$12.34')).toBeInTheDocument()
    expect(within(forecast).getByText('覆盖 1 个 SKU', { exact: false })).toBeInTheDocument()
    expect(within(forecast).getByText('库龄附加费预估').parentElement).toHaveTextContent('尚无记录')
    const crossing = screen.getByText('181-270 天').closest('tr, [role=row]') as HTMLElement
    expect(within(crossing).getByText('2026-10-13')).toBeInTheDocument()
    expect(within(crossing).getByText('2026-11-20')).toBeInTheDocument()
    expect(within(crossing).getByText('$10.00')).toBeInTheDocument()
  })

  it('清理建议显示占用体积、可售天数与原因；本页暂未汇总的实际发生额指向费用事件页', async () => {
    mountApp({ url: '/app/inventory/capacity', pages, handlers: handlers() })
    const row = (await screen.findByText('慢销商品')).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText(/50\.0/)).toHaveTextContent('cubic feet')
    expect(within(row).getByText('可售天数 200 天')).toBeInTheDocument()
    expect(screen.getByText('本页暂未汇总的项目')).toBeInTheDocument()
    expect(screen.getByText('实际发生的库龄附加费')).toBeInTheDocument()
    expect(screen.getAllByText(/费用事件/).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/交付）/)).not.toBeInTheDocument()
  })

  it('一个月的费用都没有记录：不画图，写“尚无记录”', async () => {
    const months = capacity().fees.months.map(month => ({ ...month, storage: null, overage: null, longTerm: null }))
    mountApp({ url: '/app/inventory/capacity', pages, handlers: handlers({ '/inventory/capacity': () => ok(capacity({ fees: { months, latestMonth: null } })) }) })
    expect(await screen.findByText(/不画成 0/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '近 6 个月仓储费堆叠柱图' })).not.toBeInTheDocument()
  })

  it('没有 data.import 权限：导入按钮禁用', async () => {
    mountApp({ url: '/app/inventory/capacity', pages, handlers: handlers({}, ['inventory.read']) })
    await screen.findByText('标准尺寸')
    expect(screen.getByRole('button', { name: '导入限额文件' })).toBeDisabled()
  })

  it('导入：读出 CSV 文本连同文件名与店铺提交；服务端逐行拒绝时错误显示在文件下面', async () => {
    let body: Record<string, unknown> | undefined
    let reject = true
    mountApp({
      url: '/app/inventory/capacity',
      pages,
      handlers: handlers({
        '/inventory/capacity/limits-import': (_url, init) => {
          body = JSON.parse(String(init?.body))
          if (reject) return { status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '文件有错误', fieldErrors: { content: ['第 3 行：存储类型“未知”无法识别'] } } } }
          return { status: 201, body: { success: true, data: { imported: 1, captureDates: ['2026-10-19'], sourceFileName: 'limits.csv' } } }
        },
      }),
    })
    await screen.findByText('标准尺寸')
    await userEvent.click(screen.getByRole('button', { name: '导入限额文件' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '导 入' }))
    expect(await within(dialog).findByText('请选择店铺')).toBeInTheDocument()
    expect(within(dialog).getByText('请选择文件')).toBeInTheDocument()
    expect(body).toBeUndefined()

    await userEvent.click(within(dialog).getByRole('combobox', { name: '导入店铺' }))
    await userEvent.click(await screen.findByTitle('Northstar US'))
    const csv = '存储类型,限额,已用,采集日期\n标准尺寸,10000,8000,2026-10-19\n'
    await userEvent.upload(within(dialog).getByLabelText('限额文件'), new File([csv], 'limits.csv', { type: 'text/csv' }))
    expect(await within(dialog).findByText(/已读取 limits\.csv/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '导 入' }))
    expect(await within(dialog).findByText('第 3 行：存储类型“未知”无法识别')).toBeInTheDocument()
    expect(body).toEqual({ sellerAccountId: 'st1', fileName: 'limits.csv', content: csv })

    reject = false
    await userEvent.click(within(dialog).getByRole('button', { name: '导 入' }))
    expect(await screen.findByText('已导入限额')).toBeInTheDocument()
  })

  it('没有任何记录：显示“尚无记录”与原因', async () => {
    mountApp({
      url: '/app/inventory/capacity',
      pages,
      handlers: handlers({ '/inventory/capacity': () => ok(capacity({ state: 'NO_DATA', note: '尚无仓储费与库容记录', utilization: [], suggestions: [] })) }),
    })
    expect(await screen.findByText('尚无仓储费与库容记录')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText(/尚无记录/).length).toBeGreaterThan(0))
  })
})
