import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { analyzePacking, parseCsvTable, type PackingPreviewResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../../test/app-harness'
import type { LivePages } from '../../../routes/live-pages'
import { ok, overview } from '../inbound-fixtures.test-helper'

// 装箱单匹配页签（P6-11）：选文件 → 服务端识别预览 → 逐行确认 → 应用到箱内物品。
// 预览响应用契约里同一个 analyzePacking 现算（服务端也是它），测试只验证页面的交互与请求内容。

const pages: LivePages = {
  InboundPlansPage: { load: () => import('../InboundPlansPage') },
  InboundPlanDetailPage: { load: () => import('../InboundPlanDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const B = '/inbound/plans/p1'
const CSV = ['货号,品名,每箱数量,箱数,长(in),宽(in),高(in),毛重(lb)', 'SKU-A,蓝牙耳机 黑色,10,1,12,12,12,20', 'ZZ-9,手机壳 红色,5,1,12,12,12,10'].join('\r\n')

const preview = (csv: string, over: Partial<PackingPreviewResponse> = {}): PackingPreviewResponse => {
  const items = overview().items.map(({ sku, fnsku, asin, productName }) => ({ sku, fnsku, asin, productName }))
  return {
    ...analyzePacking({ table: parseCsvTable(csv), items, aliases: [], supplierId: null }),
    planId: 'p1',
    fileName: 'pl.csv',
    format: 'CSV',
    sheet: null,
    sheets: [],
    supplier: null,
    savedMapping: false,
    canApply: true,
    applyBlockedReason: null,
    existingBoxTypes: 2,
    canRemember: true,
    rememberBlockedReason: null,
    ...over,
  }
}

const mount = (over: Record<string, Handler> = {}, permissions: string[] = ['*']) =>
  mountApp({
    url: '/app/supply-chain/p1',
    pages,
    handlers: {
      '/auth/me': () => ok({ ...defaultMe, permissions }),
      [B]: () => ok(overview('PACKING_CONFIRMED')),
      [`${B}/boxes`]: () => ok({ boxes: [], validation: { ok: false, rows: [], problems: [] }, groups: [] }),
      [`${B}/options`]: () =>
        ok({
          packing: [],
          placement: [],
          recommendation: { placementOptionId: null, basis: 'NONE', missing: [], note: '' },
          transport: [],
          windows: [],
          shipments: [],
          estimate: null,
          totalWeightLb: null,
        }),
      [`${B}/packing-list/parse`]: () => ok(preview(CSV)),
      ...over,
    },
  })

const openTab = async () => {
  await screen.findByText('10 月补货')
  await userEvent.click(screen.getByRole('tab', { name: '装箱' }))
  await userEvent.click(await screen.findByRole('tab', { name: '装箱单匹配' }))
}
const pick = async (content = CSV, name = 'pl.csv') => {
  await userEvent.upload(await screen.findByLabelText('装箱单文件'), new File([content], name, { type: 'text/csv' }))
}
const applyButton = () => screen.getByRole('button', { name: /应用到箱内物品/ })

describe('装箱单匹配页签', () => {
  it('没选文件：说明匹配顺序，应用按钮禁用', async () => {
    mount()
    await openTab()
    expect(await screen.findByText(/匹配顺序：先与计划里的 SKU/)).toBeInTheDocument()
    expect(applyButton()).toBeDisabled()
  })

  it('选文件后把文件内容交给服务端识别，显示汇总；还有未匹配的行时不能应用', async () => {
    const sink: { body?: Record<string, unknown> } = {}
    mount({
      [`${B}/packing-list/parse`]: (_url, init) => {
        sink.body = JSON.parse(String(init?.body))
        return ok(preview(CSV))
      },
    })
    await openTab()
    await pick()
    expect(await screen.findByTestId('packing-summary')).toHaveTextContent('共 2 行：已匹配 1，候选 0，未匹配 1')
    expect(sink.body).toEqual({ fileName: 'pl.csv', format: 'CSV', content: CSV, supplierId: null })
    await waitFor(() => expect(document.querySelectorAll('[row-id]').length).toBeGreaterThanOrEqual(2))
    expect(screen.getByTestId('packing-summary')).toHaveTextContent('待选 SKU 1 行')
    expect(applyButton()).toBeDisabled()
  })

  it('给未匹配的行选了 SKU 或忽略它，应用才可用；应用带版本号与逐行决定，成功后跳到箱内物品', async () => {
    const sink: { body?: Record<string, unknown> } = {}
    mount({
      [`${B}/packing-list/apply`]: (_url, init) => {
        sink.body = JSON.parse(String(init?.body))
        return { status: 200, body: { success: true, data: { plan: overview().plan, state: 'SAVED', imported: { boxTypes: 2, boxes: 2, units: 15 }, ignored: 0, remembered: 0 } } }
      },
    })
    await openTab()
    await pick()
    await screen.findByTestId('packing-summary')
    const chooser = await screen.findByRole('combobox', { name: '第 3 行对应的 SKU' })
    await userEvent.click(chooser)
    await userEvent.click(await screen.findByText('SKU-B 商品 B', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(applyButton()).toBeEnabled())
    expect(screen.getByTestId('packing-summary')).toHaveTextContent('可装箱 2 行，待选 SKU 0 行')

    await userEvent.click(applyButton())
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/将整体替换现有的 2 个箱型/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('checkbox'))
    await userEvent.click(dialog.getByRole('button', { name: /^应\s?用$/ }))
    await waitFor(() => expect(sink.body).toMatchObject({ version: 3, fileName: 'pl.csv', format: 'CSV', decisions: [{ line: 3, sku: 'SKU-B' }] }))
    // 写入后停在“箱内物品”页签
    await waitFor(() => expect(screen.getByRole('tab', { name: '箱内物品', selected: true })).toBeInTheDocument())
  })

  it('忽略这一行也能解决；“记住”只有选了 SKU 才能勾，并且会带进决定', async () => {
    const sink: { body?: Record<string, unknown> } = {}
    mount({
      [`${B}/packing-list/apply`]: (_url, init) => {
        sink.body = JSON.parse(String(init?.body))
        return { status: 200, body: { success: true, data: { plan: overview().plan, state: 'SAVED', imported: { boxTypes: 1, boxes: 1, units: 10 }, ignored: 1, remembered: 0 } } }
      },
    })
    await openTab()
    await pick()
    await screen.findByTestId('packing-summary')
    const remember = await screen.findByRole('checkbox', { name: '第 3 行记住对应关系' })
    expect(remember).toBeDisabled()
    await userEvent.click(await screen.findByRole('checkbox', { name: '第 3 行忽略' }))
    await waitFor(() => expect(applyButton()).toBeEnabled())
    expect(screen.getByTestId('packing-summary')).toHaveTextContent('忽略 1 行')
    await userEvent.click(applyButton())
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('checkbox'))
    await userEvent.click(dialog.getByRole('button', { name: /^应\s?用$/ }))
    await waitFor(() => expect(sink.body).toMatchObject({ decisions: [{ line: 3, ignore: true }] }))
  })

  it('没有“写入入仓计划”权限：能预览，决定与应用都不可用', async () => {
    mount({}, ['inbound.read'])
    await openTab()
    await pick()
    await screen.findByTestId('packing-summary')
    expect(applyButton()).toBeDisabled()
    expect(await screen.findByRole('combobox', { name: '第 3 行对应的 SKU' })).toBeDisabled()
  })

  it('老版 Excel（.xls）：不上传，提示另存为 .xlsx 或 CSV', async () => {
    const app = mount()
    await openTab()
    await pick('x', 'old.xls')
    expect(await screen.findByText(/不支持老版 Excel/)).toBeInTheDocument()
    expect(app.calls.some(call => call.path === `${B}/packing-list/parse`)).toBe(false)
  })

  it('缺少必需的列：展开识别设置，写明缺什么，不显示预览表也不能应用', async () => {
    const csv = ['品名,备注', '蓝牙耳机,x'].join('\n')
    mount({ [`${B}/packing-list/parse`]: () => ok(preview(csv)) })
    await openTab()
    await pick(csv)
    expect(await screen.findByText(/还缺少：/)).toBeInTheDocument()
    expect(screen.getByTestId('packing-settings')).toBeInTheDocument()
    expect(applyButton()).toBeDisabled()
  })

  it('服务端拒绝（例如文件有问题）：显示服务端给的原因，不显示预览', async () => {
    mount({
      [`${B}/packing-list/parse`]: () => ({ status: 422, body: { success: false, error: { code: 'VALIDATION_FAILED', message: '文件有问题', fieldErrors: { content: ['表头行超出了文件范围'] } } } }),
    })
    await openTab()
    await pick()
    expect(await screen.findByText('表头行超出了文件范围')).toBeInTheDocument()
    expect(screen.queryByTestId('packing-summary')).not.toBeInTheDocument()
  })
})
