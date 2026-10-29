import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { cohort, crossMonth, cycle, matrix, reasonMap, reasonRow, summary } from './returns-analysis-fixtures.test-helper'
import { ok, returnList, rowText } from './returns-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 退货分析六个子页签与原因映射（P6-13）：时间口径切换、无法计算的条数单独写明、天数段设置与校验、未分类提醒与补全入口、
// 没有销售件数写“尚无记录”不写 0%、映射表的新增与修改走动作守卫并以服务端为准。

const pages: LivePages = { ReturnsPage: { load: () => import('./ReturnsPage') } }

// 表格、图表与弹窗表单一起渲染，在负载高的机器上单个用例会超过默认的 15 秒
vi.setConfig({ testTimeout: 60000 })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
beforeEach(() => window.localStorage.clear())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/returns': () => ok(returnList()),
  '/returns/analysis/summary': () => ok(summary()),
  '/returns/analysis/cycle': () => ok(cycle()),
  '/returns/analysis/cross-month': () => ok(crossMonth()),
  '/returns/analysis/cohort': () => ok(cohort()),
  '/returns/analysis/disposition-matrix': () => ok(matrix()),
  '/returns/reason-map': () => ok(reasonMap()),
  ...over,
})

const openAnalysis = async (inner?: string) => {
  await userEvent.click(await screen.findByRole('tab', { name: '退货分析' }))
  if (inner) await userEvent.click(await screen.findByRole('tab', { name: inner }))
}

describe('退货分析·概览', () => {
  it('汇总、趋势图、ASIN 排行、异常榜与改善榜；没有销售件数的退货率写“尚无记录”不写 0%', async () => {
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await openAnalysis()
    const totals = await screen.findByTestId('return-totals')
    expect(within(totals).getByText('4.00%')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '退货件数与退货率趋势图' })).toBeInTheDocument()
    expect(await screen.findByText('B0TESTASIN2')).toBeInTheDocument()
    await waitFor(() => expect(rowText('B0TESTASIN2')).toContain('尚无记录'))
    expect(rowText('B0TESTASIN2')).not.toContain('0.00%')
    expect(rowText('B0ANOMALY01')).toContain('连续增加')
    expect(rowText('B0IMPROVE01')).toContain('连续减少')
    expect(screen.getByText(/三期等长：本期 2026-09-25 至 2026-10-23/)).toBeInTheDocument()
    const params = new URLSearchParams(app.calls.find(call => call.path === '/returns/analysis/summary')!.search)
    expect(params.get('timeBasis')).toBe('return')
    expect(params.get('anchor')).toBeNull()
    expect(params.get('bounds')).toBeNull()
  })

  it('切到“按下单时间”：请求带 timeBasis=order，写进地址栏；缺下单时间的退货写明条数与件数', async () => {
    const seen: URLSearchParams[] = []
    const app = mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/analysis/summary': url => (
          seen.push(url.searchParams),
          ok(summary(url.searchParams.get('timeBasis') === 'order' ? { timeBasis: 'order', unknownOrderRows: 3, unknownOrderUnits: 5 } : {}))
        ),
      }),
    })
    await openAnalysis()
    await screen.findByTestId('return-totals')
    await userEvent.click(screen.getByText('按下单时间'))
    await waitFor(() => expect(seen.some(params => params.get('timeBasis') === 'order')).toBe(true))
    expect(await screen.findByText(/缺下单时间、不能按下单时间统计的退货 3 条（5 件）/)).toBeInTheDocument()
    expect(app.router.state.location.search).toMatchObject({ timeBasis: 'order' })
  })

  it('趋势明细触到上限时提示；没有退货记录只写原因', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/analysis/summary': () => ok(summary({ truncated: true })) }) })
    await openAnalysis()
    expect(await screen.findByText('明细可能不完整')).toBeInTheDocument()
  })

  it('没有退货记录：显示正式的空状态', async () => {
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({ '/returns/analysis/summary': () => ok(summary({ state: 'NO_DATA', note: '所选日期范围内尚无退货记录', byAsin: [], byReason: [], byCategory: [], byDisposition: [] })) }),
    })
    await openAnalysis()
    expect((await screen.findAllByText(/所选日期范围内尚无退货记录/)).length).toBeGreaterThan(0)
  })
})

