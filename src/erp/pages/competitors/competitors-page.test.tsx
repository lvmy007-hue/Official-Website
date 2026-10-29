import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { candidatesResponse, competitorHandlers, competitorRow, listResponse, ok } from './competitors-fixtures.test-helper'

// 竞品监控（P4-12）：假服务端返回固定数据，验证列表（没有数据写“尚无记录”而不是 0、点击份额带“下限”）、
// 筛选与排序随请求带出、手工添加与取消关注（请求体与路径）、搜索词推荐的加入关注、没有写权限时按钮禁用。

const pages: LivePages = { CompetitorsPage: { load: () => import('./CompetitorsPage') } }
const url = '/app/competitors'
afterEach(() => vi.unstubAllGlobals())

const open = async (response = () => listResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url, pages, me, handlers: competitorHandlers(response, extra) })
  const page = within(await screen.findByTestId('competitors-page'))
  await page.findByText('竞品旅行箱 24 寸', {}, { timeout: 15_000 })
  return { app, page }
}
const calls = (app: { calls: Array<{ path: string; search: string; method: string }> }, path: string, method = 'GET') => app.calls.filter(call => call.path === path && call.method === method)
const lastSearch = (app: { calls: Array<{ path: string; search: string; method: string }> }) => {
  const list = calls(app, '/competitors')
  return new URLSearchParams(list[list.length - 1]?.search)
}

