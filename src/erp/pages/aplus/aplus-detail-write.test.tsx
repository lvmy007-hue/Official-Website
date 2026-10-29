import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AplusDetailResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import { aplusHandlers, aplusPages, aplusRow, callsOf, detailResponse, failedRun, formModules, ok, runningDetail, WRITE_OFF } from './aplus-fixtures.test-helper'

// A+ 内容详情的写入（P4-14）：编辑（PATCH 带版本）、关联 ASIN（本地校验）、提交审核（二次确认）、写入开关与权限、写入记录与刷新。

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type Body = Record<string, unknown>
const accepted = { contentId: 'c1', runId: 'run-2', status: 'QUEUED', version: 4, queued: true }

const openDetail = async (response: () => AplusDetailResponse = () => detailResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url: '/app/aplus/c1', pages: aplusPages, me, handlers: aplusHandlers({ detail: response }, extra) })
  const page = within(await screen.findByTestId('aplus-detail-page', {}, { timeout: 15_000 }))
  return { app, page }
}
/** GET 返回详情；其它方法记录请求体并返回受理结果（或指定的错误）。 */
const detailOr =
  (method: string, bodies: Body[], result: { status: number; body: unknown } = { status: 201, body: ok(accepted).body }): Handler =>
  (_url, init) => {
    if ((init?.method ?? 'GET') !== method) return ok(detailResponse())
    bodies.push(JSON.parse(String(init?.body)))
    return result
  }
const btn = (page: ReturnType<typeof within>, name: string | RegExp) => page.getByRole('button', { name })
const EDIT = /编\s*辑/
const REFRESH = /刷\s*新/

describe('A+ 内容详情：编辑', () => {
  it('编辑器预填当前内容；保存发 PATCH，带版本号、名称与模块；提示“已登记”并刷新详情', async () => {
    const bodies: Body[] = []
    const { app, page } = await openDetail(undefined, { '/aplus/c1': detailOr('PATCH', bodies) })
    await userEvent.click(btn(page, EDIT))
    const drawer = within(await screen.findByRole('dialog'))
    expect(drawer.getByDisplayValue('旅行箱品牌故事')).toBeInTheDocument()
    expect(drawer.getByDisplayValue('品牌故事')).toBeInTheDocument()
    expect(await drawer.findByDisplayValue('蓝色旅行箱正面')).toBeInTheDocument()
    expect(drawer.getByText('Northstar US')).toBeInTheDocument()
    const name = drawer.getByRole('textbox', { name: '内容名称' })
    await userEvent.clear(name)
    await userEvent.type(name, '新的名称')
    const before = callsOf(app, '/aplus/c1').length
    await userEvent.click(drawer.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ version: 3, name: '新的名称', modules: formModules() })
    expect(await screen.findByText('已登记，稍后在写入记录里看结果')).toBeInTheDocument()
    expect(page.getByTestId('aplus-write-result')).toHaveTextContent('已登记')
    await waitFor(() => expect(callsOf(app, '/aplus/c1').length).toBeGreaterThan(before))
  })

  it('编辑时本地校验：清空名称提示，不发请求', async () => {
    const bodies: Body[] = []
    const { page } = await openDetail(undefined, { '/aplus/c1': detailOr('PATCH', bodies) })
    await userEvent.click(btn(page, EDIT))
    const drawer = within(await screen.findByRole('dialog'))
    await userEvent.clear(drawer.getByRole('textbox', { name: '内容名称' }))
    await userEvent.click(drawer.getByRole('button', { name: '保存修改' }))
    expect(await drawer.findByText('请填写内容名称')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
  })

  it('版本冲突（409 CONFLICT）：提示内容刚被改过，请刷新', async () => {
    const bodies: Body[] = []
    const { page } = await openDetail(undefined, {
      '/aplus/c1': detailOr('PATCH', bodies, { status: 409, body: { error: { code: 'CONFLICT', message: '对象已被他人修改（版本号不一致）', details: { currentVersion: 4, expectedVersion: 3 } } } }),
    })
    await userEvent.click(btn(page, EDIT))
    const drawer = within(await screen.findByRole('dialog'))
    await userEvent.click(drawer.getByRole('button', { name: '保存修改' }))
    expect(await drawer.findByTestId('aplus-editor-failure')).toHaveTextContent('内容刚被改过，请刷新页面看到最新版本后再操作')
  })

  it('审核中（已提交）：编辑、关联 ASIN、提交审核都禁用，原因写在页面上', async () => {
    const { page } = await openDetail(() => detailResponse({ item: aplusRow({ status: 'SUBMITTED' }) }))
    await page.findByTestId('aplus-header')
    expect(btn(page, EDIT)).toBeDisabled()
    expect(btn(page, '关联 ASIN')).toBeDisabled()
    expect(btn(page, '提交审核')).toBeDisabled()
    const notes = page.getByTestId('aplus-action-notes')
    expect(notes).toHaveTextContent('不能编辑：只有草稿和被拒的内容可以修改')
    expect(notes).toHaveTextContent('不能关联 ASIN：审核中不能修改关联的 ASIN')
    expect(notes).toHaveTextContent('不能提交审核：只有草稿和被拒的内容可以提交审核')
  })

  it('禁用的编辑按钮：悬停提示里写明原因', async () => {
    const { page } = await openDetail(() => detailResponse({ item: aplusRow({ status: 'PUBLISHED' }) }))
    await page.findByTestId('aplus-header')
    await userEvent.hover(btn(page, EDIT).closest('span') as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('只有草稿和被拒的内容可以修改')
  })
})

describe('A+ 内容详情：关联 ASIN', () => {
  const openAssociate = async (bodies: Body[] = [], result?: { status: number; body: unknown }) => {
    const opened = await openDetail(undefined, { '/aplus/c1/asins': detailOr('POST', bodies, result) })
    await userEvent.click(btn(opened.page, '关联 ASIN'))
    const modal = within(await screen.findByRole('dialog'))
    return { ...opened, modal, input: modal.getByRole('textbox', { name: 'ASIN 列表' }) }
  }

  it('本地校验：不是 10 位字母数字时逐个指出并禁用提交；多种分隔、大写、去重后提交 POST /asins（带版本）', async () => {
    const bodies: Body[] = []
    const { page, modal, input } = await openAssociate(bodies)
    expect(modal.getByRole('button', { name: '提交关联' })).toBeDisabled()
    await userEvent.type(input, 'b0abcde123 SHORT1')
    expect(await modal.findByText(/不是有效的 ASIN（要 10 位字母或数字）：SHORT1/)).toBeInTheDocument()
    expect(modal.getByRole('button', { name: '提交关联' })).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, 'b0abcde123, B0ABCDE124{Enter}b0abcde123')
    expect(await modal.findByTestId('aplus-asin-summary')).toHaveTextContent('将关联 2 个 ASIN（已去掉 1 个重复的）')
    await userEvent.click(modal.getByRole('button', { name: '提交关联' }))
    await waitFor(() => expect(bodies).toEqual([{ version: 3, asins: ['B0ABCDE123', 'B0ABCDE124'] }]))
    expect(await page.findByTestId('aplus-write-result')).toHaveTextContent('已登记，稍后在写入记录里看结果')
  })

  it('一次最多 50 个：超出时提示并禁用提交', async () => {
    const { modal, input } = await openAssociate()
    const many = Array.from({ length: 51 }, (_v, index) => `B0ABCD${String(index).padStart(4, '0')}`).join(' ')
    await userEvent.click(input)
    await userEvent.paste(many)
    expect(await modal.findByText(/一次最多关联 50 个 ASIN，现在有 51 个/)).toBeInTheDocument()
    expect(modal.getByRole('button', { name: '提交关联' })).toBeDisabled()
  })

  it('服务端拒绝：在弹窗里显示原因', async () => {
    const { modal, input } = await openAssociate([], { status: 422, body: { error: { code: 'VALIDATION_FAILED', message: 'ASIN 不在这个店铺的目录里' } } })
    await userEvent.type(input, 'B0ABCDE123')
    await userEvent.click(modal.getByRole('button', { name: '提交关联' }))
    expect(await modal.findByRole('alert')).toHaveTextContent('ASIN 不在这个店铺的目录里')
  })
})