describe('退货分析·退货原因', () => {
  it('三层显示；未分类的代码顶部提醒，点“去补全”跳到原因映射页签', async () => {
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await openAnalysis('退货原因')
    expect(await screen.findByText(/有 1 个原因代码（3 件）还没有补全中文释义与大类/)).toBeInTheDocument()
    await waitFor(() => expect(rowText('DEFECTIVE')).toContain('商品质量'))
    expect(rowText('NEW_CODE')).toContain('未分类')
    expect(rowText('UNSPECIFIED')).toContain('未提供原因')
    expect(await screen.findByRole('img', { name: '按原因大类的退货件数图' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '去补全' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/returns/reason-map')).toBe(true))
    expect(await screen.findByRole('button', { name: /新增原因/ })).toBeInTheDocument()
  })

  it('没有未分类的代码时不出现提醒', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/analysis/summary': () => ok(summary({ unclassified: { codes: [], units: 0 } })) }) })
    await openAnalysis('退货原因')
    await screen.findByText('按退货原因（代码 → 中文释义 → 大类）')
    expect(screen.queryByText(/还没有补全中文释义与大类/)).not.toBeInTheDocument()
  })
})

describe('退货分析·退货周期', () => {
  it('中位数与天数段；“无法计算周期 N 条”单独写明，不当作 0 天', async () => {
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/analysis/cycle': () => ok(cycle({ unknownOrderRows: 3, unknownOrderUnits: 5 })) }) })
    await openAnalysis('退货周期')
    const totals = await screen.findByTestId('cycle-totals')
    expect(within(totals).getByText('9.5 天')).toBeInTheDocument()
    expect(await screen.findByText(/无法计算周期 3 条（5 件）/)).toBeInTheDocument()
    await waitFor(() => expect(rowText('0-7')).toContain('40.0%'))
    const params = new URLSearchParams(app.calls.find(call => call.path === '/returns/analysis/cycle')!.search)
    expect(params.get('anchor')).toBe('order')
    expect(params.get('dimension')).toBe('none')
    expect(params.get('bounds')).toBeNull()
  })

  it('没有参与计算的退货：中位数写“尚无记录”，不写 0 天', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/analysis/cycle': () => ok(cycle({ totals: { units: 0, median: null }, buckets: [] })) }) })
    await openAnalysis('退货周期')
    const totals = await screen.findByTestId('cycle-totals')
    expect(within(totals).getByText('尚无记录')).toBeInTheDocument()
    expect(totals.textContent).not.toContain('0 天')
  })

  it('天数段设置：写错时说明原因、不发请求；写对后发给服务端并记在本机；恢复默认清除', { timeout: 60000 }, async () => {
    const seen: Array<string | null> = []
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/analysis/cycle': url => (seen.push(url.searchParams.get('bounds')), ok(cycle())) }) })
    await openAnalysis('退货周期')
    const input = await screen.findByRole('textbox', { name: '天数段分界点' })
    await screen.findByTestId('cycle-totals')
    const before = seen.length
    await userEvent.clear(input)
    await userEvent.type(input, '10,5')
    await userEvent.click(screen.getByRole('button', { name: /^应\s?用$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('分界点必须从小到大、不能重复')
    expect(seen.length).toBe(before)

    await userEvent.clear(input)
    await userEvent.type(input, '10,20')
    await userEvent.click(screen.getByRole('button', { name: /^应\s?用$/ }))
    await waitFor(() => expect(seen).toContain('10,20'))
    expect(window.localStorage.getItem('erp.returns.cycle-bounds')).toBe('10,20')

    await userEvent.click(screen.getByRole('button', { name: /恢复默认/ }))
    await waitFor(() => expect(window.localStorage.getItem('erp.returns.cycle-bounds')).toBeNull())
    expect(screen.getByRole('textbox', { name: '天数段分界点' })).toHaveValue('7,14,30,60,90')
  })

  it('本机上次设置的天数段下次打开自动沿用；起点切到发货日期、按原因切片', { timeout: 60000 }, async () => {
    window.localStorage.setItem('erp.returns.cycle-bounds', '3,6')
    const seen: URLSearchParams[] = []
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/analysis/cycle': url => (
          seen.push(url.searchParams),
          ok(cycle(url.searchParams.get('dimension') === 'reason' ? { dimension: 'reason', slices: [{ key: 'DEFECTIVE', label: '商品有缺陷', units: 6, median: 4, buckets: [4, 2, 0] }] } : {}))
        ),
      }),
    })
    await openAnalysis('退货周期')
    await waitFor(() => expect(seen[0]?.get('bounds')).toBe('3,6'))
    await userEvent.click(screen.getByText('发货日期'))
    await waitFor(() => expect(seen.some(params => params.get('anchor') === 'ship')).toBe(true))
    await userEvent.click(screen.getByRole('combobox', { name: '切片维度' }))
    await userEvent.click(await screen.findByText('按原因', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(seen.some(params => params.get('dimension') === 'reason')).toBe(true))
    await waitFor(() => expect(rowText('DEFECTIVE')).toContain('商品有缺陷'))
    expect(rowText('DEFECTIVE')).toContain('4.0 天')
  })
})

