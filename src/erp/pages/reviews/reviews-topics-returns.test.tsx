import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { ReturnsTabResponse, TopicsTabResponse } from '@nova/api-contracts'
import { callsOf, improvementRow, lastParams, ok, returnsResponse, reviewsHandlers, reviewsPages, topicsResponse } from './reviews-fixtures.test-helper'

// 评价与反馈：评论主题与退货主题页签（P4-13）。切换商品与类目、趋势图、来源没接上、改进清单与“指派跟进”（请求体、无成员查看权限只能指派给自己）。

// jsdom 里没有画布，图表容器换成占位（图表配置本身由 reviews-options 的纯函数生成）
vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

afterEach(() => vi.unstubAllGlobals())

const mount = (url: string, handlers: Record<string, Handler>, me = defaultMe) => mountApp({ url, pages: reviewsPages, me, handlers })

describe('评价与反馈：评论主题', () => {
  const openTopics = async (response: () => TopicsTabResponse = () => topicsResponse(), url = '/app/reviews?tab=topics') => {
    const app = mount(url, reviewsHandlers({ topics: response }))
    const panel = within(await screen.findByTestId('topics-panel', {}, { timeout: 15_000 }))
    return { app, panel }
  }

  it('前 10 正面与负面主题：提及量区间原样、类目全部商品与前 25% 占比，没有的写“尚无记录”', async () => {
    const { panel } = await openTopics()
    const negative = within(await panel.findByTestId('topics-负面', {}, { timeout: 15_000 }))
    const first = negative.getByText('Zipper broke').closest('tr, [role=row]') as HTMLElement
    expect(first).toHaveTextContent('1')
    expect(first).toHaveTextContent('100-200')
    expect(first).toHaveTextContent('12.0%')
    expect(first).toHaveTextContent('8.0%')
    const second = negative.getByText('Handle loose').closest('tr, [role=row]') as HTMLElement
    expect(within(second).getAllByText('尚无记录')).toHaveLength(3)
    const positive = within(panel.getByTestId('topics-正面'))
    const good = positive.getByText('Sturdy wheels').closest('tr, [role=row]') as HTMLElement
    expect(good).toHaveTextContent('200-300')
    expect(good).toHaveTextContent('20.0%')
    expect(good).toHaveTextContent('25.0%')
    expect(panel.getByText(/主题快照日期 2026-10-20/)).toHaveTextContent('所在类目：行李箱')
    expect(await panel.findByRole('img', { name: '类目评论主题趋势' })).toBeInTheDocument()
    expect(panel.getByText(/评论主题来自亚马逊客户反馈接口/)).toBeInTheDocument()
  })

  it('切换商品：请求带 storeId 与 asin，地址栏保留选择', async () => {
    const { app, panel } = await openTopics(() => topicsResponse())
    await panel.findByText('Sturdy wheels', {}, { timeout: 15_000 })
    await userEvent.click(panel.getByRole('combobox', { name: '评论商品' }))
    await userEvent.click(await screen.findByTitle('B0RATE0002 · 收纳袋 · Northstar US'))
    await waitFor(() => expect(lastParams(app, '/reviews').get('asin')).toBe('B0RATE0002'))
    expect(lastParams(app, '/reviews').get('storeId')).toBe('st1')
    expect(lastParams(app, '/reviews').get('tab')).toBe('topics')
    expect(app.router.state.location.search).toMatchObject({ tab: 'topics', storeId: 'st1', asin: 'B0RATE0002' })
  })

  it('地址栏带着 storeId 与 asin 进来：请求带出，刷新不丢选择', async () => {
    const { app, panel } = await openTopics(() => topicsResponse(), '/app/reviews?tab=topics&storeId=st1&asin=B0RATE0002')
    await panel.findByText('Sturdy wheels', {}, { timeout: 15_000 })
    expect(lastParams(app, '/reviews').get('asin')).toBe('B0RATE0002')
    expect(lastParams(app, '/reviews').get('storeId')).toBe('st1')
  })

  it('趋势可以切换正面与负面：没有趋势线的一侧写“尚无记录”', async () => {
    const { panel } = await openTopics()
    await panel.findByRole('img', { name: '类目评论主题趋势' }, { timeout: 15_000 })
    fireEvent.click(panel.getByRole('radio', { name: '正面' }))
    expect(await panel.findByTestId('topic-trend-empty')).toHaveTextContent('尚无记录')
    expect(panel.queryByRole('img', { name: '类目评论主题趋势' })).toBeNull()
  })

  it('没有负面主题：写前置条件，不画表格行', async () => {
    const base = topicsResponse()
    const { panel } = await openTopics(() => topicsResponse({ selected: { ...base.selected!, negative: [] } }))
    expect(await panel.findByText(/最近一次同步没有负面评论主题/, {}, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('品牌分析没开通（来源未接入）：写“尚未接入”与原因，不显示示例主题', async () => {
    const { panel } = await openTopics(() => topicsResponse({ state: 'NOT_CONNECTED', note: '这个店铺没有品牌分析角色，客户反馈接口不可用', options: [], selected: null, freshness: null }))
    expect((await panel.findAllByText('尚未接入', {}, { timeout: 15_000 })).length).toBeGreaterThan(0)
    expect(panel.getByText(/没有品牌分析角色/)).toBeInTheDocument()
    expect(panel.queryByText('Zipper broke')).toBeNull()
  })

  it('不适用：写“不适用”与原因', async () => {
    const { panel } = await openTopics(() => topicsResponse({ state: 'NOT_APPLICABLE', note: '这个店铺不是品牌所有者', options: [], selected: null }))
    expect(await panel.findByText('不适用', {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(panel.getByText(/不是品牌所有者/)).toBeInTheDocument()
  })

  it('还没有同步到任何主题：写“尚无记录”', async () => {
    const { panel } = await openTopics(() => topicsResponse({ options: [], selected: null }))
    expect(await panel.findByText(/尚无记录：还没有同步到评论主题/, {}, { timeout: 15_000 })).toBeInTheDocument()
  })
})

describe('评价与反馈：退货主题与改进清单', () => {
  const openReturns = async (response: () => ReturnsTabResponse = () => returnsResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
    const app = mount('/app/reviews?tab=returns', { ...reviewsHandlers({ returns: response }), ...extra }, me)
    const panel = within(await screen.findByTestId('returns-panel', {}, { timeout: 15_000 }))
    await panel.findByText('Too small', {}, { timeout: 15_000 })
    return { app, panel }
  }
  const assignDialog = async (panel: ReturnType<typeof within>) => {
    const row = (await panel.findByText('B0RATE0001')).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: /指派跟进/ }))
    return within(await screen.findByRole('dialog'))
  }

  it('类目退货主题：最近一月占比分全部商品与前 25%，没有的写“尚无记录”；趋势图与口径', async () => {
    const { panel } = await openReturns()
    const row = panel.getByText('Too small').closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('2026-10')
    expect(row).toHaveTextContent('15.0%')
    expect(within(row).getByText('尚无记录')).toBeInTheDocument()
    expect(await panel.findByRole('img', { name: '类目退货主题趋势' })).toBeInTheDocument()
    expect(panel.getByText(/退货主题只到类目级/)).toBeInTheDocument()
  })

  it('切换类目：请求带 storeId 与 nodeId', async () => {
    const { app, panel } = await openReturns()
    await userEvent.click(panel.getByRole('combobox', { name: '退货类目' }))
    await userEvent.click(await screen.findByTitle('收纳用品 · Northstar US · 1 个商品'))
    await waitFor(() => expect(lastParams(app, '/reviews').get('nodeId')).toBe('n2'))
    expect(lastParams(app, '/reviews').get('storeId')).toBe('st1')
    expect(app.router.state.location.search).toMatchObject({ tab: 'returns', nodeId: 'n2' })
  })

  it('改进清单：负面主题（带提及量）、近 90 天退货件数与原因、可能相关标记、建议', async () => {
    const { panel } = await openReturns()
    const row = (await panel.findByText('B0RATE0001')).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('Zipper broke（100-200）')
    expect(row).toHaveTextContent('Handle loose')
    expect(row).toHaveTextContent('18 件')
    expect(row).toHaveTextContent('商品有缺陷 10 件（56%）')
    expect(within(row).getByText('可能相关')).toBeInTheDocument()
    expect(row).toHaveTextContent('优先核对商品本身')
    expect(panel.getByText(/近 90 天，按退货件数排序/)).toBeInTheDocument()
  })

  it('没有退货记录的商品：退货一栏写“尚无记录”，不写 0 件', async () => {
    const { panel } = await openReturns(() =>
      returnsResponse({ improvements: { state: 'OK', note: null, days: 90, rows: [improvementRow({ returnUnits: 0, returnReasons: [], possiblyRelated: false })] } }),
    )
    const row = (await panel.findByText('B0RATE0001')).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('尚无记录')).toBeInTheDocument()
    expect(within(row).getByText('文字无重合')).toBeInTheDocument()
    expect(row).not.toHaveTextContent('0 件')
  })

  it('指派跟进：默认指派给自己、严重度“提示”；请求体含标题、说明、ASIN 标签，不带 entityType', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { panel } = await openReturns(undefined, {
      '/work-items': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { status: 201, body: ok({ id: 'w1' }).body }
      },
    })
    const dialog = await assignDialog(panel)
    expect(dialog.getByText(/改进评价问题：B0RATE0001 Zipper broke/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /生成待办/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    const body = bodies[0]
    expect(body).toMatchObject({
      title: '改进评价问题：B0RATE0001 Zipper broke',
      severity: 'INFO',
      ownerId: 'u1',
      entityLabel: 'B0RATE0001',
      suggestedAction: returnsResponse().improvements.rows[0].suggestion,
    })
    expect(String(body.detail)).toContain('建议：')
    expect(String(body.detail)).toContain('数据口径：')
    expect(body).not.toHaveProperty('entityType')
    expect(body).not.toHaveProperty('dueAt')
    expect(await screen.findByText('已生成待办')).toBeInTheDocument()
  })

  it('指派给其他成员：负责人、严重度与截止日期随请求带出', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { panel } = await openReturns(undefined, {
      '/work-items': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { status: 201, body: ok({ id: 'w1' }).body }
      },
    })
    const dialog = await assignDialog(panel)
    await userEvent.click(dialog.getByRole('combobox', { name: '负责人' }))
    await userEvent.click(await screen.findByTitle('王工'))
    await userEvent.click(dialog.getByRole('combobox', { name: '严重度' }))
    await userEvent.click(await screen.findByTitle('警告'))
    fireEvent.change(dialog.getByLabelText('截止日期'), { target: { value: '2099-11-01' } })
    await userEvent.click(dialog.getByRole('button', { name: /生成待办/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ ownerId: 'u2', severity: 'WARNING', dueAt: new Date('2099-11-01T23:59:59').toISOString() })
  })

  it('没有 member.read：负责人不能选，只能指派给自己，也不读取成员列表', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { app, panel } = await openReturns(
      undefined,
      {
        '/work-items': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return { status: 201, body: ok({ id: 'w1' }).body }
        },
      },
      { ...defaultMe, permissions: ['reviews.read', 'workitem.assign'] },
    )
    const dialog = await assignDialog(panel)
    expect(dialog.getByRole('combobox', { name: '负责人' })).toBeDisabled()
    expect(dialog.getByText(/只能指派给自己/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /生成待办/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ ownerId: 'u1' })
    expect(callsOf(app, '/members/options')).toHaveLength(0)
  })

  it('没有 workitem.assign：指派跟进禁用', async () => {
    const { panel } = await openReturns(undefined, {}, { ...defaultMe, permissions: ['reviews.read'] })
    const row = (await panel.findByText('B0RATE0001')).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: /指派跟进/ })).toBeDisabled()
  })

  it('服务端拒绝：在弹窗里显示原因，不提示成功', async () => {
    const { panel } = await openReturns(undefined, { '/work-items': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有指派权限' } } }) })
    const dialog = await assignDialog(panel)
    await userEvent.click(dialog.getByRole('button', { name: /生成待办/ }))
    expect(await dialog.findByText(/没有指派权限/)).toBeInTheDocument()
    expect(screen.queryByText('已生成待办')).toBeNull()
  })

  it('改进清单没有退货查看权限：写“无权限（需要退货查看权限）”', async () => {
    const { panel } = await openReturns(() => returnsResponse({ improvements: { state: 'RESTRICTED', note: null, rows: [], days: 90 } }))
    expect(await panel.findByText('无权限（需要退货查看权限）')).toBeInTheDocument()
    expect(panel.queryByRole('button', { name: /指派跟进/ })).toBeNull()
  })

  it('退货主题来源没接上：写“尚未接入”，不显示示例主题', async () => {
    mount('/app/reviews?tab=returns', reviewsHandlers({ returns: () => returnsResponse({ state: 'NOT_CONNECTED', note: '这个店铺没有品牌分析角色', nodes: [], selectedNode: null, freshness: null }) }))
    const panel = within(await screen.findByTestId('returns-panel', {}, { timeout: 15_000 }))
    expect((await panel.findAllByText('尚未接入')).length).toBeGreaterThan(0)
    expect(panel.queryByText('Too small')).toBeNull()
  })
})
