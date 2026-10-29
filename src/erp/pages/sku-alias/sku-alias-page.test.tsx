import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PackingMappingListResponse, PackingMappingRow, SkuAliasListResponse, SkuAliasRow } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 外部货号映射页（P6-11）：映射列表、按权限禁用写操作、新增与文件导入提交到服务端、装箱单列映射页签。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { SkuAliasesPage: { load: () => import('./SkuAliasesPage') } }
const ok = (data: unknown) => ({ body: { success: true, data } })

const alias = (patch: Partial<SkuAliasRow> = {}): SkuAliasRow => ({
  id: 'a1',
  supplierId: 'sup1',
  supplierCode: 'SUP-1',
  supplierName: '深圳工厂',
  externalCode: 'AB-1001',
  sku: 'SKU-A',
  skuTitle: '蓝牙耳机',
  source: 'MANUAL',
  version: 1,
  updatedAt: '2026-12-10T08:00:00Z',
  ...patch,
})

const list = (items: SkuAliasRow[], patch: Partial<SkuAliasListResponse> = {}): SkuAliasListResponse => ({
  items,
  page: 1,
  pageSize: 50,
  total: items.length,
  summary: { total: items.length, general: items.filter(item => !item.supplierId).length, supplier: items.filter(item => item.supplierId).length },
  canManage: true,
  manageBlockedReason: null,
  ...patch,
})

const mapping = (patch: Partial<PackingMappingRow> = {}): PackingMappingRow => ({
  supplierId: 'sup1',
  supplierCode: 'SUP-1',
  supplierName: '深圳工厂',
  columns: { code: '物料', perBox: '每箱数' },
  units: { length: 'IN', weight: 'LB' },
  version: 2,
  updatedAt: '2026-12-10T08:00:00Z',
  ...patch,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/suppliers': () => ok({ items: [{ id: 'sup1', code: 'SUP-1', name: '深圳工厂' }], page: 1, pageSize: 200, total: 1 }),
  '/sku-aliases': () =>
    ok(list([alias(), alias({ id: 'a2', supplierId: null, supplierCode: null, supplierName: null, externalCode: '6901234567890', sku: 'SKU-B', skuTitle: null, source: 'IMPORT' })])),
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('外部货号映射页', () => {
  it('列表：显示外部货号、对应 SKU、适用供应商（通用映射有标记）与统计', async () => {
    mountApp({ url: '/app/settings/sku-aliases', pages, handlers: handlers() })
    expect(await screen.findByText('AB-1001')).toBeInTheDocument()
    expect(screen.getByText('6901234567890')).toBeInTheDocument()
    expect(screen.getByText('SUP-1 深圳工厂')).toBeInTheDocument()
    expect(screen.getByText('通用（所有供应商）')).toBeInTheDocument()
    expect(screen.getByText('目录里没有标题')).toBeInTheDocument()
    expect(screen.getByText(/共 2 条映射/)).toBeInTheDocument()
    expect(screen.getByText(/通用 1 条/)).toBeInTheDocument()
  })

  it('没有“维护外部货号映射”权限：新增、导入禁用，并显示服务端给出的原因；仍可导出', async () => {
    mountApp({
      url: '/app/settings/sku-aliases',
      pages,
      handlers: handlers({ '/sku-aliases': () => ok(list([alias()], { canManage: false, manageBlockedReason: '你没有维护外部货号映射的权限' })) }, ['inbound.read']),
    })
    expect(await screen.findByText('AB-1001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新增映射/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /文件导入/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^导\s?出$/ })).toBeEnabled()
    expect(await screen.findByText('你可以查看外部货号映射，但不能修改')).toBeInTheDocument()
  })

  it('没有任何映射：说明怎么来（新增、导入、装箱单里勾选记住）', async () => {
    mountApp({ url: '/app/settings/sku-aliases', pages, handlers: handlers({ '/sku-aliases': () => ok(list([])) }) })
    expect(await screen.findByText(/还没有外部货号映射/)).toBeInTheDocument()
  })

  it('新增：必填项为空被前端拦下；选供应商并填完提交到服务端，货号与 SKU 去掉首尾空格', async () => {
    let body: Record<string, unknown> | null = null
    mountApp({
      url: '/app/settings/sku-aliases',
      pages,
      handlers: handlers({
        '/sku-aliases': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body)) as Record<string, unknown>
            return { status: 201, body: { success: true, data: alias({ id: 'a3' }) } }
          }
          return ok(list([alias()]))
        },
      }),
    })
    await screen.findByText('AB-1001')
    await userEvent.click(screen.getByRole('button', { name: /新增映射/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(within(dialog).getAllByText(/请填写/)).toHaveLength(2))
    expect(body).toBeNull()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^保\s?存$/ })).toBeEnabled())

    await userEvent.click(within(dialog).getByRole('combobox', { name: '适用供应商' }))
    await userEvent.click(await screen.findByText('SUP-1 深圳工厂', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(within(dialog).getByLabelText('外部货号'), '  ZZ-9 ')
    await userEvent.type(within(dialog).getByLabelText('对应 SKU'), 'SKU-B')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(body).toEqual({ supplierId: 'sup1', externalCode: 'ZZ-9', sku: 'SKU-B' }))
  })

  it('编辑：带版本号提交；服务端报版本冲突时显示原因，不假装成功', async () => {
    let body: Record<string, unknown> | null = null
    mountApp({
      url: '/app/settings/sku-aliases',
      pages,
      handlers: handlers({
        '/sku-aliases': () => ok(list([alias()])),
        '/sku-aliases/a1': (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return { status: 409, body: { success: false, error: { code: 'CONFLICT', message: '这条映射刚被别人修改过，请刷新后重试' } } }
        },
      }),
    })
    await screen.findByText('AB-1001')
    await userEvent.click(await screen.findByRole('button', { name: /^编\s?辑$/ }))
    const dialog = await screen.findByRole('dialog')
    const sku = within(dialog).getByLabelText('对应 SKU')
    await userEvent.clear(sku)
    await userEvent.type(sku, 'SKU-C')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存修\s?改$/ }))
    await waitFor(() => expect(body).toEqual({ version: 1, externalCode: 'AB-1001', sku: 'SKU-C' }))
    expect(await within(dialog).findByText(/刚被别人修改过/)).toBeInTheDocument()
  })

  it('文件导入：有错误的文件逐行列出原因，不能提交；正常的文件预览条数并提交', async () => {
    let body: Record<string, unknown> | null = null
    mountApp({
      url: '/app/settings/sku-aliases',
      pages,
      handlers: handlers({
        '/sku-aliases/import': (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return ok({ total: 2, created: 1, updated: 1 })
        },
      }),
    })
    await screen.findByText('AB-1001')
    await userEvent.click(screen.getByRole('button', { name: /文件导入/ }))
    const dialog = within(await screen.findByRole('dialog'))
    const input = dialog.getByLabelText('映射文件')
    await userEvent.upload(input, new File(['供应商编码,外部货号\nSUP-1,AB-1'], 'bad.csv', { type: 'text/csv' }))
    expect(await dialog.findByTestId('alias-file-errors')).toHaveTextContent('缺少“SKU”列')

    const good = '供应商编码,外部货号,SKU\r\nSUP-1,AB-1,SKU-A\r\n,条码-1,SKU-B'
    await userEvent.upload(input, new File([good], 'good.csv', { type: 'text/csv' }))
    expect(await dialog.findByTestId('alias-file-preview')).toHaveTextContent('预览：2 条映射')
    await userEvent.click(dialog.getByRole('button', { name: /^导\s?入$/ }))
    await waitFor(() => expect(body).toEqual({ fileName: 'good.csv', content: good }))
    expect(await screen.findByText(/已导入 2 条：新增 1 条，更新 1 条/)).toBeInTheDocument()
  })

  it('导出：从服务端取内容并生成文件；被截断时提示', async () => {
    const blobs: Blob[] = []
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = (blob: Blob | MediaSource) => (blobs.push(blob as Blob), 'blob:test')
    URL.revokeObjectURL = () => undefined
    try {
      mountApp({
        url: '/app/settings/sku-aliases',
        pages,
        handlers: handlers({ '/sku-aliases/export': () => ok({ fileName: '外部货号映射.csv', content: '\uFEFF供应商编码,外部货号,SKU\r\n', rows: 19_999, truncated: true }) }),
      })
      await screen.findByText('AB-1001')
      await userEvent.click(screen.getByRole('button', { name: /^导\s?出$/ }))
      await waitFor(() => expect(blobs).toHaveLength(1))
      expect(await blobs[0]!.text()).toContain('外部货号')
      expect(await screen.findByText(/只导出了前 19999 条/)).toBeInTheDocument()
    } finally {
      Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke })
    }
  })
})

