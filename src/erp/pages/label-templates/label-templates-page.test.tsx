import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS, type LabelTemplateListResponse, type LabelTemplateRow } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { optionsSummary } from './label-templates-columns'

// 标签模板页（P6-12）：PagedGrid 列表、按权限禁用写操作、新增时实时预览箱号、纸张与选项冲突被前端拦下、提交到服务端。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { LabelTemplatesPage: { load: () => import('./LabelTemplatesPage') } }
const ok = (data: unknown) => ({ body: { success: true, data } })

const row = (patch: Partial<LabelTemplateRow> = {}): LabelTemplateRow => ({
  id: 'lt1',
  name: '热敏纸标准',
  paper: 'THERMAL_4X6',
  options: { ...DEFAULT_LABEL_OPTIONS },
  boxNoRule: { ...DEFAULT_BOX_NO_RULE },
  isDefault: true,
  version: 1,
  createdAt: '2026-12-10T08:00:00Z',
  updatedAt: '2026-12-10T08:00:00Z',
  ...patch,
})

const list = (items: LabelTemplateRow[], patch: Partial<LabelTemplateListResponse> = {}): LabelTemplateListResponse => ({
  items,
  page: 1,
  pageSize: 50,
  total: items.length,
  summary: { total: items.length, defaultName: items.find(item => item.isDefault)?.name ?? null },
  canManage: true,
  manageBlockedReason: null,
  ...patch,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/label-templates': () => ok(list([row(), row({ id: 'lt2', name: 'A4 四拼', paper: 'A4_4UP', isDefault: false, boxNoRule: { ...DEFAULT_BOX_NO_RULE, prefix: 'CT', digits: 4 } })])),
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('标签模板页', () => {
  it('列表：显示纸张、会印的内容与箱号示例；默认模板有标记；顶部说明签收风险与字体要求', async () => {
    mountApp({ url: '/app/settings/label-templates', pages, handlers: handlers() })
    expect(await screen.findByText('热敏纸标准')).toBeInTheDocument()
    expect(screen.getByText('A4 四拼')).toBeInTheDocument()
    expect(screen.getByText('默认')).toBeInTheDocument()
    expect(screen.getByText(/共 2 个模板（上限 50 个）/)).toBeInTheDocument()
    expect(screen.getByText(/默认模板：热敏纸标准/)).toBeInTheDocument()
    expect(screen.getByText(/对运营中心签收是否有影响/)).toBeInTheDocument()
    expect(screen.getByText(/LABEL_FONT_PATH/)).toBeInTheDocument()
    expect(screen.getByText('CT-0001、CT-0002')).toBeInTheDocument()
  })

  it('会印的内容一句话列出：原产地带文字，没有勾选时如实说明', () => {
    expect(optionsSummary(DEFAULT_LABEL_OPTIONS)).toContain('原产地（Made in China）')
    expect(optionsSummary({ ...DEFAULT_LABEL_OPTIONS, showOrigin: false, showSku: false, showUnits: false, showBoxNo: false })).toBe('没有勾选任何内容')
  })

  it('没有“标签模板维护”权限：新增按钮禁用，并显示服务端给出的原因', async () => {
    mountApp({
      url: '/app/settings/label-templates',
      pages,
      handlers: handlers({ '/label-templates': () => ok(list([row()], { canManage: false, manageBlockedReason: '你没有维护标签模板的权限' })) }, ['inbound.read']),
    })
    expect(await screen.findByText('热敏纸标准')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新增标签模板/ })).toBeDisabled()
    expect(await screen.findByText('你可以查看标签模板，但不能修改')).toBeInTheDocument()
  })

  it('没有任何模板：说明怎么新增与不选模板时用什么，不显示空白表', async () => {
    mountApp({ url: '/app/settings/label-templates', pages, handlers: handlers({ '/label-templates': () => ok(list([])) }) })
    expect(await screen.findByText(/还没有标签模板/)).toBeInTheDocument()
    expect(screen.getByText(/没有默认模板，不选模板时用系统内置的默认设置/)).toBeInTheDocument()
  })

  it('新增：箱号规则实时预览；换成 A4 拼版后“追加到原标签”自动取消并置灰；A4 选我方箱号顺序被前端拦下；改好后提交完整的请求体', async () => {
    let body: Record<string, any> | null = null
    const app = mountApp({
      url: '/app/settings/label-templates',
      pages,
      handlers: handlers({
        '/label-templates': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body)) as Record<string, any>
            return { status: 201, body: { success: true, data: row({ id: 'lt3' }) } }
          }
          return ok(list([row()]))
        },
      }),
    })
    await screen.findByText('热敏纸标准')
    await userEvent.click(screen.getByRole('button', { name: /新增标签模板/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('box-no-preview')).toHaveTextContent('BOX-001、BOX-002、BOX-003')

    // 名称为空：被前端拦下，不发请求
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    expect((await within(dialog).findAllByText(/请填写模板名称/)).length).toBeGreaterThan(0)
    expect(app.calls.some(call => call.method === 'POST' && call.path === '/label-templates')).toBe(false)

    await userEvent.type(within(dialog).getByLabelText('模板名称'), '  A4 两拼 ')
    await userEvent.clear(within(dialog).getByLabelText('箱号前缀'))
    await userEvent.type(within(dialog).getByLabelText('箱号前缀'), 'CT')
    await waitFor(() => expect(within(dialog).getByTestId('box-no-preview')).toHaveTextContent('CT-001、CT-002、CT-003'))

    // 热敏纸可以勾选“追加到原标签”；换成 A4 拼版后该选项自动取消并置灰（多张拼版不能追加，只能附页）
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '追加到原标签' }))
    expect(within(dialog).getByRole('checkbox', { name: '追加到原标签' })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('combobox', { name: '纸张规格' }))
    await userEvent.click(await screen.findByText('A4 每页 2 张', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: '追加到原标签' })).toBeDisabled())
    expect(within(dialog).getByRole('checkbox', { name: '追加到原标签' })).not.toBeChecked()

    // A4 拼版不能按我方箱号重排：选“我方箱号顺序”提交被前端拦下并写明原因
    await userEvent.click(within(dialog).getByRole('combobox', { name: '标签顺序' }))
    await userEvent.click(await screen.findByText('我方箱号顺序', { selector: '.ant-select-item-option-content' }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    expect((await within(dialog).findAllByText(/不能按我方箱号重新排序/)).length).toBeGreaterThan(0)
    expect(body).toBeNull()

    await userEvent.click(within(dialog).getByRole('combobox', { name: '标签顺序' }))
    await userEvent.click(await screen.findByText('亚马逊原始顺序', { selector: '.ant-select-item-option-content' }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toMatchObject({
      name: 'A4 两拼',
      paper: 'A4_2UP',
      isDefault: false,
      options: { ...DEFAULT_LABEL_OPTIONS, appendToOriginal: false, order: 'AMAZON' },
      boxNoRule: { ...DEFAULT_BOX_NO_RULE, prefix: 'CT' },
    })
  }, 60_000)
})
