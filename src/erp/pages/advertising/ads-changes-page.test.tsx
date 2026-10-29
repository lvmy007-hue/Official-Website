import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { changeHandlers, changeRow, compareResponse, listResponse, notConnected } from './ads-changes-fixtures.test-helper'
import { ok } from './ads-fixtures.test-helper'

// 变更记录页（P3-14）：假服务端返回固定数据，验证四种来源的显示与条数、外部变更“不知道是谁改的”与发生区间的写法、空值写“空”（不写 0）、
// 没有快照写“尚未接入”、手动与自动规则写入未接入的说明、筛选与翻页随请求带出、前后对照（有快照与没有快照）、读取失败。

const pages: LivePages = { AdsChangesPage: { load: () => import('./AdsChangesPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/changes'
const rowOf = async (page: HTMLElement, text: string) => (await within(page).findByText(text)).closest('tr, [role=row]') as HTMLElement

describe('广告变更记录', () => {
  it('有数据：对象、来源、字段、改前改后、时间显示；对象名称链到详情；各来源条数写在切换条上', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-changes-page')
    const first = await rowOf(page, '春季推广')
    expect(first).toHaveTextContent('外部变更')
    expect(first).toHaveTextContent('日预算')
    expect(first).toHaveTextContent('$20.00')
    expect(first).toHaveTextContent('$25.00')
    expect(first).toHaveTextContent('美国账户 · Northstar US')
    expect(within(first).getByRole('link', { name: '春季推广' })).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
    expect(within(page).getByText('全部（4）')).toBeInTheDocument()
    expect(within(page).getByText('手动（1）')).toBeInTheDocument()
    expect(within(page).getByText('分时策略（0）')).toBeInTheDocument()
    expect(screen.getByText(/未选择日期范围，当前显示 2026-09-23 至 2026-10-22/)).toBeInTheDocument()
  })

  it('操作人：手动写姓名，自动规则写来源，外部变更写“未知（外部）”并说明发生区间，不假装知道是谁改的', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-changes-page')
    expect(await rowOf(page, 'yoga mat')).toHaveTextContent('王小明')
    expect(await rowOf(page, '夏季推广')).toHaveTextContent('自动规则')
    const external = await rowOf(page, '春季推广')
    expect(external).toHaveTextContent('未知（外部）')
    expect(external).toHaveTextContent('发生在')
    expect(external).toHaveTextContent('之后')
  })

  it('清空成空值写“空”，没有对象名称用编号，对象类型没有详情页就不链接；没有 0', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-changes-page')
    const keyword = await rowOf(page, 'kw-1')
    expect(keyword).toHaveTextContent('关键词')
    expect(keyword).toHaveTextContent('EXACT')
    expect(within(keyword).getByText('空')).toBeInTheDocument()
    expect(within(keyword).queryByRole('link')).toBeNull()
    expect(keyword).not.toHaveTextContent('$0.00')
  })

  it('写入记录：没有提交过写入时写“尚无记录”；有记录时显示来源、前后值、状态与失败原因', async () => {
    const run = (patch: Record<string, unknown>) => ({
      id: 'w1',
      kind: 'CAMPAIGN_BUDGET',
      kindLabel: '修改活动日预算',
      source: 'MANUAL',
      entityType: 'CAMPAIGN',
      entityId: 'cam-1',
      entityLabel: '春季推广',
      before: '20',
      after: '35',
      status: 'SUCCEEDED',
      failureCode: null,
      failureText: null,
      requestedBy: 'u1',
      createdAt: '2026-10-22T08:00:00.000Z',
      finishedAt: '2026-10-22T08:00:05.000Z',
      ...patch,
    })
    mountApp({
      url,
      pages,
      handlers: {
        ...changeHandlers(() => listResponse()),
        '/ads/writes': () =>
          ok({
            kinds: [],
            runs: [run({}), run({ id: 'w2', source: 'AUTO_RULE', status: 'FAILED', failureCode: 'ADS_API_500', failureText: '亚马逊广告接口暂时不可用，请稍后重试', before: null, after: 'PAUSED' })],
          }),
      },
    })
    const runs = await screen.findByTestId('ads-write-runs')
    expect(await within(runs).findByText('已完成')).toBeInTheDocument()
    expect(within(runs).getByText('失败')).toBeInTheDocument()
    expect(runs).toHaveTextContent('自动规则')
    expect(runs).toHaveTextContent('亚马逊广告接口暂时不可用')
    expect(runs).toHaveTextContent('尚未同步')
  })

  it('没有写入记录：写“尚无记录”', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const runs = await screen.findByTestId('ads-write-runs')
    expect(await within(runs).findByText(/尚无记录/)).toBeInTheDocument()
  })

  it('快照状态与写入说明：最近一次快照时间、外部变更口径、手动与自动规则变更在亚马逊确认后记录', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const tracking = await screen.findByTestId('ads-changes-tracking')
    expect(tracking).toHaveTextContent('最近一次实体快照')
    expect(tracking).toHaveTextContent('只能确定改动发生在“上一次快照”与“检测到”之间')
    expect(screen.getByTestId('ads-changes-write-note')).toHaveTextContent('亚马逊确认写入成功之后才会出现在这里')
  })

  it('从没拍过快照：写“尚未接入”和原因，不画示例行，也不写“没有变更”', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => notConnected()) })
    const tracking = await screen.findByTestId('ads-changes-tracking')
    expect(tracking).toHaveTextContent('尚未接入')
    expect(tracking).toHaveTextContent('还没有拍过实体快照')
    expect(screen.queryByText('春季推广')).toBeNull()
  })

  it('筛选后没有结果：提示放宽条件', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse({ state: 'NO_DATA', note: '没有符合筛选条件的变更记录；可以放宽筛选条件或扩大日期范围', items: [] })) })
    expect(await screen.findByTestId('ads-changes-page')).toBeInTheDocument()
    expect((await screen.findAllByText(/没有符合筛选条件的变更记录/)).length).toBeGreaterThan(0)
  })

  it('来源与搜索随请求带出，并回到第一页', async () => {
    const app = mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-changes-page')
    await rowOf(page, '春季推广')
    const first = app.calls.find(call => call.path === '/ads/changes')!
    expect(new URLSearchParams(first.search).get('source')).toBeNull()
    fireEvent.click(within(page).getByText('外部变更（2）'))
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('source') === 'EXTERNAL')).toBe(true))
    const search = within(page).getByRole('searchbox', { name: '搜索对象名称或变更前后的值' })
    fireEvent.change(search, { target: { value: '春季' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('q') === '春季')).toBe(true))
  })

  it('翻页：有下一页时下一页可点，带着游标重新请求，上一页回到第一页', async () => {
    const app = mountApp({
      url,
      pages,
      handlers: changeHandlers(requestUrl =>
        requestUrl.searchParams.get('cursor')
          ? listResponse({ items: [changeRow({ id: 'ch-z', entityLabel: '第二页活动' })], pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 5 } })
          : listResponse({ pageInfo: { pageSize: 20, nextCursor: 'cursor-2', hasMore: true, approxTotal: 5 } }),
      ),
    })
    const page = await screen.findByTestId('ads-changes-page')
    await rowOf(page, '春季推广')
    fireEvent.click(within(page).getByRole('button', { name: /下一页/ }))
    expect(await within(page).findByText('第二页活动')).toBeInTheDocument()
    expect(app.calls.some(call => new URLSearchParams(call.search).get('cursor') === 'cursor-2')).toBe(true)
    fireEvent.click(within(page).getByRole('button', { name: /上一页/ }))
    expect(await within(page).findByText('春季推广')).toBeInTheDocument()
  })

  it('前后对照：有快照时列出全部字段，改动的标“已改动”，没改的显示快照里的值；同一对象的其他变更列在下面', async () => {
    mountApp({ url, pages, handlers: changeHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-changes-page')
    fireEvent.click(within(await rowOf(page, '春季推广')).getByRole('button', { name: /查看前后对照 日预算 春季推广/ }))
    const drawer = await screen.findByTestId('ads-change-compare')
    const fields = await within(drawer).findByTestId('ads-change-fields')
    expect(fields).toHaveTextContent('名称')
    expect(fields).toHaveTextContent('日预算')
    expect(within(fields).getAllByText('已改动')).toHaveLength(1)
    expect(within(drawer).getByTestId('ads-change-basis')).toHaveTextContent('最近一份实体快照')
    expect(drawer).toHaveTextContent('之后、')
    expect(drawer).toHaveTextContent('已启用 → 已暂停')
  })

  it('前后对照：没有快照只列被改的字段并说明；这个对象没有其他变更也写明', async () => {
    mountApp({
      url,
      pages,
      handlers: changeHandlers(
        () => listResponse(),
        () =>
          compareResponse({
            basis: 'CHANGE_ONLY',
            basisNote: '没有该对象在变更时刻的实体快照，只列出被改动的字段',
            fields: [{ key: 'budget', label: '日预算', before: null, after: '$25.00', changed: true }],
            related: [],
          }),
      ),
    })
    const page = await screen.findByTestId('ads-changes-page')
    fireEvent.click(within(await rowOf(page, '春季推广')).getByRole('button', { name: /查看前后对照/ }))
    const drawer = await screen.findByTestId('ads-change-compare')
    expect(await within(drawer).findByText(/没有该对象在变更时刻的实体快照/)).toBeInTheDocument()
    expect(within(drawer).getByText('这个对象没有其他变更记录')).toBeInTheDocument()
    expect(within(within(drawer).getByTestId('ads-change-fields')).getByText('空')).toBeInTheDocument()
  })

  it('读取失败：显示错误，不显示示例数字', async () => {
    mountApp({ url, pages, handlers: { '/ads/changes': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('ads-changes-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('春季推广')).toBeNull()
  }, 30_000)
})