describe('装箱单列映射页签', () => {
  const mappingList = (items: PackingMappingRow[], patch: Partial<PackingMappingListResponse> = {}): PackingMappingListResponse => ({ items, canManage: true, manageBlockedReason: null, ...patch })

  it('列出每个供应商保存的列对应与单位', async () => {
    mountApp({ url: '/app/settings/sku-aliases', pages, handlers: handlers({ '/packing-list-mappings': () => ok(mappingList([mapping()])) }) })
    await screen.findByText('AB-1001')
    await userEvent.click(screen.getByRole('tab', { name: '装箱单列映射' }))
    expect(await screen.findByText('货号＝物料；每箱件数＝每箱数')).toBeInTheDocument()
    expect(screen.getByText('英寸、磅')).toBeInTheDocument()
  })

  it('没有映射：说明怎么生成', async () => {
    mountApp({ url: '/app/settings/sku-aliases', pages, handlers: handlers({ '/packing-list-mappings': () => ok(mappingList([])) }) })
    await screen.findByText('AB-1001')
    await userEvent.click(screen.getByRole('tab', { name: '装箱单列映射' }))
    expect(await screen.findByText(/还没有保存过列映射/)).toBeInTheDocument()
  })

  it('删除：确认后调用服务端', async () => {
    let called = ''
    mountApp({
      url: '/app/settings/sku-aliases',
      pages,
      handlers: handlers({
        '/packing-list-mappings': () => ok(mappingList([mapping()])),
        '/packing-list-mappings/sup1': (_url, init) => {
          called = String(init?.method)
          return ok({ supplierId: 'sup1' })
        },
      }),
    })
    await screen.findByText('AB-1001')
    await userEvent.click(screen.getByRole('tab', { name: '装箱单列映射' }))
    await screen.findByText('货号＝物料；每箱件数＝每箱数')
    await userEvent.click(await screen.findByRole('button', { name: /^删\s?除$/ }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /^删\s?除$/ }))
    await waitFor(() => expect(called).toBe('DELETE'))
  })
})
