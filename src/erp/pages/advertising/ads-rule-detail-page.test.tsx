import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { detailHandlers, detailResponse, dryRunResponse, qualityOf, runRow, runsResponse } from './ads-rules-fixtures.test-helper'

// 自动规则详情页（P3-13）：规则内容与质量（命中率、采纳率、没有执行时效果写“尚未接入”）、试运行（只读、截止日、命中与跳过、没数据写原因）、运行记录（翻页、没有待办写“尚无记录”）。

const pages: LivePages = { AdsRuleDetailPage: { load: () => import('./AdsRuleDetailPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/rules/r-1'
const open = async () => within(await screen.findByTestId('ads-rule-detail'))

describe('自动规则详情页：内容与质量', () => {
  it('规则内容、命中率、采纳率；没有已执行的动作时效果写“尚未接入”和原因', async () => {
    mountApp({ url, pages, handlers: detailHandlers() })
    const page = await open()
    expect(await page.findByRole('heading', { name: '高 ACoS 活动暂停' })).toBeInTheDocument()
    expect(page.getByTestId('rule-execution-note')).toHaveTextContent('自动规则执行')
    const quality = within(await page.findByTestId('rule-quality'))
    expect(quality.getByText('25.0%')).toBeInTheDocument()
    expect(quality.getByText(/评估 12 个，命中 3 个/)).toBeInTheDocument()
    expect(quality.getByText('66.7%')).toBeInTheDocument()
    expect(quality.getByText(/处理中 1，已处理 2，无需处理 1，误报 0/)).toBeInTheDocument()
    expect(quality.getByText('尚未接入')).toBeInTheDocument()
    expect(quality.getByText(/还没有已执行的动作/)).toBeInTheDocument()
  })

  it('没有评估过也没有记录：写“尚未评估”“尚无记录”，不写 0%', async () => {
    const quality = qualityOf({
      lastScan: { at: null, evaluated: null, matched: null, hitRate: null },
      recent: { runs: 0, suggested: 0, applied: 0, skipped: 0, failed: 0, objects: 0 },
      adoption: { state: 'OK', open: 0, handled: 0, notNeeded: 0, falsePositive: 0, adoptionRate: null },
    })
    mountApp({ url, pages, handlers: detailHandlers(() => detailResponse({ quality })) })
    const block = within(await (await open()).findByTestId('rule-quality'))
    expect(block.getByText('尚未评估')).toBeInTheDocument()
    expect(block.getAllByText('尚无记录').length).toBeGreaterThanOrEqual(3)
    expect(block.queryByText('0.0%')).toBeNull()
  })

  it('有执行后的效果：列出前后各 7 天的对照', async () => {
    const quality = qualityOf({
      effect: {
        state: 'OK',
        note: null,
        samples: 2,
        windowDays: 7,
        before: { spend: 100, sales: 200, orders: 8, clicks: 90, acos: 50 },
        after: { spend: 60, sales: 180, orders: 7, clicks: 50, acos: 33.3 },
      },
    })
    mountApp({ url, pages, handlers: detailHandlers(() => detailResponse({ quality })) })
    const block = within(await (await open()).findByTestId('rule-quality'))
    const spend = (await block.findByText('花费')).closest('tr, [role=row]') as HTMLElement
    expect(spend).toHaveTextContent('$100.00')
    expect(spend).toHaveTextContent('$60.00')
    const acos = block.getByText('广告成本销售比').closest('tr, [role=row]') as HTMLElement
    expect(acos).toHaveTextContent('50.0%')
    expect(acos).toHaveTextContent('33.3%')
    expect(block.getByText(/统计了 2 次已执行的动作/)).toBeInTheDocument()
  })

  it('读取失败：显示错误', async () => {
    mountApp({ url, pages, handlers: { '/ads/rules/r-1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '自动规则不存在' } } }) } })
    expect((await screen.findAllByText(/自动规则不存在/)).length).toBeGreaterThan(0)
  })
})

describe('自动规则详情页：试运行', () => {
  const start = async () => {
    const page = await open()
    await userEvent.click(await page.findByRole('tab', { name: '试运行' }))
    return page
  }

  it('只读：显示截止日、评估与命中数、命中对象的指标与前后值、跳过原因、口径说明；带上选的截止日', async () => {
    const calls: Array<Record<string, any>> = []
    const run = (_url: URL, init?: RequestInit) => (calls.push(JSON.parse(String(init?.body ?? '{}'))), ok(dryRunResponse()))
    mountApp({ url, pages, handlers: detailHandlers(undefined, { '/ads/rules/r-1/dry-run': run }) })
    const page = await start()
    fireEvent.change(page.getByLabelText('评估截止日'), { target: { value: '2026-10-21' } })
    await userEvent.click(page.getByRole('button', { name: /^试运行$/ }))
    const result = within(await page.findByTestId('rule-dryrun-result'))
    expect(result.getByText(/评估截止 2026-10-22/)).toBeInTheDocument()
    expect(result.getByText(/评估 12 个对象，命中 2 个/)).toBeInTheDocument()
    const hit = result.getByText('春季推广').closest('tr, [role=row]') as HTMLElement
    expect(hit).toHaveTextContent('近 7 天广告成本销售比 55.5%')
    expect(hit).toHaveTextContent('启用中 → 已暂停')
    expect(hit).toHaveTextContent('$120.00')
    expect(result.getByText('夏季推广').closest('tr, [role=row]') as HTMLElement).toHaveTextContent('尚无记录')
    expect(result.getByText('已经是暂停状态')).toBeInTheDocument()
    expect(result.getByText(/试运行只读，不改任何数据/)).toBeInTheDocument()
    expect(calls).toEqual([{ asOf: '2026-10-21' }])
  })

  it('没有数据：写“尚无记录”和原因，不画命中表', async () => {
    const empty = dryRunResponse({ state: 'NO_DATA', note: '这个广告账户还没有日级指标', dataThrough: null, evaluated: 0, matched: 0, hits: [], skipped: [] })
    mountApp({ url, pages, handlers: detailHandlers(undefined, { '/ads/rules/r-1/dry-run': () => ok(empty) }) })
    const page = await start()
    await userEvent.click(page.getByRole('button', { name: /^试运行$/ }))
    const result = within(await page.findByTestId('rule-dryrun-result'))
    expect(result.getByText('尚无记录')).toBeInTheDocument()
    expect(result.getByText('这个广告账户还没有日级指标')).toBeInTheDocument()
    expect(result.queryByText('春季推广')).toBeNull()
  })

  it('截止日晚于昨天等被拒绝：显示服务端给的原因', async () => {
    const reject = () => ({ status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '评估截止日最晚是昨天' } } })
    mountApp({ url, pages, handlers: detailHandlers(undefined, { '/ads/rules/r-1/dry-run': reject }) })
    const page = await start()
    await userEvent.click(page.getByRole('button', { name: /^试运行$/ }))
    expect(await screen.findByText('评估截止日最晚是昨天')).toBeInTheDocument()
  })
})

describe('自动规则详情页：运行记录', () => {
  const start = async (handlers = detailHandlers()) => {
    mountApp({ url, pages, handlers })
    const page = await open()
    await userEvent.click(await page.findByRole('tab', { name: '运行记录' }))
    return within(await page.findByTestId('rule-runs'))
  }

  it('列出时间、对象、动作、前后、指标、结果与待办；没有待办或名称写“尚无记录”', async () => {
    const runs = await start()
    const first = (await runs.findByText('春季推广')).closest('tr, [role=row]') as HTMLElement
    expect(first).toHaveTextContent('暂停')
    expect(first).toHaveTextContent('启用中 → 已暂停')
    expect(first).toHaveTextContent('近 7 天广告成本销售比 55.5%')
    expect(first).toHaveTextContent('已生成待办')
    expect(first).toHaveTextContent('已生成')
    const second = runs.getByText('c-2').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('已跳过')
    expect(second).toHaveTextContent('尚无记录')
    expect(runs.getByText(/共约 2 条/)).toBeInTheDocument()
  })

  it('翻页：下一页带游标，上一页回到第一页', async () => {
    const cursors: Array<string | null> = []
    const handler = (u: URL) => {
      const cursor = u.searchParams.get('cursor')
      cursors.push(cursor)
      return ok(
        cursor
          ? runsResponse({ items: [runRow({ id: 'run-9', entityKey: 'c-9', entityLabel: '秋季推广' })] })
          : runsResponse({ pageInfo: { pageSize: 20, nextCursor: 'CUR-2', hasMore: true, approxTotal: 3 } }),
      )
    }
    const runs = await start(detailHandlers(undefined, { '/ads/rules/r-1/runs': handler }))
    await runs.findByText('春季推广')
    await userEvent.click(runs.getByRole('button', { name: '下一页' }))
    // 换页时先显示加载骨架，容器会重建，所以之后直接在整个页面里找
    expect(await screen.findByText('秋季推广')).toBeInTheDocument()
    expect(cursors).toContain('CUR-2')
    await userEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(await screen.findByText('春季推广')).toBeInTheDocument()
  })

  it('还没有记录：写明原因', async () => {
    const empty = () => ok(runsResponse({ items: [], pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 0 } }))
    const runs = await start(detailHandlers(undefined, { '/ads/rules/r-1/runs': empty }))
    expect(await runs.findByText(/还没有运行记录/)).toBeInTheDocument()
  })
})
