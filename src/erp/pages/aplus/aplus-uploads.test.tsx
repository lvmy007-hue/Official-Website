import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import { aplusHandlers, aplusPages, callsOf, ok, uploadsResponse, WRITE_OFF } from './aplus-fixtures.test-helper'

// A+ 内容的图片库（P4-14）：上传列表、本地校验（类型与大小）、三步流程的调用顺序与每一步的失败提示、刷新。

afterEach(() => vi.unstubAllGlobals())

const ticket = {
  uploadUrl: 'https://storage.test/put/abc',
  method: 'PUT',
  headers: { 'content-type': 'image/png' },
  objectKey: 'aplus/k1',
  expiresAt: '2026-10-25T00:30:00Z',
  maxBytes: 5 * 1024 * 1024,
}
const confirmed = { contentId: null, runId: 'run-9', status: 'QUEUED', version: null, queued: true, width: 1200, height: 800 }

interface Flow {
  order: string[]
  ticketBody?: Record<string, unknown>
  putInit?: RequestInit
  confirmBody?: Record<string, unknown>
}

/** 三步流程的假服务端：记录调用顺序，各步骤可以指定失败。 */
function flowHandlers(flow: Flow, fail: Partial<Record<'ticket' | 'put' | 'confirm', { status: number; body: unknown }>> = {}, queued = true): Record<string, Handler> {
  return {
    '/aplus/uploads': (_url, init) => {
      if (init?.method !== 'POST') return ok(uploadsResponse())
      flow.order.push('ticket')
      flow.ticketBody = JSON.parse(String(init.body))
      return fail.ticket ?? { status: 201, body: ok(ticket).body }
    },
    '/put/abc': (_url, init) => {
      flow.order.push('put')
      flow.putInit = init
      return fail.put ?? { status: 200, body: {} }
    },
    '/aplus/uploads/confirm': (_url, init) => {
      flow.order.push('confirm')
      flow.confirmBody = JSON.parse(String(init?.body))
      return fail.confirm ?? { status: 201, body: ok({ ...confirmed, queued }).body }
    },
  }
}

const openUploads = async (extra: Record<string, Handler> = {}, uploads = () => uploadsResponse()) => {
  const app = mountApp({ url: '/app/aplus', pages: aplusPages, me: defaultMe, handlers: aplusHandlers({ uploads }, extra) })
  const page = within(await screen.findByTestId('aplus-page', {}, { timeout: 15_000 }))
  await userEvent.click(await page.findByRole('tab', { name: '图片库' }))
  const panel = within(await page.findByTestId('aplus-uploads'))
  await panel.findByText('banner-large.png', {}, { timeout: 15_000 })
  return { app, panel }
}
const png = (name = 'new.png', size = 100 * 1024) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const choose = (panel: ReturnType<typeof within>, file: File) => userEvent.setup({ applyAccept: false }).upload(panel.getByLabelText('选择图片文件'), file)

describe('A+ 图片库：列表', () => {
  it('列出上传：文件名、尺寸、大小、状态、失败原因（失败才有）、时间', async () => {
    const { panel } = await openUploads()
    const large = panel.getByText('banner-large.png').closest('tr, [role=row]') as HTMLElement
    expect(large).toHaveTextContent('1200×800')
    expect(large).toHaveTextContent('2.00 MB')
    expect(large).toHaveTextContent('已完成')
    expect(large).toHaveTextContent('2026-10-23')
    expect(panel.getByText('icon-small.png').closest('tr, [role=row]')).toHaveTextContent('40.0 KB')
    expect(panel.getByText('pending.jpg').closest('tr, [role=row]')).toHaveTextContent('处理中')
    const failed = panel.getByText('broken.jpg').closest('tr, [role=row]') as HTMLElement
    expect(failed).toHaveTextContent('失败')
    expect(failed).toHaveTextContent('亚马逊拒绝了这次请求（400）：图片不符合要求')
    expect(large).toHaveTextContent('尚无记录')
  })

  it('有处理中的图片：提示自动刷新；“刷新”重新读取', async () => {
    const { app, panel } = await openUploads()
    expect(panel.getByText(/有图片正在处理，每 5 秒自动刷新一次/)).toBeInTheDocument()
    const before = callsOf(app, '/aplus/uploads').length
    await userEvent.click(panel.getByRole('button', { name: /刷\s*新/ }))
    await waitFor(() => expect(callsOf(app, '/aplus/uploads').length).toBeGreaterThan(before))
  })

  it('没有上传记录：写“尚无记录”', async () => {
    mountApp({ url: '/app/aplus', pages: aplusPages, handlers: aplusHandlers({ uploads: () => uploadsResponse({ items: [] }) }) })
    const page = within(await screen.findByTestId('aplus-page', {}, { timeout: 15_000 }))
    await userEvent.click(await page.findByRole('tab', { name: '图片库' }))
    expect(await page.findByText(/还没有上传过图片/)).toBeInTheDocument()
  })

  it('写入开关关闭：上传按钮禁用，说明条写明原因', async () => {
    const { panel } = await openUploads({}, () => uploadsResponse({ write: WRITE_OFF }))
    expect(await panel.findByTestId('aplus-write-notice')).toHaveTextContent('写入开关“A+ 内容提交”未开启')
    expect(panel.getByRole('button', { name: /上传图片/ })).toBeDisabled()
  })

  it('有多个店铺：先选店铺才能上传，选了以后按钮可用', async () => {
    const stores = [
      { id: 'st1', name: 'Northstar US' },
      { id: 'st2', name: 'Oak & Pine' },
    ]
    const { panel } = await openUploads({}, () => uploadsResponse({ stores }))
    expect(panel.getByText('要上传图片，请先选择店铺')).toBeInTheDocument()
    expect(panel.getByRole('button', { name: /上传图片/ })).toBeDisabled()
    await userEvent.click(panel.getByRole('combobox', { name: '图片库店铺' }))
    await userEvent.click(await screen.findByTitle('Oak & Pine'))
    await waitFor(() => expect(panel.getByRole('button', { name: /上传图片/ })).toBeEnabled())
  })
})