describe('竞品监控：关注的竞品', () => {
  it('有快照的行：价格、与我方的价格差与占比、推荐报价、配送、会员资格、排名与名次差、点击份额带“下限”', async () => {
    const { page } = await open()
    const row = page.getByText('竞品旅行箱 24 寸').closest('tr, [role=row]') as HTMLElement
    const link = within(row).getByRole('link', { name: '竞品旅行箱 24 寸' })
    expect(link.getAttribute('href')).toContain('/app/competitors/B0COMPET01')
    expect(link.getAttribute('href')).toContain('storeId=st1')
    expect(link.getAttribute('href')).toContain('ownAsin=B0OWN00001')
    expect(row).toHaveTextContent('$25.50')
    expect(row).toHaveTextContent('$20.00')
    expect(row).toHaveTextContent('+$5.50')
    expect(row).toHaveTextContent('+27.5%')
    expect(row).toHaveTextContent('有推荐报价')
    expect(row).toHaveTextContent('FBA')
    expect(row).toHaveTextContent('会员可享')
    expect(row).toHaveTextContent('80')
    expect(row).toHaveTextContent('-20')
    expect(row).toHaveTextContent('43.8%')
    expect(within(row).getByText('下限')).toBeInTheDocument()
    expect(row).toHaveTextContent('热门搜索词点击前三：luggage')
  })

  it('等待首次同步的行：数据字段全写“尚无记录”（不写 0），没有对应商品写“未指定”', async () => {
    const { page } = await open()
    const row = page.getByRole('link', { name: 'B0COMPET02' }).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(6)
    expect(row).toHaveTextContent('等待首次同步')
    expect(row).toHaveTextContent('未指定')
    expect(row).not.toHaveTextContent('$0.00')
    expect(within(row).queryByText('下限')).toBeNull()
    expect(within(page.getByTestId('competitor-summary')).getByText(/等待首次同步/)).toHaveTextContent('等待首次同步 1')
  })

  it('一条关注都没有：写前置条件；还没接入店铺时写明原因', async () => {
    mountApp({
      url,
      pages,
      handlers: competitorHandlers(() =>
        listResponse({ state: 'NOT_CONNECTED', note: '还没有接入亚马逊店铺；接入店铺并同步后，才能关注竞品', items: [], summary: { watched: 0, withSnapshot: 0, waiting: 0 }, stores: [] }),
      ),
    })
    const page = within(await screen.findByTestId('competitors-page'))
    expect((await page.findAllByText(/还没有接入亚马逊店铺/, {}, { timeout: 15_000 })).length).toBeGreaterThan(0)
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({ url, pages, handlers: { ...competitorHandlers(() => listResponse()), '/competitors': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('competitors-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('竞品旅行箱 24 寸')).toBeNull()
  }, 30_000)

  it('排序、关键字与来源筛选随请求带出，换条件回到第一页', async () => {
    const { app, page } = await open()
    await userEvent.click(page.getByRole('button', { name: '排序方向' }))
    await waitFor(() => expect(lastSearch(app).get('sort')).toBe('addedAt:asc'))
    const input = page.getByRole('searchbox', { name: '搜索竞品' })
    await userEvent.type(input, 'acme{Enter}')
    await waitFor(() => expect(lastSearch(app).get('q')).toBe('acme'))
    await userEvent.click(page.getByRole('combobox', { name: '来源' }))
    await userEvent.click(await screen.findByTitle('手工添加'))
    await waitFor(() => expect(lastSearch(app).get('reason')).toBe('MANUAL'))
  })

  it('翻页：下一页带游标，回到上一页', async () => {
    let first = true
    const { app, page } = await open(() => (first ? listResponse({ pageInfo: { pageSize: 20, nextCursor: 'cur-2', hasMore: true, approxTotal: 3 } }) : listResponse()))
    first = false
    await userEvent.click(page.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(lastSearch(app).get('cursor')).toBe('cur-2'))
    expect(await page.findByText(/第 2 页/)).toBeInTheDocument()
  })
})

describe('竞品监控：手工添加与取消关注', () => {
  it('手工添加：校验 ASIN 格式，提交店铺、竞品 ASIN（规整为大写）、我方对应 ASIN 与备注', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { page } = await open(() => listResponse(), {
      '/competitors': (target, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)))
          return ok({ id: 'w9', asin: 'B0NEWCOMP1', ownAsin: 'B0OWN00001', storeId: 'st1', reason: 'MANUAL', note: '已加入关注；价格、排名等数据要等下一次同步' })
        }
        return ok(listResponse())
      },
    })
    await userEvent.click(page.getByRole('button', { name: /手工添加竞品/ }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByRole('textbox', { name: '竞品 ASIN' }), 'bad')
    await userEvent.click(dialog.getByRole('button', { name: /加入关注/ }))
    expect(await dialog.findByText(/10 位字母或数字/)).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.clear(dialog.getByRole('textbox', { name: '竞品 ASIN' }))
    await userEvent.type(dialog.getByRole('textbox', { name: '竞品 ASIN' }), 'b0newcomp1')
    await userEvent.type(dialog.getByRole('textbox', { name: '我方对应 ASIN' }), 'b0own00001')
    await userEvent.type(dialog.getByRole('textbox', { name: '备注' }), '同价位')
    await userEvent.click(dialog.getByRole('button', { name: /加入关注/ }))
    await waitFor(() => expect(bodies).toEqual([{ storeId: 'st1', asin: 'B0NEWCOMP1', ownAsin: 'B0OWN00001', reason: 'MANUAL', note: '同价位' }]))
  })

  it('服务端拒绝（例如是我方自己的商品）：在弹窗里显示原因，不关闭', async () => {
    const { page } = await open(() => listResponse(), {
      '/competitors': (_target, init) =>
        init?.method === 'POST' ? { status: 409, body: { error: { code: 'DATA_CONDITION_FAILED', message: '这个 ASIN 是你自己的商品，不能当作竞品关注' } } } : ok(listResponse()),
    })
    await userEvent.click(page.getByRole('button', { name: /手工添加竞品/ }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByRole('textbox', { name: '竞品 ASIN' }), 'B0OWN00002')
    await userEvent.click(dialog.getByRole('button', { name: /加入关注/ }))
    expect(await dialog.findByText(/自己的商品/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('取消关注：先确认；路径带竞品 ASIN、店铺与我方对应 ASIN', async () => {
    const deleted: string[] = []
    const { page } = await open(() => listResponse(), {
      '/competitors/B0COMPET01': (target, init) => {
        if (init?.method === 'DELETE') deleted.push(`${target.pathname}${target.search}`)
        return ok({ removed: 1 })
      },
    })
    const row = page.getByText('竞品旅行箱 24 寸').closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: /取消关注/ }))
    expect(deleted).toHaveLength(0)
    expect(await screen.findByText(/一并删除/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /确认取消/ }))
    await waitFor(() => expect(deleted).toEqual(['/api/v1/competitors/B0COMPET01?storeId=st1&ownAsin=B0OWN00001']))
  })

  it('没有 competitors.write：添加与取消关注都禁用', async () => {
    const { page } = await open(() => listResponse(), {}, { ...defaultMe, permissions: ['competitors.read'] })
    expect(page.getByRole('button', { name: /手工添加竞品/ })).toBeDisabled()
    const row = page.getByText('竞品旅行箱 24 寸').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: /取消关注/ })).toBeDisabled()
  })
})

