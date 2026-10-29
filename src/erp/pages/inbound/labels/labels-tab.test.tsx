import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS, type InboundLabelsResponse, type LabelPrintStat, type LabelTemplateRow } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../../test/app-harness'
import type { LivePages } from '../../../routes/live-pages'
import { ok, options, overview, shipmentView } from '../inbound-fixtures.test-helper'

// 入仓计划“标签”页签（P6-12）：按货件的生成统计、生成自定义箱标签与商品标签（本地 PDF，走导出中心）、缺亚马逊箱标签时的提示与权限。

vi.mock('../../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { InboundPlanDetailPage: { load: () => import('../InboundPlanDetailPage') } }
afterEach(() => vi.unstubAllGlobals())

const B = '/inbound/plans/p1'
const THERMAL = 'PackageLabel_Thermal_NonPCP'

const stat = (over: Partial<LabelPrintStat> = {}): LabelPrintStat => ({
  shipmentRowId: 'sh1',
  shipmentId: 'FBA-SH-1',
  boxes: 2,
  customCount: 3,
  itemCount: 1,
  lastPrintedAt: '2026-12-12T08:00:00Z',
  readyPageTypes: [THERMAL],
  ...over,
})
const template = (over: Partial<LabelTemplateRow> = {}): LabelTemplateRow => ({
  id: 'lt1',
  name: '热敏纸标准',
  paper: 'THERMAL_4X6',
  options: { ...DEFAULT_LABEL_OPTIONS },
  boxNoRule: { ...DEFAULT_BOX_NO_RULE },
  isDefault: true,
  version: 1,
  createdAt: '2026-12-10T08:00:00Z',
  updatedAt: '2026-12-10T08:00:00Z',
  ...over,
})
const labelsResponse = (over: Partial<InboundLabelsResponse> = {}): InboundLabelsResponse => ({
  labels: [
    {
      id: 'job1',
      kind: 'BOX',
      shipmentId: 'FBA-SH-1',
      status: 'READY',
      statusLabel: '可下载',
      pageType: THERMAL,
      errorMessage: null,
      createdAt: '2026-12-11T08:00:00Z',
      url: 'https://files.example/a.pdf',
    },
  ],
  note: '箱标签由亚马逊生成（PDF）。生成的文件在导出中心下载。',
  printStats: [stat()],
  ...over,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  [B]: () => ok(overview('TRANSPORT_CONFIRMED')),
  [`${B}/options`]: () => ok(options()),
  [`${B}/boxes`]: () => ok({ boxes: [], validation: { ok: false, rows: [], problems: [] }, groups: [] }),
  [`${B}/shipments`]: () => ok({ shipments: [shipmentView()] }),
  [`${B}/operations`]: () => ok({ operations: [] }),
  [`${B}/labels`]: () => ok(labelsResponse()),
  '/label-templates': () => ok({ items: [template()], page: 1, pageSize: 50, total: 1, summary: { total: 1, defaultName: '热敏纸标准' }, canManage: true, manageBlockedReason: null }),
  ...over,
})
const mount = (over: Record<string, Handler> = {}, permissions?: string[]) => mountApp({ url: '/app/supply-chain/p1', pages, handlers: handlers(over, permissions) })
const openTab = async () => {
  await userEvent.click(await screen.findByRole('tab', { name: '标签与发货' }))
  await userEvent.click(await screen.findByRole('tab', { name: '标签' }))
}
const lastDialog = async () => {
  const dialogs = await screen.findAllByRole('dialog')
  return dialogs[dialogs.length - 1]
}
const record =
  (sink: { path?: string; body?: unknown }): Handler =>
  (url, init) => {
    sink.path = url.pathname
    sink.body = JSON.parse(String(init?.body))
    return {
      status: 201,
      body: { success: true, data: { exportId: 'ex1', status: 'QUEUED', statusLabel: '排队中', kindLabel: '自定义箱标签', notes: ['文件在导出中心生成，完成后到 /app/my/exports 下载'] } },
    }
  }

describe('入仓计划：标签页签', () => {
  it('按货件显示已取到的纸张与生成次数；亚马逊箱标签文件另表列出，带下载链接', async () => {
    mount()
    await openTab()
    expect(await screen.findByText('已取到的亚马逊箱标签')).toBeInTheDocument()
    expect(await screen.findByText('Thermal_NonPCP', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('亚马逊箱标签文件')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: '下载' })).toHaveAttribute('href', 'https://files.example/a.pdf')
    expect(screen.getByText(/生成的文件在导出中心下载/)).toBeInTheDocument()
    expect(screen.queryByText(/商品标签清单（CSV）/)).not.toBeInTheDocument()
  })

  it('货件行：生成自定义箱标签——不选模板用默认；提交到货件接口并提示去导出中心', async () => {
    const sink: { path?: string; body?: unknown } = {}
    mount({ '/inbound/shipments/sh1/labels/custom': record(sink) })
    await openTab()
    await userEvent.click(await screen.findByRole('button', { name: '生成自定义箱标签' }))
    const dialog = await lastDialog()
    expect(within(dialog).getByText(/对运营中心签收是否有影响/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/还没有取到/)).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /开始生成/ }))
    await waitFor(() => expect(sink.body).toEqual({}))
    expect(await screen.findByText(/已创建“自定义箱标签”任务/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: '打开导出中心' })[0]).toHaveAttribute('href', '/app/my/exports')
  })

  it('模板对应的纸张还没取到亚马逊箱标签：弹窗里直接写明要先取哪种页面类型', async () => {
    mount({ [`${B}/labels`]: () => ok(labelsResponse({ printStats: [stat({ readyPageTypes: [] })] })) })
    await openTab()
    await userEvent.click(await screen.findByRole('button', { name: '生成自定义箱标签' }))
    const dialog = await lastDialog()
    expect(within(dialog).getByText('还没有取到“热敏纸 4×6 英寸”的亚马逊箱标签')).toBeInTheDocument()
    expect(within(dialog).getByText(new RegExp(THERMAL))).toBeInTheDocument()
  })

  it('货件还没有箱数：生成自定义箱标签按钮禁用', async () => {
    mount({ [`${B}/labels`]: () => ok(labelsResponse({ printStats: [stat({ boxes: null })] })) })
    await openTab()
    expect(await screen.findByRole('button', { name: '生成自定义箱标签' })).toBeDisabled()
    expect(screen.getAllByText('尚无记录').length).toBeGreaterThan(0)
  })

  it('生成商品标签：默认热敏 60×40、印“New”；不选货件就按整个计划；提交到计划接口', async () => {
    const sink: { path?: string; body?: unknown } = {}
    mount({ [`${B}/item-labels`]: record(sink) })
    await openTab()
    const buttons = await screen.findAllByRole('button', { name: /生成商品标签（PDF）/ })
    await userEvent.click(buttons[0]!)
    const dialog = await lastDialog()
    expect(within(dialog).getByText(/Code 128/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /跳过没有 FNSKU/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: /开始生成/ }))
    await waitFor(() => expect(sink.body).toEqual({ size: 'THERMAL_60X40', showTitle: false, showCondition: true, skipMissingFnsku: true }))
  })

  it('没有导出权限：两个生成动作都禁用，原因指向导出权限', async () => {
    mount({}, ['inbound.read', 'inbound.plan.write', 'labeltemplate.manage'])
    await openTab()
    const buttons = await screen.findAllByRole('button', { name: /生成商品标签（PDF）/ })
    for (const button of buttons) expect(button).toBeDisabled()
    expect(await screen.findByRole('button', { name: '生成自定义箱标签' })).toBeDisabled()
  })
})
