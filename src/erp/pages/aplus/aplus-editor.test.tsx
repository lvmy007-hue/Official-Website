import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import { aplusHandlers, aplusPages, listResponse, ok, WRITE_OK } from './aplus-fixtures.test-helper'

// A+ 内容的结构化编辑器（新建，P4-14）：添加、删除、上下移模块，模块表单与字数提示，图片选项尺寸检查，本地校验逐条显示，提交请求体与结果提示。

afterEach(() => vi.unstubAllGlobals())

type Body = Record<string, unknown>
const created = { contentId: 'c1', runId: 'run-1', status: 'QUEUED', version: 1, queued: true }

/** GET /aplus 返回列表；POST /aplus 记录请求体并返回受理结果。 */
const listOrCreate =
  (bodies: Body[], result: object | { status: number; body: unknown } = created): Handler =>
  (url, init) => {
    if (init?.method !== 'POST') return ok(listResponse())
    bodies.push(JSON.parse(String(init.body)))
    return 'body' in result ? (result as { status: number; body: unknown }) : { status: 201, body: ok(result).body }
  }

const openEditor = async (extra: Record<string, Handler> = {}, write = WRITE_OK) => {
  const app = mountApp({ url: '/app/aplus', pages: aplusPages, me: defaultMe, handlers: aplusHandlers({ list: () => listResponse({ write }) }, extra) })
  const page = within(await screen.findByTestId('aplus-page', {}, { timeout: 15_000 }))
  await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
  await userEvent.click(page.getByRole('button', { name: /新建 A\+ 内容/ }))
  const drawer = within(await screen.findByRole('dialog'))
  return { app, drawer }
}
const pickType = async (drawer: ReturnType<typeof within>, title: string) => {
  await userEvent.click(drawer.getByRole('combobox', { name: '模块类型' }))
  await userEvent.click(await screen.findByTitle(title))
  await userEvent.click(drawer.getByRole('button', { name: '添加模块' }))
}
const HEADER = '大图文：总标题，加一张大图与图下的标题和正文'
const DESC = '商品描述：一段商品描述正文'

describe('A+ 内容编辑器：模块', () => {
  it('添加模块：默认类型是纯文字；每种模块有自己的表单；字数提示随输入变化', async () => {
    const { drawer } = await openEditor()
    expect(drawer.getByText('已添加 0/5 个模块', { exact: false })).toBeInTheDocument()
    await userEvent.click(drawer.getByRole('button', { name: '添加模块' }))
    const first = within(await drawer.findByTestId('aplus-module-1'))
    expect(first.getByText(/模块 1 · 纯文字/)).toBeInTheDocument()
    await userEvent.type(first.getByRole('textbox', { name: '模块 1 标题' }), '品牌故事')
    expect(first.getByText('4/160')).toBeInTheDocument()
    await pickType(drawer, HEADER)
    const second = within(drawer.getByTestId('aplus-module-2'))
    expect(second.getByRole('textbox', { name: '模块 2 总标题' })).toBeInTheDocument()
    expect(second.getByRole('textbox', { name: '模块 2 大图正文' })).toBeInTheDocument()
    expect(second.getByText(/至少 970×600 像素/)).toBeInTheDocument()
    await pickType(drawer, DESC)
    expect(within(drawer.getByTestId('aplus-module-3')).getByRole('textbox', { name: '模块 3 正文' })).toBeInTheDocument()
    expect(drawer.getByText('已添加 3/5 个模块', { exact: false })).toBeInTheDocument()
  })

  it('最多 5 个模块：到上限后“添加模块”禁用', async () => {
    const { drawer } = await openEditor()
    for (let i = 0; i < 5; i += 1) await userEvent.click(drawer.getByRole('button', { name: '添加模块' }))
    expect(drawer.getByRole('button', { name: '添加模块' })).toBeDisabled()
    await userEvent.click(drawer.getByRole('button', { name: '模块 5 删除' }))
    expect(drawer.getByRole('button', { name: '添加模块' })).toBeEnabled()
  })

  it('上移、下移、删除：顺序跟着变，首尾的按钮禁用', async () => {
    const { drawer } = await openEditor()
    await userEvent.click(drawer.getByRole('button', { name: '添加模块' }))
    await pickType(drawer, DESC)
    const titles = () => drawer.getAllByTestId(/^aplus-module-\d$/).map(node => node.querySelector('.ant-card-head-title')?.textContent ?? '')
    expect(titles()[0]).toContain('纯文字')
    expect(titles()[1]).toContain('商品描述')
    expect(drawer.getByRole('button', { name: '模块 1 上移' })).toBeDisabled()
    expect(drawer.getByRole('button', { name: '模块 2 下移' })).toBeDisabled()
    await userEvent.click(drawer.getByRole('button', { name: '模块 2 上移' }))
    expect(titles()[0]).toContain('商品描述')
    expect(titles()[1]).toContain('纯文字')
    await userEvent.click(drawer.getByRole('button', { name: '模块 1 删除' }))
    expect(titles()).toHaveLength(1)
    expect(titles()[0]).toContain('纯文字')
  })

  it('图片模块：只列出该店铺已上传成功的图；尺寸不够与没成功的选项禁用并写原因；选好后填替代文字', async () => {
    const { drawer } = await openEditor()
    await pickType(drawer, HEADER)
    await userEvent.click(drawer.getByRole('combobox', { name: '模块 1 大图' }))
    const large = await screen.findByText(/banner-large\.png（1200×800）/)
    expect(large.closest('.ant-select-item-option')).not.toHaveClass('ant-select-item-option-disabled')
    const small = screen.getByText(/icon-small\.png（200×200）——尺寸不够：至少需要 970×600，这张只有 200×200/)
    expect(small.closest('.ant-select-item-option')).toHaveClass('ant-select-item-option-disabled')
    expect(screen.getByText(/pending\.jpg.*还没有上传成功/).closest('.ant-select-item-option')).toHaveClass('ant-select-item-option-disabled')
    expect(screen.getByText(/broken\.jpg.*还没有上传成功/).closest('.ant-select-item-option')).toHaveClass('ant-select-item-option-disabled')
    await userEvent.click(large)
    await userEvent.type(await drawer.findByRole('textbox', { name: '模块 1 大图替代文字' }), '蓝色旅行箱')
    expect(drawer.getByText('5/100')).toBeInTheDocument()
  })
})

