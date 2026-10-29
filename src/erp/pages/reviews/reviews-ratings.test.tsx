import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import { callsOf, lastParams, ok, ratingsResponse, reviewsHandlers, reviewsPages } from './reviews-fixtures.test-helper'

// 评价与反馈：评分概况页签（P4-13）。汇总卡、来源与变化、星级分布、筛选翻页、评分文件导入（成功、服务端与本地逐行错误、无权限禁用）。
// 没有数据写“尚无记录”，来源没接上写“尚未接入”，不写 0。

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const open = async (response = () => ratingsResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url: '/app/reviews', pages: reviewsPages, me, handlers: reviewsHandlers({ ratings: response }, extra) })
  const page = within(await screen.findByTestId('ratings-panel', {}, { timeout: 15_000 }))
  return { app, page }
}
const rowOf = async (page: ReturnType<typeof within>, text: string) => (await page.findByText(text, {}, { timeout: 15_000 })).closest('tr, [role=row]') as HTMLElement

describe('评价与反馈：评分概况', () => {
  it('汇总卡：目录商品数、已有评分数、最近采集日期、最低星级与低于 4 星的数量', async () => {
    const { page } = await open()
    await rowOf(page, '旅行箱 24 寸')
    const summary = page.getByTestId('ratings-summary')
    expect(summary).toHaveTextContent('目录商品数 12')
    expect(summary).toHaveTextContent('已有评分的商品 2')
    expect(summary).toHaveTextContent('另有 10 个商品尚无评分记录')
    expect(summary).toHaveTextContent('最近采集日期 2026-10-24')
    expect(summary).toHaveTextContent('最低星级 3.80')
    expect(summary).toHaveTextContent('低于 4 星的商品 1')
  })

  it('评分行：星级、评分数、较上次变化带正负号、采集日期、来源（文件导入 · 文件名 · 导入人）与最近趋势', async () => {
    const { page } = await open()
    const row = await rowOf(page, '旅行箱 24 寸')
    expect(row).toHaveTextContent('B0RATE0001')
    expect(row).toHaveTextContent('4.30')
    expect(row).toHaveTextContent('1,280')
    expect(row).toHaveTextContent('星级 -0.10')
    expect(row).toHaveTextContent('评分数 +25')
    expect(row).toHaveTextContent('2026-10-24')
    expect(row).toHaveTextContent('文件导入 · ratings-1024.csv · 林然')
    expect(row).toHaveTextContent('4.40 → 4.30')
  })

  it('只有一次采集、缺评分数、没有导入人：写“只有一次采集”“尚无记录”“导入人尚无记录”，不写 0', async () => {
    const { page } = await open()
    const row = await rowOf(page, '收纳袋')
    expect(row).toHaveTextContent('只有一次采集')
    expect(row).toHaveTextContent('导入人尚无记录')
    expect(within(row).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(1)
    expect(row).toHaveTextContent('3.80')
    expect(within(row).queryByText('0')).toBeNull()
  })

  it('点评分行展开星级分布；没有导入分布写“未导入星级分布”', async () => {
    const { page } = await open()
    await userEvent.click(await rowOf(page, '旅行箱 24 寸'))
    const bars = await screen.findByTestId('rating-distribution')
    expect(bars).toHaveTextContent('5 星')
    expect(bars).toHaveTextContent(/880 人（68\.8%）/)
    expect(bars).toHaveTextContent('1 星')
    await userEvent.click(await rowOf(page, '收纳袋'))
    expect(await screen.findByText('未导入星级分布')).toBeInTheDocument()
  })

  it('没有任何评分：汇总写“尚无记录”，表格写前置条件，不写 0', async () => {
    const { page } = await open(() =>
      ratingsResponse({
        state: 'NO_DATA',
        note: '还没有导入过评分文件',
        items: [],
        summary: { catalogAsins: 0, withRating: 0, latestCapture: null, lowestRating: null, below4: null },
      }),
    )
    const summary = await page.findByTestId('ratings-summary')
    expect(summary).toHaveTextContent('目录商品数 尚无记录')
    expect(summary).toHaveTextContent('已有评分的商品 尚无记录')
    expect(summary).toHaveTextContent('最近采集日期 尚无记录')
    expect(summary).toHaveTextContent('最低星级 尚无记录')
    expect(summary).toHaveTextContent('低于 4 星的商品 尚无记录')
    expect((await page.findAllByText(/还没有导入过评分文件/)).length).toBeGreaterThan(0)
  })

  it('来源没接上：写“尚未接入”与原因', async () => {
    const { page } = await open(() =>
      ratingsResponse({
        state: 'NOT_CONNECTED',
        note: '还没有接入亚马逊店铺',
        items: [],
        stores: [],
        summary: { catalogAsins: 0, withRating: 0, latestCapture: null, lowestRating: null, below4: null },
      }),
    )
    expect((await page.findAllByText('尚未接入')).length).toBeGreaterThan(0)
    expect((await page.findAllByText(/还没有接入亚马逊店铺/)).length).toBeGreaterThan(0)
  })

  it('筛选、排序随请求带出，换条件回到第一页', async () => {
    const { app, page } = await open()
    await rowOf(page, '旅行箱 24 寸')
    await userEvent.click(page.getByRole('button', { name: '排序方向' }))
    await waitFor(() => expect(lastParams(app, '/reviews').get('sort')).toBe('asin:desc'))
    await userEvent.type(page.getByRole('searchbox', { name: '搜索评分商品' }), 'B0RATE{Enter}')
    await waitFor(() => expect(lastParams(app, '/reviews').get('q')).toBe('B0RATE'))
    await userEvent.click(page.getByRole('combobox', { name: '星级低于' }))
    await userEvent.click(await screen.findByTitle('低于 4 星'))
    await waitFor(() => expect(lastParams(app, '/reviews').get('ratingBelow')).toBe('4'))
    expect(lastParams(app, '/reviews').get('tab')).toBe('ratings')
  })

  it('翻页：下一页带游标，回到上一页', async () => {
    let first = true
    const { app, page } = await open(() => (first ? ratingsResponse({ pageInfo: { pageSize: 50, nextCursor: 'cur-2', hasMore: true, approxTotal: 3 } }) : ratingsResponse()))
    await rowOf(page, '旅行箱 24 寸')
    first = false
    await userEvent.click(page.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(lastParams(app, '/reviews').get('cursor')).toBe('cur-2'))
    expect(await page.findByText(/第 2 页/)).toBeInTheDocument()
  })
})

describe('评价与反馈：导入评分文件', () => {
  const CSV = 'ASIN,采集日期,平均星级,评分数\nB0RATE0001,2020-01-02,4.5,1300\n'
  const BAD = 'ASIN,采集日期,平均星级,评分数\nB0RATE0001,2020-01-02,9,1300\n'

  const pick = async (content: string, name = 'ratings.csv') => {
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.upload(dialog.getByLabelText('评分文件'), new File([content], name, { type: 'text/csv' }))
    await dialog.findByText(`已读取 ${name}`)
    return dialog
  }
  const openImport = async (extra: Record<string, Handler> = {}) => {
    const { app, page } = await open(() => ratingsResponse(), extra)
    await rowOf(page, '旅行箱 24 寸')
    await userEvent.click(page.getByRole('button', { name: /导入评分文件/ }))
    return { app, page }
  }

  it('读出文件文本连同店铺与文件名提交；成功提示导入行数与覆盖行数', async () => {
    const bodies: Array<Record<string, unknown>> = []
    await openImport({
      '/reviews/ratings-import': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { status: 201, body: ok({ imported: 3, replaced: 1, batchId: 'b1', fileName: 'ratings.csv', errors: [] }).body }
      },
    })
    const dialog = await pick(CSV)
    expect(dialog.getByText(/导入评分文件/, { selector: '.ant-modal-title' })).toBeInTheDocument()
    expect(dialog.getByText(/平均星级与评分数在亚马逊官方接口里没有来源/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /^导\s*入$/ }))
    await waitFor(() => expect(bodies).toEqual([{ storeId: 'st1', fileName: 'ratings.csv', content: CSV }]))
    expect(await screen.findByText('已导入 3 行，覆盖了 1 行已有记录')).toBeInTheDocument()
  })

  it('服务端逐行拒绝：错误按“第几行”列在文件下面，弹窗不关闭', async () => {
    await openImport({
      '/reviews/ratings-import': () => ({
        status: 422,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: '文件内容有误，没有导入任何数据',
            fieldErrors: { content: ['第 3 行（采集日期）：采集日期不能晚于今天', '第 5 行（评分数）：评分数要是整数'] },
          },
        },
      }),
    })
    const dialog = await pick(CSV)
    await userEvent.click(dialog.getByRole('button', { name: /^导\s*入$/ }))
    expect(await dialog.findByText('第 3 行（采集日期）：采集日期不能晚于今天')).toBeInTheDocument()
    expect(dialog.getByText('第 5 行（评分数）：评分数要是整数')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('选文件时先在本地预检：按 line、column、message 列出，有错不提交', async () => {
    const { app } = await openImport()
    const dialog = await pick(BAD, 'bad.csv')
    expect(await dialog.findByTestId('import-line-errors')).toHaveTextContent('第 2 行（平均星级）：平均星级要在 1 到 5 之间')
    await userEvent.click(dialog.getByRole('button', { name: /^导\s*入$/ }))
    expect(await dialog.findByText(/文件有 1 处错误/)).toBeInTheDocument()
    expect(callsOf(app, '/reviews/ratings-import', 'POST')).toHaveLength(0)
  })

  it('没选文件直接导入：提示请选择文件', async () => {
    const { app } = await openImport()
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /^导\s*入$/ }))
    expect(await dialog.findByText('请选择文件')).toBeInTheDocument()
    expect(callsOf(app, '/reviews/ratings-import', 'POST')).toHaveLength(0)
  })

  it('弹窗里可以下载模板（按钮存在，点击生成文件）', async () => {
    const created: Blob[] = []
    Object.assign(URL, { createObjectURL: (blob: Blob) => (created.push(blob), 'blob:test'), revokeObjectURL: () => undefined })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await openImport()
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '下载模板' }))
    expect(created).toHaveLength(1)
    expect(created[0].type).toContain('text/csv')
  })

  it('没有 data.import 权限：按钮禁用并写明原因', async () => {
    const { page } = await open(() => ratingsResponse(), {}, { ...defaultMe, permissions: ['reviews.read'] })
    await rowOf(page, '旅行箱 24 寸')
    expect(page.getByRole('button', { name: /导入评分文件/ })).toBeDisabled()
    expect(page.getByText(/需要“数据导入”权限（data\.import）/)).toBeInTheDocument()
  })
})