describe('A+ 图片库：上传', () => {
  it('三步按顺序：申请票据 → PUT 直传文件 → 确认登记；请求体正确，提示“已登记”', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow))
    const file = png('hero.png', 120 * 1024)
    await choose(panel, file)
    const feedback = await panel.findByTestId('aplus-upload-feedback')
    expect(feedback).toHaveTextContent('已登记，稍后在写入记录里看结果')
    expect(feedback).toHaveTextContent('hero.png')
    expect(flow.order).toEqual(['ticket', 'put', 'confirm'])
    expect(flow.ticketBody).toEqual({ storeId: 'st1', fileName: 'hero.png', contentType: 'image/png', sizeBytes: 120 * 1024 })
    expect(flow.putInit?.method).toBe('PUT')
    expect(flow.putInit?.body).toBe(file)
    expect(flow.putInit?.headers).toEqual({ 'content-type': 'image/png' })
    expect(flow.confirmBody).toEqual({ storeId: 'st1', objectKey: 'aplus/k1', fileName: 'hero.png', contentType: 'image/png' })
  })

  it('类型不对（GIF）：本地拒绝，三步一个都不调用', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow))
    await choose(panel, new File([new Uint8Array(1024)], 'anim.gif', { type: 'image/gif' }))
    expect(await panel.findByTestId('aplus-upload-feedback')).toHaveTextContent('“anim.gif”不是 JPG 或 PNG 图片，不能上传')
    expect(flow.order).toEqual([])
  })

  it('超过 5 MB：本地拒绝并写明大小与上限，三步一个都不调用', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow))
    await choose(panel, png('big.png', 5 * 1024 * 1024 + 1))
    const feedback = await panel.findByTestId('aplus-upload-feedback')
    expect(feedback).toHaveTextContent('“big.png”有 5.00 MB，超过 5.00 MB 的上限')
    expect(flow.order).toEqual([])
  })

  it('第 1 步失败（申请票据被拒）：写明是哪一步，后面两步不执行', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow, { ticket: { status: 409, body: { error: { code: 'DATA_CONDITION_FAILED', message: '写入开关“A+ 内容提交”还没有打开' } } } }))
    await choose(panel, png())
    expect(await panel.findByTestId('aplus-upload-feedback')).toHaveTextContent('申请上传凭据失败：写入开关“A+ 内容提交”还没有打开')
    expect(flow.order).toEqual(['ticket'])
  })

  it('第 2 步失败（存储返回 500）：提示图片没能传到存储，不确认登记', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow, { put: { status: 500, body: {} } }))
    await choose(panel, png())
    expect(await panel.findByTestId('aplus-upload-feedback')).toHaveTextContent('图片没能传到存储：存储返回 500，请重新上传')
    expect(flow.order).toEqual(['ticket', 'put'])
  })

  it('第 3 步失败（确认被拒）：提示已传到存储但确认登记失败', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow, { confirm: { status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '图片文件不在存储里' } } } }))
    await choose(panel, png())
    expect(await panel.findByTestId('aplus-upload-feedback')).toHaveTextContent('图片已传到存储，但确认登记失败：图片文件不在存储里')
    expect(flow.order).toEqual(['ticket', 'put', 'confirm'])
  })

  it('没能入队（queued: false）：提示上传记录已标为失败，请重新上传', async () => {
    const flow: Flow = { order: [] }
    const { panel } = await openUploads(flowHandlers(flow, {}, false))
    await choose(panel, png('late.png'))
    expect(await panel.findByTestId('aplus-upload-feedback')).toHaveTextContent('“late.png”已传到存储，但没能进入任务队列，上传记录已标为失败，请重新上传')
  })
})
