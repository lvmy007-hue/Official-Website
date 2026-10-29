import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AplusListResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import { aplusHandlers, aplusPages, aplusRow, callsOf, lastParams, listResponse, WRITE_OFF } from './aplus-fixtures.test-helper'

// A+ 内容列表（P4-14）：汇总、表格列、服务端筛选与排序、游标分页、没接入与尚无记录、写入入口的禁用与原因。

afterEach(() => vi.unstubAllGlobals())

const openList = async (response: () => AplusListResponse = () => listResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url: '/app/aplus', pages: aplusPages, me, handlers: aplusHandlers({ list: response }, extra) })
  const page = within(await screen.findByTestId('aplus-page', {}, { timeout: 15_000 }))
  return { app, page }
}
const rowOf = (page: ReturnType<typeof within>, text: string) => page.getByText(text).closest('tr, [role=row]') as HTMLElement
const pick = async (page: ReturnType<typeof within>, name: string, title: string) => {
  await userEvent.click(page.getByRole('combobox', { name }))
  await userEvent.click(await screen.findByTitle(title))
}

describe('A+ 内容列表', () => {
  it('顶部汇总：总数与各状态数量，数量为零的状态写“无”，进行中写入数；请求默认按最近更新倒序', async () => {
    const { app, page } = await openList()
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    const summary = page.getByTestId('aplus-summary')
    expect(summary).toHaveTextContent('共 4 份')
    expect(summary).toHaveTextContent('草稿 2')
    expect(summary).toHaveTextContent('已提交 无')
    expect(summary).toHaveTextContent('被拒 1')
    expect(summary).toHaveTextContent('已发布 1')
    expect(summary).toHaveTextContent('进行中写入 1')
    expect(summary).not.toHaveTextContent(/(^|\s)0(\s|$)/)
    expect(lastParams(app, '/aplus').get('sort')).toBe('updatedAt:desc')
    expect(lastParams(app, '/aplus').get('pageSize')).toBe('50')
  })

  it('表格列：名称与店铺、类型、状态（被拒用红色并写原因）、关联 ASIN 数（没有写“未关联”）、最近更新、进行中写入、查看链接', async () => {
    const { page } = await openList()
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    const first = rowOf(page, '旅行箱品牌故事')
    expect(first).toHaveTextContent('Northstar US')
    expect(first).toHaveTextContent('标准 A+ 内容')
    expect(first).toHaveTextContent('草稿')
    expect(first).toHaveTextContent('2026-10-24')
    expect(first).toHaveTextContent('无')
    expect(within(first).getByRole('link', { name: '查看' }).getAttribute('href')).toMatch(/^\/app\/aplus\/c1(\?|$)/)

    const rejected = rowOf(page, '收纳袋卖点')
    expect(rejected).toHaveTextContent('被拒原因：The image shows a price and a promotion.')
    expect(within(rejected).getByText('被拒').closest('.ant-tag')).toHaveClass('ant-tag-red')

    const pending = rowOf(page, '新品草稿')
    expect(pending).toHaveTextContent('排队中·提交审核')
    expect(pending).toHaveTextContent('未关联')
    expect(rowOf(page, '行李箱对比图')).toHaveTextContent('3')
  })

  it('被拒但亚马逊没返回原文：写明没有返回拒绝原因', async () => {
    const { page } = await openList(() => listResponse({ items: [aplusRow({ id: 'c9', name: '无原文被拒', status: 'REJECTED', rejectionReason: null })] }))
    expect(await page.findByText(/亚马逊没有返回拒绝原因/)).toBeInTheDocument()
  })

  it('筛选：店铺、状态、名称关键字、ASIN 都带到请求里（ASIN 转大写）；筛选后回到第一页', async () => {
    const { app, page } = await openList()
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    await pick(page, '内容店铺', 'Northstar US')
    await waitFor(() => expect(lastParams(app, '/aplus').get('storeId')).toBe('st1'))
    await pick(page, '内容状态', '被拒')
    await waitFor(() => expect(lastParams(app, '/aplus').get('status')).toBe('REJECTED'))
    await userEvent.type(page.getByRole('searchbox', { name: '搜索名称' }), '收纳{Enter}')
    await waitFor(() => expect(lastParams(app, '/aplus').get('q')).toBe('收纳'))
    await userEvent.type(page.getByRole('searchbox', { name: '按 ASIN 筛选' }), 'b0aplus001{Enter}')
    await waitFor(() => expect(lastParams(app, '/aplus').get('asin')).toBe('B0APLUS001'))
    expect(lastParams(app, '/aplus').get('cursor')).toBeNull()
  })

  it('ASIN 筛选不是 10 位字母数字：本地提示，不发请求', async () => {
    const { app, page } = await openList()
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    const before = callsOf(app, '/aplus').length
    await userEvent.type(page.getByRole('searchbox', { name: '按 ASIN 筛选' }), 'B0SHORT{Enter}')
    expect(await page.findByRole('alert')).toHaveTextContent('ASIN 是 10 位字母或数字')
    expect(callsOf(app, '/aplus')).toHaveLength(before)
  })

  it('服务端排序：换字段与方向都重新请求，格式是 字段:方向', async () => {
    const { app, page } = await openList()
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    await pick(page, '排序字段', '按关联 ASIN 数排序')
    await waitFor(() => expect(lastParams(app, '/aplus').get('sort')).toBe('asinCount:desc'))
    await userEvent.click(page.getByRole('button', { name: '排序方向' }))
    await waitFor(() => expect(lastParams(app, '/aplus').get('sort')).toBe('asinCount:asc'))
  })

  it('游标分页：下一页带游标，页码是栈深度，上一页回到第一页', async () => {
    const { app, page } = await openList(() => listResponse({ pageInfo: { pageSize: 50, nextCursor: 'cur-2', hasMore: true, approxTotal: 5 } }), {
      '/aplus': url =>
        url.searchParams.get('cursor') === 'cur-2'
          ? { body: { success: true, data: listResponse({ items: [aplusRow({ id: 'c5', name: '第二页内容' })], pageInfo: { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: 5 } }) } }
          : { body: { success: true, data: listResponse({ pageInfo: { pageSize: 50, nextCursor: 'cur-2', hasMore: true, approxTotal: 5 } }) } },
    })
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    expect(page.getByRole('button', { name: '上一页' })).toBeDisabled()
    await userEvent.click(page.getByRole('button', { name: '下一页' }))
    expect(await page.findByText('第二页内容')).toBeInTheDocument()
    expect(lastParams(app, '/aplus').get('cursor')).toBe('cur-2')
    expect(page.getByText(/第 2 页/)).toBeInTheDocument()
    expect(page.getByRole('button', { name: '下一页' })).toBeDisabled()
    await userEvent.click(page.getByRole('button', { name: '上一页' }))
    expect(await page.findByText('旅行箱品牌故事')).toBeInTheDocument()
    expect(page.getByText(/第 1 页/)).toBeInTheDocument()
  })

  it('尚未接入：写“尚未接入”与原因，并给处理入口链接；不显示汇总', async () => {
    const { page } = await openList(() =>
      listResponse({
        state: 'NOT_CONNECTED',
        note: '还没有同步过 A+ 内容',
        items: [],
        stores: [],
        summary: { total: 0, byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, PUBLISHED: 0 }, pending: 0 },
        write: { allowed: false, step: 'CONNECTION', reason: '店铺还没有连接亚马逊', remedyPath: '/app/connections' },
      }),
    )
    const note = await page.findByTestId('aplus-section-note')
    expect(note).toHaveTextContent('尚未接入')
    expect(note).toHaveTextContent('还没有同步过 A+ 内容')
    expect(within(note).getByRole('link', { name: '前往处理' }).getAttribute('href')).toMatch(/^\/app\/connections(\?|$)/)
    expect(page.queryByTestId('aplus-summary')).toBeNull()
    expect(page.getByRole('button', { name: /新建 A\+ 内容/ })).toBeDisabled()
  })

  it('没有任何内容（NO_DATA）：汇总写“尚无记录”，不写 0，表格写前置条件', async () => {
    const { page } = await openList(() =>
      listResponse({ state: 'NO_DATA', note: null, items: [], summary: { total: 0, byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, PUBLISHED: 0 }, pending: 0 } }),
    )
    const summary = await page.findByTestId('aplus-summary')
    expect(summary).toHaveTextContent('尚无记录')
    expect(summary).not.toHaveTextContent('0')
    expect((await page.findAllByText(/还没有 A\+ 内容/)).length).toBeGreaterThan(0)
  })

  it('筛选后没有结果：提示放宽条件，而不是“还没有内容”', async () => {
    const { page } = await openList(undefined, {
      '/aplus': url => ({ body: { success: true, data: url.searchParams.get('q') ? listResponse({ items: [] }) : listResponse() } }),
    })
    await page.findByText('旅行箱品牌故事', {}, { timeout: 15_000 })
    await userEvent.type(page.getByRole('searchbox', { name: '搜索名称' }), '不存在{Enter}')
    expect(await page.findByText(/没有符合条件的内容/)).toBeInTheDocument()
  })

  it('写入开关关闭：新建按钮禁用，说明条写明原因并给处理入口', async () => {
    const { page } = await openList(() => listResponse({ write: WRITE_OFF }))
    const notice = await page.findByTestId('aplus-write-notice')
    expect(notice).toHaveTextContent('写入开关“A+ 内容提交”未开启')
    expect(within(notice).getByRole('link', { name: '前往处理' }).getAttribute('href')).toMatch(/^\/app\/settings\/integrations(\?|$)/)
    expect(page.getByRole('button', { name: /新建 A\+ 内容/ })).toBeDisabled()
  })

  it('没有 aplus.write 权限：新建禁用并写“无权限”', async () => {
    const { page } = await openList(undefined, {}, { ...defaultMe, permissions: ['aplus.read'] })
    expect(await page.findByTestId('aplus-write-notice')).toHaveTextContent('无权限')
    expect(page.getByRole('button', { name: /新建 A\+ 内容/ })).toBeDisabled()
  })

  it('截断提示、新鲜度与折叠的数据口径说明', async () => {
    const { page } = await openList(() => listResponse({ truncated: true }))
    expect(await page.findByText(/只统计并显示了最近更新的一部分/)).toBeInTheDocument()
    expect(page.getByTestId('freshness-bar')).toHaveTextContent('最近成功同步')
    expect(page.queryByText(/每日同步一次，需要品牌备案/)).toBeNull()
    await userEvent.click(page.getByText('数据口径说明'))
    expect(await page.findByText(/每日同步一次，需要品牌备案/)).toBeInTheDocument()
  })
})