describe('退货分析·跨月退货与队列退货率', () => {
  it('跨月占比、退款金额占比与下单月×退货月矩阵', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await openAnalysis('跨月退货')
    const totals = await screen.findByTestId('cross-month-totals')
    expect(within(totals).getByText('40.0%')).toBeInTheDocument()
    expect(totals.textContent).toContain('30.0%')
    await waitFor(() => expect(rowText('2026-09')).toContain('2'))
    expect(rowText('2026-10')).toContain('4')
  })

  it('退款金额只核对了部分订单时写明；矩阵之外的件数提示；缺下单时间的条数单独写明', async () => {
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/analysis/cross-month': () =>
          ok(
            crossMonth({
              refund: { state: 'PARTIAL', currency: 'USD', crossMonthAmount: 10, totalAmount: 50, share: 0.2, sampledOrders: 500, note: null },
              matrix: { orderMonths: ['2026-10'], returnMonths: ['2026-10'], cells: [[3]], hiddenUnits: 7 },
              unknownOrderRows: 2,
              unknownOrderUnits: 2,
            }),
          ),
      }),
    })
    await openAnalysis('跨月退货')
    const totals = await screen.findByTestId('cross-month-totals')
    expect(totals.textContent).toContain('只核对了最近 500 个订单')
    expect(await screen.findByText(/另有 7 件落在显示的月份之外/)).toBeInTheDocument()
    expect(screen.getByText(/无法判断是否跨月 2 条（2 件）/)).toBeInTheDocument()
  })

  it('没有财务交易时退款金额占比写原因，不写 0%', async () => {
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/analysis/cross-month': () =>
          ok(crossMonth({ refund: { state: 'NO_DATA', currency: null, crossMonthAmount: null, totalAmount: null, share: null, sampledOrders: 0, note: '这些订单还没有财务交易' } })),
      }),
    })
    await openAnalysis('跨月退货')
    const totals = await screen.findByTestId('cross-month-totals')
    expect(totals.textContent).toContain('这些订单还没有财务交易')
  })

  it('队列退货率与退货率并排；退货窗口未结束的月份提示；没有销售件数写“尚无记录”', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await openAnalysis('队列退货率')
    expect(await screen.findByText('队列退货率与退货率不是同一个数')).toBeInTheDocument()
    await waitFor(() => expect(rowText('2026-09')).toContain('6.00%'))
    expect(rowText('2026-09')).toContain('3.00%')
    expect(rowText('2026-10')).toContain('窗口未结束')
    expect(rowText('2026-10')).toContain('尚无记录')
    expect(rowText('2026-10')).not.toContain('0.00%')
    expect(screen.getByText(/带“窗口未结束”的月份，队列退货率还会上升/)).toBeInTheDocument()
  })
})

describe('退货分析·库存属性×处置结果', () => {
  it('行是库存属性，列是报告的处理状态原文，格子是件数', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await openAnalysis('库存属性×处置结果')
    await waitFor(() => expect(rowText('SELLABLE')).toContain('可售'))
    expect(rowText('SELLABLE')).toContain('7')
    expect(rowText('DAMAGED')).toContain('2')
    expect(screen.getAllByText('Unit returned to inventory').length).toBeGreaterThan(0)
  })

  it('读取失败：显示正式的错误状态', async () => {
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({ '/returns/analysis/disposition-matrix': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }),
    })
    await openAnalysis('库存属性×处置结果')
    expect(await screen.findByText(/服务暂时不可用|读取失败|出错/)).toBeInTheDocument()
  })
})