describe('竞品监控：搜索词推荐', () => {
  const openCandidates = async (response = () => candidatesResponse(), extra: Record<string, Handler> = {}) => {
    const { app, page } = await open(() => listResponse(), { '/competitors/candidates': () => ok(response()), ...extra })
    await userEvent.click(page.getByRole('tab', { name: '搜索词推荐' }))
    const panel = within(await page.findByTestId('competitor-candidates'))
    await panel.findByText('候选旅行箱', {}, { timeout: 15_000 })
    return { app, panel }
  }

  it('候选：点击份额带“下限”，列出进入点击前三的核心词与位次，并说明数据周期', async () => {
    const { panel } = await openCandidates()
    const row = panel.getByText('候选旅行箱').closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('43.0%')
    expect(within(row).getByText('下限')).toBeInTheDocument()
    expect(row).toHaveTextContent('luggage（第 1 位，点击份额 50.0%）')
    expect(row).toHaveTextContent('等共 3 个词')
    expect(panel.getByText(/2026-10-12 起的一周/)).toBeInTheDocument()
  })

  it('加入关注：以搜索词为来源提交，对应我方商品随请求带出', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { panel } = await openCandidates(() => candidatesResponse(), {
      '/competitors': (_target, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)))
          return ok({ id: 'w9', asin: 'B0COMPET03', ownAsin: 'B0OWN00001', storeId: 'st1', reason: 'SEARCH_TERM', note: '已加入关注' })
        }
        return ok(listResponse())
      },
    })
    await userEvent.click(panel.getByRole('button', { name: /加入关注/ }))
    await waitFor(() => expect(bodies).toEqual([{ storeId: 'st1', asin: 'B0COMPET03', ownAsin: 'B0OWN00001', reason: 'SEARCH_TERM', note: 'luggage' }]))
  })

  it('没有品牌分析数据：写前置条件，不显示示例候选', async () => {
    const { panel } = await (async () => {
      const app = mountApp({
        url,
        pages,
        handlers: competitorHandlers(() => listResponse(), {
          '/competitors/candidates': () => ok(candidatesResponse({ state: 'NO_DATA', note: '还没有同时具备“热门搜索词”和“搜索查询表现”的周数据', period: null, items: [] })),
        }),
      })
      const page = within(await screen.findByTestId('competitors-page'))
      await userEvent.click(await page.findByRole('tab', { name: '搜索词推荐' }))
      return { app, panel: within(await page.findByTestId('competitor-candidates')) }
    })()
    expect((await panel.findAllByText(/热门搜索词”和“搜索查询表现/, {}, { timeout: 15_000 })).length).toBeGreaterThan(0)
    expect(panel.queryByText('候选旅行箱')).toBeNull()
  })
})

describe('竞品监控：行数据的边界', () => {
  it('我方分类不同、名次差为空时悬停说明原因；点击份额没有结果时写“尚无记录”', async () => {
    const { page } = await open(() => listResponse({ items: [competitorRow({ rankGap: null, rankNote: '两边的排名分类不同，不能直接比较', clickShare: null, clickShareTerms: null })] }))
    const row = page.getByText('竞品旅行箱 24 寸').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
    expect(within(row).queryByText('下限')).toBeNull()
  })
})