describe('A+ 内容编辑器：提交', () => {
  it('本地校验：什么都没填时逐条显示问题，不发请求', async () => {
    const bodies: Body[] = []
    const { drawer } = await openEditor({ '/aplus': listOrCreate(bodies) })
    await pickType(drawer, DESC)
    await pickType(drawer, HEADER)
    await userEvent.click(drawer.getByRole('button', { name: '创建内容' }))
    const issues = within(await drawer.findByTestId('aplus-editor-issues'))
    expect(issues.getByText('请填写内容名称')).toBeInTheDocument()
    expect(issues.getByText('第 1 个模块（商品描述）的正文不能为空')).toBeInTheDocument()
    expect(issues.getByText('第 2 个模块（大图文）还没有选择图片')).toBeInTheDocument()
    expect(drawer.getByText('还有 3 个问题要先改正')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
  })

  it('没有模块时提示至少添加一个；名称超过 100 个字符时提示', async () => {
    const { drawer } = await openEditor()
    await userEvent.click(drawer.getByRole('button', { name: '创建内容' }))
    expect(await drawer.findByText('至少添加一个模块')).toBeInTheDocument()
    await userEvent.type(drawer.getByRole('textbox', { name: '内容名称' }), 'x'.repeat(101))
    expect(drawer.getByText('101/100')).toBeInTheDocument()
    await userEvent.click(drawer.getByRole('button', { name: '创建内容' }))
    expect(await drawer.findByText(/名称不能超过 100 个字符/)).toBeInTheDocument()
  })

  it('提交：请求体是店铺、名称、语言、类型与表单模块；成功提示“已登记”并跳到详情页', async () => {
    const bodies: Body[] = []
    const { app, drawer } = await openEditor({ '/aplus': listOrCreate(bodies) })
    await userEvent.type(drawer.getByRole('textbox', { name: '内容名称' }), '  旅行箱品牌故事  ')
    await userEvent.click(drawer.getByRole('button', { name: '添加模块' }))
    await userEvent.type(drawer.getByRole('textbox', { name: '模块 1 标题' }), '品牌故事')
    await userEvent.type(drawer.getByRole('textbox', { name: '模块 1 正文' }), '我们做旅行箱。')
    await pickType(drawer, HEADER)
    await userEvent.click(drawer.getByRole('combobox', { name: '模块 2 大图' }))
    await userEvent.click(await screen.findByText(/banner-large\.png/))
    await userEvent.type(await drawer.findByRole('textbox', { name: '模块 2 大图替代文字' }), '蓝色旅行箱')
    await userEvent.click(drawer.getByRole('button', { name: '创建内容' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      storeId: 'st1',
      name: '旅行箱品牌故事',
      locale: 'en-US',
      contentType: 'EBC',
      modules: [
        { type: 'STANDARD_TEXT', headline: '品牌故事', body: '我们做旅行箱。' },
        { type: 'STANDARD_HEADER_IMAGE_TEXT', headline: '', block: { image: { uploadDestinationId: 'dest-large', altText: '蓝色旅行箱' }, headline: '', body: '' } },
      ],
    })
    expect(await screen.findByText('已登记，稍后在写入记录里看结果')).toBeInTheDocument()
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/aplus/c1'))
    expect(await screen.findByTestId('aplus-detail-page', {}, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('没能入队（queued: false）：提示写入记录已标为失败，可以重新提交', async () => {
    const bodies: Body[] = []
    const { drawer } = await openEditor({ '/aplus': listOrCreate(bodies, { ...created, queued: false }) })
    await userEvent.type(drawer.getByRole('textbox', { name: '内容名称' }), '草稿')
    await pickType(drawer, DESC)
    await userEvent.type(drawer.getByRole('textbox', { name: '模块 1 正文' }), '一段描述')
    await userEvent.click(drawer.getByRole('button', { name: '创建内容' }))
    expect(await screen.findByText(/没能进入任务队列，写入记录里已标为失败/)).toBeInTheDocument()
  })

  it('服务端拒绝（开关关闭、版本冲突等）：在抽屉里显示原因，抽屉不关', async () => {
    const bodies: Body[] = []
    const { drawer } = await openEditor({ '/aplus': listOrCreate(bodies, { status: 409, body: { error: { code: 'DATA_CONDITION_FAILED', message: '写入开关“A+ 内容提交”还没有打开' } } }) })
    await userEvent.type(drawer.getByRole('textbox', { name: '内容名称' }), '草稿')
    await pickType(drawer, DESC)
    await userEvent.type(drawer.getByRole('textbox', { name: '模块 1 正文' }), '一段描述')
    await userEvent.click(drawer.getByRole('button', { name: '创建内容' }))
    expect(await drawer.findByTestId('aplus-editor-failure')).toHaveTextContent('写入开关“A+ 内容提交”还没有打开')
    expect(bodies).toHaveLength(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