describe('A+ 内容详情：提交审核', () => {
  it('二次确认：先弹窗说明审核期间不能修改，确认后才 POST /submit（带版本）；提示已登记', async () => {
    const bodies: Body[] = []
    const { page } = await openDetail(undefined, { '/aplus/c1/submit': detailOr('POST', bodies) })
    await userEvent.click(btn(page, '提交审核'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('提交后审核期间不能修改内容，也不能修改关联的 ASIN。')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.click(dialog.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(bodies).toEqual([{ version: 3 }]))
    expect(await page.findByTestId('aplus-write-result')).toHaveTextContent('已登记，稍后在写入记录里看结果')
  })

  it('取消确认：不发请求', async () => {
    const bodies: Body[] = []
    const { page } = await openDetail(undefined, { '/aplus/c1/submit': detailOr('POST', bodies) })
    await userEvent.click(btn(page, '提交审核'))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /取\s*消/ }))
    expect(bodies).toHaveLength(0)
  })

  it('没能入队（queued: false）：提示写入记录已标为失败，可以重新提交', async () => {
    const bodies: Body[] = []
    const { page } = await openDetail(undefined, { '/aplus/c1/submit': detailOr('POST', bodies, { status: 201, body: ok({ ...accepted, queued: false }).body }) })
    await userEvent.click(btn(page, '提交审核'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认提交' }))
    expect(await page.findByTestId('aplus-write-result')).toHaveTextContent('没能进入任务队列')
  })

  it('服务端拒绝：弹窗里显示原因，弹窗不关', async () => {
    const bodies: Body[] = []
    const { page } = await openDetail(undefined, {
      '/aplus/c1/submit': detailOr('POST', bodies, { status: 409, body: { error: { code: 'DATA_CONDITION_FAILED', message: '写入开关“A+ 内容提交”还没有打开' } } }),
    })
    await userEvent.click(btn(page, '提交审核'))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: '确认提交' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('写入开关“A+ 内容提交”还没有打开')
    expect(page.queryByTestId('aplus-write-result')).toBeNull()
  })

  it('没有关联 ASIN：提交审核禁用并写明至少关联一个', async () => {
    const { page } = await openDetail(() => detailResponse({ item: aplusRow({ asinCount: 0 }), asins: [] }))
    await page.findByTestId('aplus-header')
    expect(btn(page, '提交审核')).toBeDisabled()
    expect(page.getByTestId('aplus-action-notes')).toHaveTextContent('提交审核前至少要关联一个 ASIN')
  })
})

describe('A+ 内容详情：写入开关与权限', () => {
  it('写入开关关闭：所有写入按钮禁用，说明条写明原因并给处理入口，悬停提示也有原因', async () => {
    const { page } = await openDetail(() => detailResponse({ write: WRITE_OFF }))
    const notice = await page.findByTestId('aplus-write-notice')
    expect(notice).toHaveTextContent('写入开关“A+ 内容提交”未开启')
    expect(within(notice).getByRole('link', { name: '前往处理' }).getAttribute('href')).toMatch(/^\/app\/settings\/integrations(\?|$)/)
    for (const name of [EDIT, '提交审核', '关联 ASIN'] as Array<string | RegExp>) expect(btn(page, name)).toBeDisabled()
    await userEvent.hover(btn(page, '提交审核').closest('span') as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('写入开关“A+ 内容提交”未开启')
  })

  it('没有 aplus.write 权限：写入按钮禁用并写“无权限”', async () => {
    const { page } = await openDetail(undefined, {}, { ...defaultMe, permissions: ['aplus.read'] })
    expect(await page.findByTestId('aplus-write-notice')).toHaveTextContent('无权限')
    expect(btn(page, EDIT)).toBeDisabled()
    expect(btn(page, '关联 ASIN')).toBeDisabled()
  })
})

describe('A+ 内容详情：写入记录', () => {
  it('记录表：类型、状态、失败原因、警告、提交人、时间；没有进行中的写入时不显示刷新按钮', async () => {
    const { page } = await openDetail(() =>
      detailResponse({
        runs: [
          failedRun(),
          failedRun({ id: 'run-0', kind: 'UPDATE', kindLabel: '保存修改', status: 'SUCCEEDED', statusLabel: '已完成', failureCode: null, failureText: null, warnings: [], requestedBy: null }),
        ],
      }),
    )
    const runs = within(await page.findByTestId('aplus-runs'))
    const failed = runs.getByText('提交审核').closest('tr, [role=row]') as HTMLElement
    expect(failed).toHaveTextContent('失败')
    expect(failed).toHaveTextContent('亚马逊拒绝了这次请求（400）：内容或图片不符合要求')
    expect(failed).toHaveTextContent('图片 dest-large 的宽高比与要求略有差异')
    expect(failed).toHaveTextContent('林然')
    expect(failed).toHaveTextContent('2026-10-24 00:00 PDT')
    const done = runs.getByText('保存修改').closest('tr, [role=row]') as HTMLElement
    expect(done).toHaveTextContent('已完成')
    expect(done).toHaveTextContent('尚无记录')
    expect(runs.queryByRole('button', { name: REFRESH })).toBeNull()
  })

  it('没有写入记录：写“尚无记录”', async () => {
    const { page } = await openDetail()
    expect(await within(await page.findByTestId('aplus-runs')).findByText(/还没有写入过/)).toBeInTheDocument()
  })

  it('有进行中的写入：头部写“处理中·提交审核”，记录里有刷新按钮，点击重新读取详情', async () => {
    const { app, page } = await openDetail(() => runningDetail())
    const runs = within(await page.findByTestId('aplus-runs'))
    expect(within(page.getByTestId('aplus-header')).getByText('处理中·提交审核')).toBeInTheDocument()
    expect(runs.getByText(/有写入正在处理，每 5 秒自动刷新一次/)).toBeInTheDocument()
    const before = callsOf(app, '/aplus/c1').length
    await userEvent.click(runs.getByRole('button', { name: REFRESH }))
    await waitFor(() => expect(callsOf(app, '/aplus/c1').length).toBeGreaterThan(before))
  })

  it('自动轮询：5 秒后重新读取；写入结束后不再读取', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true })
    let finished = false
    const { app, page } = await openDetail(() => (finished ? detailResponse() : runningDetail()))
    await within(await page.findByTestId('aplus-runs')).findByText(/有写入正在处理/)
    const count = () => callsOf(app, '/aplus/c1').length
    const first = count()
    await vi.advanceTimersByTimeAsync(5100)
    await waitFor(() => expect(count()).toBeGreaterThan(first))
    finished = true
    await vi.advanceTimersByTimeAsync(5100)
    await waitFor(() => expect(within(page.getByTestId('aplus-runs')).queryByText(/有写入正在处理/)).toBeNull())
    const settled = count()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(count()).toBe(settled)
  })
})