describe('原因映射', () => {
  const openMap = async () => userEvent.click(await screen.findByRole('tab', { name: '原因映射' }))
  const rows = [
    reasonRow(),
    reasonRow({ code: 'NEW_CODE', labelZh: 'NEW_CODE', category: '未分类', source: 'AUTO', presetLabelZh: null, presetCategory: null, unclassified: true, updatedAt: '2026-10-20T08:00:00Z' }),
    reasonRow({
      code: 'NOT_AS_DESCRIBED',
      labelZh: '与页面描述不一致',
      category: '与描述不符',
      source: 'PRESET_EDITED',
      presetLabelZh: '与描述不符',
      presetCategory: '与描述不符',
      updatedAt: '2026-10-21T08:00:00Z',
    }),
  ]

  it('列表：三层加来源与预置值；有未分类时顶部提醒并给出数量；打开页签才取数', async () => {
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/reason-map': () => ok(reasonMap(rows)) }) })
    await screen.findByRole('tab', { name: '原因映射' })
    expect(app.calls.some(call => call.path === '/returns/reason-map')).toBe(false)
    await openMap()
    await waitFor(() => expect(rowText('NEW_CODE')).toContain('导入时自动加入，待补全'))
    expect(rowText('DEFECTIVE')).toContain('商品质量')
    expect(rowText('NOT_AS_DESCRIBED')).toContain('预置（已修改）')
    expect(rowText('NOT_AS_DESCRIBED')).toContain('与描述不符 / 与描述不符')
    expect(await screen.findByText('有 1 个原因代码还没有补全')).toBeInTheDocument()
    expect(screen.getByText(/共 3 个原因代码/)).toBeInTheDocument()
  })

  it('没有“企业设置”修改权限：新增与编辑按钮禁用，显示服务端给的原因', async () => {
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({ '/returns/reason-map': () => ok(reasonMap(rows, { canManage: false, manageBlockedReason: '你没有维护退货原因映射的权限' })) }, ['returns.read']),
    })
    await openMap()
    expect(await screen.findByText('你可以查看原因映射，但不能修改')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新增原因/ })).toBeDisabled()
  })

  it('编辑：补全中文释义与大类后提交；请求体只含这一行；成功后列表重新读取', async () => {
    let body: Record<string, any> | null = null
    let reads = 0
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/reason-map': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body)) as Record<string, any>
            return ok({ saved: 1, items: [] })
          }
          reads += 1
          return ok(reasonMap(rows))
        },
      }),
    })
    await openMap()
    await waitFor(() => expect(rowText('NEW_CODE')).toContain('未分类'))
    const row = document.querySelector('[row-id="NEW_CODE"]') as HTMLElement
    const edit = Array.from(document.querySelectorAll('[row-id="NEW_CODE"] button')).find(button => /编\s?辑/.test(button.textContent ?? '')) as HTMLElement
    expect(row).not.toBeNull()
    await userEvent.click(edit)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('原因代码')).toBeDisabled()
    const label = within(dialog).getByLabelText('中文释义')
    await userEvent.clear(label)
    await userEvent.type(label, '  包装破损  ')
    await userEvent.click(within(dialog).getByRole('combobox', { name: '大类' }))
    await userEvent.click(await screen.findByText('物流与配送', { selector: '.ant-select-item-option-content' }))
    const before = reads
    await userEvent.click(within(dialog).getByRole('button', { name: /保存修改/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toEqual({ items: [{ code: 'NEW_CODE', labelZh: '包装破损', category: '物流与配送' }] })
    await waitFor(() => expect(reads).toBeGreaterThan(before))
  })

  it('新增：中文释义为空被前端拦下，不发请求；填好后提交', async () => {
    let body: Record<string, any> | null = null
    const app = mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/reason-map': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body)) as Record<string, any>
            return ok({ saved: 1, items: [] })
          }
          return ok(reasonMap(rows))
        },
      }),
    })
    await openMap()
    await userEvent.click(await screen.findByRole('button', { name: /新增原因/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('原因代码'), 'late_arrival')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    expect((await within(dialog).findAllByText(/请填写中文释义/)).length).toBeGreaterThan(0)
    expect(app.calls.some(call => call.method === 'PUT')).toBe(false)
    expect(within(dialog).getByLabelText('原因代码')).toHaveValue('late_arrival')
    await userEvent.type(within(dialog).getByLabelText('中文释义'), '到货太晚')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toEqual({ items: [{ code: 'late_arrival', labelZh: '到货太晚', category: '其他原因' }] })
  })

  it('改过的预置项可以恢复预置；没改过的预置项没有这个按钮', async () => {
    let body: Record<string, any> | null = null
    mountApp({
      url: '/app/returns',
      pages,
      handlers: handlers({
        '/returns/reason-map': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body)) as Record<string, any>
            return ok({ saved: 1, items: [] })
          }
          return ok(reasonMap(rows))
        },
      }),
    })
    await openMap()
    await waitFor(() => expect(rowText('NOT_AS_DESCRIBED')).toContain('预置（已修改）'))
    expect(document.querySelector('[row-id="DEFECTIVE"]')?.textContent).not.toContain('恢复预置')
    const restore = Array.from(document.querySelectorAll('[row-id="NOT_AS_DESCRIBED"] button')).find(button => /恢复预置/.test(button.textContent ?? '')) as HTMLElement
    await userEvent.click(restore)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^恢\s?复$/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toEqual({ items: [{ code: 'NOT_AS_DESCRIBED', labelZh: '与描述不符', category: '与描述不符' }] })
  })
})
