import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../../test/app-harness'
import type { LivePages } from '../../../routes/live-pages'
import { ok, overview } from '../inbound-fixtures.test-helper'

// 装箱可视编辑器（P6-10）：每箱一行、箱内商品子行；加箱、复制、删箱、批量设箱规、底部合计与标红、本地校验后保存草稿、只读、表格文件导入。

const pages: LivePages = {
  InboundPlansPage: { load: () => import('../InboundPlansPage') },
  InboundPlanDetailPage: { load: () => import('../InboundPlanDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const B = '/inbound/plans/p1'
const boxView = (boxId: string, quantity: number, items: Array<{ sku: string; quantity: number }>, weightLb = 10) => ({
  boxId,
  packingGroupId: null,
  quantity,
  weightLb,
  lengthIn: 12,
  widthIn: 12,
  heightIn: 12,
  items,
  labelStatus: 'NONE',
})
// 计划：SKU-A 10 件、SKU-B 5 件；两个箱型各 1 箱，合起来正好装齐
const serverBoxes = (secondA = 4) => [
  boxView('B1', 1, [{ sku: 'SKU-A', quantity: 6 }], 20),
  boxView('B2', 1, [
    { sku: 'SKU-A', quantity: secondA },
    { sku: 'SKU-B', quantity: 5 },
  ]),
]
const boxesResponse = (boxes = serverBoxes()) => ({
  boxes,
  validation: { ok: true, rows: [], problems: [] },
  groups: [],
})
const saved =
  (sink: { body?: unknown }): Handler =>
  (_url, init) => {
    sink.body = JSON.parse(String(init?.body))
    return { status: 200, body: { success: true, data: { plan: overview().plan, state: 'SAVED', jobId: null, operationId: null } } }
  }

const mount = (over: Record<string, Handler> = {}, stage: Parameters<typeof overview>[0] = 'PACKING_CONFIRMED', permissions: string[] = ['*']) =>
  mountApp({
    url: '/app/supply-chain/p1',
    pages,
    handlers: {
      '/auth/me': () => ok({ ...defaultMe, permissions }),
      [B]: () => ok(overview(stage)),
      [`${B}/boxes`]: () => ok(boxesResponse()),
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
      ...over,
    },
  })

const openEditor = async () => {
  await screen.findByText('10 月补货')
  await userEvent.click(screen.getByRole('tab', { name: '装箱' }))
  await userEvent.click(await screen.findByRole('tab', { name: '箱内物品' }))
}
const rowId = (name: string) =>
  Array.from(document.querySelectorAll('[row-id]'))
    .find(el => el.querySelector('[col-id="name"]')?.textContent === name)
    ?.getAttribute('row-id') ?? ''
const waitRow = async (name: string) => {
  await waitFor(() => expect(rowId(name)).not.toBe(''))
  return rowId(name)
}
const rowButton = (id: string, name: string) => Array.from(document.querySelectorAll(`[row-id="${id}"] button`)).find(el => el.textContent?.replace(/\s/g, '') === name) as HTMLElement
const select = (id: string) => userEvent.click(document.querySelector(`[row-id="${id}"] .ag-selection-checkbox input`) as HTMLElement)
const totals = () => within(screen.getByTestId('box-totals'))
const drawer = () => within(document.querySelector('.ant-drawer-content') as HTMLElement)

describe('装箱可视编辑器', () => {
  it('每箱一行，底部合计：箱数、已装与计划件数、总重、总体积（立方英尺与立方米）；合起来装齐时不标红', async () => {
    mount()
    await openEditor()
    await waitRow('B1')
    await waitRow('B2')
    expect(await screen.findByText('每个 SKU 的装箱总数与计划一致，可以提交')).toBeInTheDocument()
    expect(screen.getByTestId('totals-units')).toHaveTextContent('15 / 15')
    expect(screen.getByTestId('totals-weight')).toHaveTextContent('30.00 磅')
    expect(screen.getByTestId('totals-volume')).toHaveTextContent('2.00 立方英尺（0.06 立方米）')
    expect(totals().getByText(/箱数：/)).toHaveTextContent('2')
    expect(screen.getByTestId('sku-SKU-A')).not.toHaveClass('ant-typography-danger')
  })

  it('已装与计划不一致的 SKU 标红并写明多少；还没有箱子时重量与体积写“尚无记录”，不写 0', async () => {
    mount({ [`${B}/boxes`]: () => ok(boxesResponse(serverBoxes(3))) })
    await openEditor()
    await waitRow('B1')
    expect(screen.getByTestId('sku-SKU-A')).toHaveClass('ant-typography-danger')
    expect(screen.getByTestId('sku-SKU-A')).toHaveTextContent('已装 9 / 计划 10（少 1）')
    expect(screen.getByTestId('sku-SKU-B')).not.toHaveClass('ant-typography-danger')
    expect(screen.getByTestId('totals-units')).toHaveClass('ant-typography-danger')
  })

  it('没有箱子：显示空状态与合计的“尚无记录”', async () => {
    mount({ [`${B}/boxes`]: () => ok({ boxes: [], validation: { ok: false, rows: [], problems: [] }, groups: [] }) })
    await openEditor()
    expect(await screen.findByText(/还没有箱子/)).toBeInTheDocument()
    expect(screen.getByTestId('totals-weight')).toHaveTextContent('尚无记录')
    expect(screen.getByTestId('totals-volume')).toHaveTextContent('尚无记录')
    expect(screen.getByTestId('totals-units')).toHaveTextContent('0 / 15')
  })

  it('加箱：新箱沿用最后一箱的箱规、没有商品，保存草稿被本地校验拦下并写明原因', async () => {
    mount()
    await openEditor()
    await waitRow('B2')
    await userEvent.click(screen.getByRole('button', { name: '添加箱子' }))
    await waitRow('BOX-001')
    expect(totals().getByText(/箱数：/)).toHaveTextContent('3')
    expect(screen.getByText(/保存前要先改 1 处/)).toBeInTheDocument()
    expect(screen.getByText(/BOX-001 里还没有商品/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存草稿/ })).toBeDisabled()
    expect(screen.getByTestId('sku-SKU-A')).toHaveTextContent('已装 10 / 计划 10')
  })

  it('复制箱：插在原箱后面，件数翻倍后超出计划的标红“多”', async () => {
    mount()
    await openEditor()
    const first = await waitRow('B1')
    await userEvent.click(rowButton(first, '复制'))
    await waitRow('BOX-001')
    expect(screen.getByTestId('sku-SKU-A')).toHaveTextContent('已装 16 / 计划 10（多 6）')
    expect(screen.getByTestId('sku-SKU-A')).toHaveClass('ant-typography-danger')
  })

  it('删箱：确认后从草稿里去掉，合计随之变化', async () => {
    mount()
    await openEditor()
    const second = await waitRow('B2')
    await userEvent.click(rowButton(second, '删除'))
    const pop = await waitFor(() => {
      const el = document.querySelector('.ant-popover') as HTMLElement
      expect(el).toBeTruthy()
      return within(el)
    })
    await userEvent.click(pop.getByRole('button', { name: /^删\s?除$/ }))
    await waitFor(() => expect(rowId('B2')).toBe(''))
    expect(screen.getByTestId('totals-units')).toHaveTextContent('6 / 15')
    expect(screen.getByTestId('sku-SKU-B')).toHaveTextContent('已装 0 / 计划 5（少 5）')
  })

  it('批量设箱规：选中几个箱子一起填重量，没填的项保持原值，合计跟着变', async () => {
    mount()
    await openEditor()
    const first = await waitRow('B1')
    const second = await waitRow('B2')
    await select(first)
    await select(second)
    await userEvent.click(await screen.findByRole('button', { name: '批量设箱规' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('批量重量（磅）'), '50')
    await userEvent.click(dialog.getByRole('button', { name: /^应\s?用$/ }))
    await waitFor(() => expect(screen.getByTestId('totals-weight')).toHaveTextContent('100.00 磅'))
    expect(screen.getByTestId('totals-volume')).toHaveTextContent('2.00 立方英尺')
  })

  it('编辑箱子、保存草稿：本地校验通过后带版本号提交整份箱子', async () => {
    const sink: { body?: unknown } = {}
    mount({ [`${B}/boxes`]: (url, init) => (init?.method === 'PUT' ? saved(sink)(url, init) : ok(boxesResponse())) })
    await openEditor()
    const first = await waitRow('B1')
    const save = screen.getByRole('button', { name: /保存草稿/ })
    expect(save).toBeDisabled()
    await userEvent.click(rowButton(first, '编辑'))
    await waitFor(() => expect(document.querySelector('.ant-drawer-content')).toBeTruthy())
    const count = drawer().getByLabelText('相同箱数')
    await userEvent.clear(count)
    await userEvent.type(count, '2')
    await userEvent.click(drawer().getByRole('button', { name: /应用修改/ }))
    await waitFor(() => expect(screen.getByTestId('sku-SKU-A')).toHaveTextContent('已装 16 / 计划 10（多 6）'))
    expect(screen.getByText(/有未保存的修改，点“保存草稿”后才会保存/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /保存草稿/ })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /保存草稿/ }))
    await waitFor(() => expect(sink.body).toBeDefined())
    expect(sink.body).toMatchObject({
      version: 3,
      boxes: [
        { boxId: 'B1', quantity: 2, weightLb: 20, lengthIn: 12, widthIn: 12, heightIn: 12, items: [{ sku: 'SKU-A', quantity: 6 }] },
        {
          boxId: 'B2',
          quantity: 1,
          items: [
            { sku: 'SKU-A', quantity: 4 },
            { sku: 'SKU-B', quantity: 5 },
          ],
        },
      ],
    })
  })

  it('放弃修改：回到服务端上的版本', async () => {
    mount()
    await openEditor()
    await waitRow('B2')
    await userEvent.click(screen.getByRole('button', { name: '添加箱子' }))
    await waitRow('BOX-001')
    await userEvent.click(screen.getByRole('button', { name: /放弃修改/ }))
    await waitFor(() => expect(rowId('BOX-001')).toBe(''))
    expect(totals().getByText(/箱数：/)).toHaveTextContent('2')
  })

  it('现在不能改箱子（装箱方案还没确认）：只读，写明服务端给出的原因，没有添加与保存按钮', async () => {
    mount({}, 'CREATED')
    await openEditor()
    expect(await screen.findByText('现在不能修改箱内物品')).toBeInTheDocument()
    await waitRow('B1')
    expect(screen.queryByRole('button', { name: '添加箱子' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /保存草稿/ })).not.toBeInTheDocument()
    expect(document.querySelector('[row-id] .erp-cell-actions')).toBeNull()
  })

  it('没有 inbound.plan.write 权限：能看不能存，保存草稿禁用', async () => {
    mount({}, 'PACKING_CONFIRMED', ['inbound.read'])
    await openEditor()
    await waitRow('B1')
    expect(screen.getByRole('button', { name: /保存草稿/ })).toBeDisabled()
  })
})

describe('表格文件导入', () => {
  const CSV_HEADER = '箱号,SKU,每箱数量,重量(磅),长(英寸),宽(英寸),高(英寸),相同箱数'
  const upload = async (content: string, name = 'boxes.csv') => {
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.upload(dialog.getByLabelText('装箱文件'), new File([content], name, { type: 'text/csv' }))
    return dialog
  }
  const openImport = async () => {
    await openEditor()
    await waitRow('B1')
    await userEvent.click(screen.getByRole('button', { name: /用表格文件导入/ }))
  }

  it('有错误的文件：本地预检逐行列出原因（含 SKU 不在计划内），不能导入', async () => {
    mount()
    await openImport()
    const dialog = await upload([CSV_HEADER, 'X1,SKU-A,5,20,16,12,10', 'X2,GHOST,5,20,16,12,10'].join('\r\n'))
    const list = await dialog.findByTestId('box-file-errors')
    expect(list).toHaveTextContent('第 3 行：SKU：GHOST 不在这个计划里')
    await userEvent.click(dialog.getByRole('button', { name: /^导\s?入$/ }))
    expect(await dialog.findByText(/请按下面的提示修正/)).toBeInTheDocument()
  })

  it('缺关键列：整份拒绝并说明缺哪一列', async () => {
    mount()
    await openImport()
    const dialog = await upload(['箱号,SKU,每箱数量,重量,长,宽', 'X1,SKU-A,5,20,16,12'].join('\n'))
    expect(await dialog.findByTestId('box-file-errors')).toHaveTextContent('缺少“高(英寸)”列')
  })

  it('正常的文件：预览行数与箱型数，带版本号、模板类型与文件名提交到服务端', async () => {
    const sink: { body?: unknown } = {}
    mount({
      [`${B}/boxes/import`]: (_url, init) => {
        sink.body = JSON.parse(String(init?.body))
        return { status: 201, body: { success: true, data: { plan: overview().plan, state: 'SAVED', imported: { boxTypes: 2, boxes: 3, units: 15 }, skipped: [] } } }
      },
    })
    await openImport()
    const content = [CSV_HEADER, 'X1,SKU-A,6,22,16,12,10,2', 'X1,SKU-B,1,22,16,12,10,2', 'X2,SKU-A,1,18,14,12,10'].join('\r\n')
    const dialog = await upload(content)
    expect(await dialog.findByTestId('box-file-preview')).toHaveTextContent('预览：3 行，2 个箱型')
    await userEvent.click(dialog.getByRole('button', { name: /^导\s?入$/ }))
    await waitFor(() => expect(sink.body).toEqual({ version: 3, kind: 'MIXED', fileName: 'boxes.csv', content }))
  })

  it('下载模板：从服务端取模板内容并生成文件', async () => {
    const blobs: Blob[] = []
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = (blob: Blob | MediaSource) => (blobs.push(blob as Blob), 'blob:test')
    URL.revokeObjectURL = () => undefined
    try {
      mount({ '/inbound/box-templates/MIXED': () => ok({ kind: 'MIXED', fileName: '装箱导入模板-混装.csv', content: '\uFEFF箱号,SKU\r\n', maxRows: 2000, columns: [] }) })
      await openImport()
      const dialog = within(await screen.findByRole('dialog'))
      await userEvent.click(dialog.getByRole('button', { name: /下载模板/ }))
      await waitFor(() => expect(blobs).toHaveLength(1))
      expect(await blobs[0]!.text()).toContain('箱号,SKU')
    } finally {
      Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke })
    }
  })
})
