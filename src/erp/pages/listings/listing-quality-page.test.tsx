import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { parseBatchLines } from './ListingBulkActions'
import { changeRow, inactiveRow, issueRow, ok, qualityHandlers, qualityResponse, restrictionRow, runView, writeOk } from './listing-quality-fixtures.test-helper'

// 刊登质量与合规（P4-10）：假服务端返回固定数据，验证七个页签、没有数据写“尚无记录 / 尚未接入”（不写 0）、
// 估算带标签、写入按钮按服务端的权限 → 连接 → 开关判断禁用并写明原因、修复要先校验预览再提交、批量与限制查询的请求内容。

const pages: LivePages = { ListingQualityPage: { load: () => import('./ListingQualityPage') } }
const url = '/app/listings/quality'
afterEach(() => vi.unstubAllGlobals())
const FIX = /^修\s?复$/

const open = async (response = () => qualityResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url, pages, me, handlers: qualityHandlers(response, extra) })
  const page = within(await screen.findByTestId('listing-quality-page'))
  await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
  return { app, page }
}
const calls = (app: { calls: Array<{ path: string; search: string; method: string }> }, path: string, method = 'GET') => app.calls.filter(call => call.path === path && call.method === method)

describe('刊登质量：问题列表', () => {
  it('问题行：标题链到商品、严重程度、影响、状态、负责人；估算销售额带“估算”标签；没有销售记录写“尚无记录”', async () => {
    const { page } = await open()
    const first = page.getByText('玻璃保鲜盒套装').closest('tr, [role=row]') as HTMLElement
    expect(within(first).getByRole('link', { name: '玻璃保鲜盒套装' })).toHaveAttribute('href', '/app/products/p1')
    expect(first).toHaveTextContent('B0TEST0001 · SKU-1')
    expect(first).toHaveTextContent('缺少必填属性：颜色')
    expect(first).toHaveTextContent('新增')
    expect(first).toHaveTextContent('林然')
    expect(first).toHaveTextContent('-$120.00')
    expect(within(first).getByText('模型估算')).toBeInTheDocument()
    const second = page.getByText('没有销售记录的商品').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('尚无记录')
    expect(second).toHaveTextContent('未指定')
    expect(second).toHaveTextContent('处理中')
  })

  it('页签带条数；顶部统计显示新增、解决、平均解决时长', async () => {
    const { page } = await open()
    expect(page.getByRole('tab', { name: '问题项（2）' })).toBeInTheDocument()
    expect(page.getByRole('tab', { name: '非活跃刊登（3）' })).toBeInTheDocument()
    const stats = within(page.getByTestId('listing-quality-stats'))
    expect(stats.getByText('30.0 小时')).toBeInTheDocument()
    expect(stats.getByText('错误 1 · 警告 1')).toBeInTheDocument()
  })

  it('还没接入：页签与统计写“尚无记录”而不是 0，推送写“尚未接入”并说明原因', async () => {
    const { page } = await open(() =>
      qualityResponse({
        state: 'NOT_CONNECTED',
        note: '还没有同步到刊登数据：连接店铺并完成“商品刊登”授权后，每日同步会读取刊登问题与状态',
        counts: { issues: 0, suppressed: 0, restrictions: 0, missing: 0, productType: 0, otherEdits: 0, inactive: 0 },
        sources: [
          { key: 'listings.items-v2021', label: '刊登接口（每日同步）', state: 'NOT_CONNECTED', note: '还没有成功同步过刊登，需要“商品刊登”授权' },
          { key: 'notifications', label: '亚马逊推送（实时）', state: 'NOT_CONNECTED', note: '推送接收端暂缓接入，没有实时事件；以每日同步为准' },
        ],
      }),
    )
    expect(page.getByRole('tab', { name: '问题项（尚无记录）' })).toBeInTheDocument()
    expect(within(page.getByTestId('listing-quality-stats')).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(4)
    expect(page.getByText(/还没有同步到刊登数据/)).toBeInTheDocument()
    expect(within(page.getByTestId('listing-quality-sources')).getAllByText('尚未接入')).toHaveLength(2)
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({
      url,
      pages,
      handlers: { '/listings/quality': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }), '/listings/runs': () => ok({ items: [], truncated: false }) },
    })
    await screen.findByTestId('listing-quality-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('玻璃保鲜盒套装')).toBeNull()
  }, 30_000)
})

describe('刊登质量：页签与筛选', () => {
  it('切换页签与筛选条件随请求带出，并回到第一页', async () => {
    const { app, page } = await open()
    fireEvent.click(page.getByRole('tab', { name: /被搜索抑制/ }))
    await waitFor(() => expect(calls(app, '/listings/quality').some(call => new URLSearchParams(call.search).get('tab') === 'suppressed')).toBe(true))
    await userEvent.click(page.getByRole('combobox', { name: '严重程度' }))
    await userEvent.click(await screen.findByText('错误', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(calls(app, '/listings/quality').some(call => new URLSearchParams(call.search).get('severity') === 'ERROR')).toBe(true))
  })

  it('商品类型变更、他人内容修改页签：显示变更前后与来源', async () => {
    const byTab = (url: URL) => ok(url.searchParams.get('tab') === 'otherEdits' ? qualityResponse({ tab: 'otherEdits', issueRows: [], changeRows: [changeRow()] }) : qualityResponse())
    const { page } = await open(() => qualityResponse(), { '/listings/quality': byTab })
    fireEvent.click(page.getByRole('tab', { name: /他人内容修改/ }))
    const row = (await page.findByText('旧标题')).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('新标题')
    expect(row).toHaveTextContent('未知（非本系统）')
  })

  it('非活跃刊登：目录里没有的商品写明，没有状态写“不可售也不可被发现”', async () => {
    mountApp({ url, pages, handlers: qualityHandlers(() => qualityResponse({ tab: 'inactive', issueRows: [], inactiveRows: [inactiveRow()] })) })
    const page = within(await screen.findByTestId('listing-quality-page'))
    fireEvent.click(await page.findByRole('tab', { name: /非活跃刊登/ }))
    expect(await page.findByText('（商品目录里没有这个商品）')).toBeInTheDocument()
    expect(page.getByText('不可售也不可被发现')).toBeInTheDocument()
    expect(page.getByText('53 天')).toBeInTheDocument()
  })

  it('刊登限制页签：显示结论、原因与处理入口', async () => {
    mountApp({ url, pages, handlers: qualityHandlers(() => qualityResponse({ tab: 'restrictions', issueRows: [], restrictionRows: [restrictionRow()] })) })
    const page = within(await screen.findByTestId('listing-quality-page'))
    fireEvent.click(await page.findByRole('tab', { name: /刊登限制/ }))
    expect(await page.findByText('需要亚马逊审核')).toBeInTheDocument()
    expect(page.getByRole('link', { name: '去亚马逊处理' })).toHaveAttribute('href', 'https://sellercentral.amazon.com/apply')
  })
})

describe('刊登质量：写入按钮的守卫', () => {
  it('没有 listing.write：修复、批量、检查限制都禁用', async () => {
    const { page } = await open(() => qualityResponse(), {}, { ...defaultMe, permissions: ['listing.read'] })
    expect(page.getAllByRole('button', { name: FIX })[0]).toBeDisabled()
    expect(page.getByRole('button', { name: '批量修改' })).toBeDisabled()
    expect(page.getByRole('button', { name: '检查刊登限制' })).toBeDisabled()
  })

  it('批量开关未开启：只有批量修改禁用并给出前往开启的入口，修复与检查限制照常', async () => {
    const batch = { allowed: false, step: 'SWITCH' as const, reason: '该类写入的开关未开启', remedyPath: '/app/settings/integrations' }
    const { page } = await open(() => qualityResponse({ write: { ...writeOk, batch } }))
    expect(page.getByRole('button', { name: '批量修改' })).toBeDisabled()
    expect(page.getByRole('link', { name: '前往开启' })).toBeInTheDocument()
    expect(page.getByRole('button', { name: '检查刊登限制' })).toBeEnabled()
    expect(page.getAllByRole('button', { name: FIX })[0]).toBeEnabled()
  })

  it('已解决的问题没有“修复”按钮', async () => {
    const { page } = await open(() => qualityResponse({ issueRows: [issueRow({ status: 'RESOLVED', resolvedAt: '2026-10-23T00:00:00Z' })] }))
    expect(page.queryByRole('button', { name: FIX })).toBeNull()
  })
})

describe('刊登质量：修复（校验预览 → 提交修改）', () => {
  const flow = (preview = runView()) => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
    const extra: Record<string, Handler> = {
      '/listings/validate': (_url, init) => {
        bodies.push({ path: '/listings/validate', body: JSON.parse(String(init?.body)) })
        return ok({ run: runView({ status: 'PENDING', statusLabel: '排队中', validation: null, usableUntil: null }), state: 'QUEUED' })
      },
      '/listings/runs/r1': () => ok(preview),
      '/listings/patch': (_url, init) => {
        bodies.push({ path: '/listings/patch', body: JSON.parse(String(init?.body)) })
        return ok({
          run: runView({ id: 'r2', kind: 'PATCH', kindLabel: '修改刊登', status: 'PENDING', statusLabel: '排队中', validation: null, usableUntil: null, previewRunId: 'r1' }),
          state: 'QUEUED',
        })
      },
      '/listings/runs/r2': () => ok(runView({ id: 'r2', kind: 'PATCH', kindLabel: '修改刊登', status: 'SUCCEEDED', statusLabel: '已完成', validation: null, usableUntil: null })),
    }
    return { bodies, extra }
  }
  const fill = async (value = 'Blue') => {
    fireEvent.click(screen.getAllByRole('button', { name: FIX })[0]!)
    const drawer = within(await screen.findByTestId('listing-fix-drawer'))
    await userEvent.type(drawer.getByRole('textbox', { name: '新的取值' }), value)
    return drawer
  }

  it('校验通过后才出现“提交修改”；请求带上预览编号与修改内容；结果显示在抽屉里', async () => {
    const { bodies, extra } = flow()
    const { page } = await open(() => qualityResponse(), extra)
    expect(page).toBeTruthy()
    const drawer = await fill()
    expect(drawer.queryByRole('button', { name: '提交修改' })).toBeNull()
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByText('校验通过')).toBeInTheDocument()
    expect(bodies[0]).toMatchObject({ path: '/listings/validate', body: { storeId: 'st1', sku: 'SKU-1', patches: [{ op: 'replace', attribute: 'color', values: ['Blue'] }] } })
    await userEvent.click(await drawer.findByRole('button', { name: '提交修改' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(bodies.some(entry => entry.path === '/listings/patch')).toBe(true))
    expect(bodies.find(entry => entry.path === '/listings/patch')?.body).toMatchObject({ storeId: 'st1', sku: 'SKU-1', previewRunId: 'r1', patches: [{ attribute: 'color', values: ['Blue'] }] })
    expect(await drawer.findByText('修改结果')).toBeInTheDocument()
  })

  it('校验没通过：显示亚马逊给的问题，没有“提交修改”', async () => {
    const { extra } = flow(runView({ validation: 'INVALID', usableUntil: null, issues: [{ code: '90220', severity: 'ERROR', message: '颜色取值不在允许的列表里', attributeNames: ['color'] }] }))
    await open(() => qualityResponse(), extra)
    const drawer = await fill('Pinkish')
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByText('校验未通过')).toBeInTheDocument()
    expect(drawer.getByText(/颜色取值不在允许的列表里/)).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '提交修改' })).toBeNull()
  })

  it('改了内容就要重新校验：已出现的“提交修改”随之消失', async () => {
    const { extra } = flow()
    await open(() => qualityResponse(), extra)
    const drawer = await fill()
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    await drawer.findByRole('button', { name: '提交修改' })
    await userEvent.type(drawer.getByRole('textbox', { name: '新的取值' }), ' 2')
    await waitFor(() => expect(drawer.queryByRole('button', { name: '提交修改' })).toBeNull())
  })

  it('改价格、库存或配送属性：在页面就被拦住，不发请求', async () => {
    const { bodies, extra } = flow()
    await open(() => qualityResponse(), extra)
    fireEvent.click(screen.getAllByRole('button', { name: FIX })[0]!)
    const drawer = within(await screen.findByTestId('listing-fix-drawer'))
    await userEvent.clear(drawer.getByRole('textbox', { name: '属性名' }))
    await userEvent.type(drawer.getByRole('textbox', { name: '属性名' }), 'list_price')
    await userEvent.type(drawer.getByRole('textbox', { name: '新的取值' }), '9.99')
    expect(await drawer.findByText(/属于价格、库存或配送/)).toBeInTheDocument()
    expect(drawer.getByRole('button', { name: '校验预览' })).toBeDisabled()
    expect(bodies).toHaveLength(0)
  })

  it('修改开关未开启：校验可以做，“提交修改”禁用并写明原因', async () => {
    const { extra } = flow()
    const update = { allowed: false, step: 'SWITCH' as const, reason: '该类写入的开关未开启', remedyPath: '/app/settings/integrations' }
    await open(() => qualityResponse({ write: { ...writeOk, update } }), extra)
    const drawer = await fill()
    await userEvent.click(drawer.getByRole('button', { name: '校验预览' }))
    expect(await drawer.findByRole('button', { name: '提交修改' })).toBeDisabled()
  })
})

describe('刊登质量：批量修改与刊登限制查询', () => {
  it('批量：每行 SKU,属性,取值，同一 SKU 合并；请求体按商品分组', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const extra: Record<string, Handler> = {
      '/listings/batch': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok({ run: runView({ id: 'r5', kind: 'BATCH', kindLabel: '批量刊登任务', status: 'PENDING', statusLabel: '排队中', sku: null, itemCount: 2 }), state: 'QUEUED' })
      },
    }
    mountApp({ url, pages, handlers: qualityHandlers(() => qualityResponse({ stores: [{ id: 'st1', name: 'Northstar US' }] }), extra) })
    const page = within(await screen.findByTestId('listing-quality-page'))
    await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
    fireEvent.click(page.getByRole('button', { name: '批量修改' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByRole('textbox', { name: '修改内容' }), 'SKU-1,item_name,新标题{enter}SKU-1,color,Blue{enter}SKU-2,color,Red')
    await userEvent.click(dialog.getByRole('button', { name: '提 交' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      storeId: 'st1',
      items: [
        {
          sku: 'SKU-1',
          patches: [
            { op: 'replace', attribute: 'item_name', values: ['新标题'] },
            { op: 'replace', attribute: 'color', values: ['Blue'] },
          ],
        },
        { sku: 'SKU-2', patches: [{ op: 'replace', attribute: 'color', values: ['Red'] }] },
      ],
    })
  })

  it('刊登限制：ASIN 去掉分隔符后提交，带商品状况', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const extra: Record<string, Handler> = {
      '/listings/restrictions': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok({ run: runView({ id: 'r6', kind: 'RESTRICTIONS', kindLabel: '刊登限制查询', status: 'PENDING', statusLabel: '排队中', sku: null, itemCount: 2 }), state: 'QUEUED' })
      },
    }
    mountApp({ url, pages, handlers: qualityHandlers(() => qualityResponse({ stores: [{ id: 'st1', name: 'Northstar US' }] }), extra) })
    const page = within(await screen.findByTestId('listing-quality-page'))
    await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
    fireEvent.click(page.getByRole('button', { name: '检查刊登限制' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByRole('textbox', { name: 'ASIN' }), 'B0AAAAAAAA, B0BBBBBBBB')
    await userEvent.click(dialog.getByRole('button', { name: '查 询' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ storeId: 'st1', asins: ['B0AAAAAAAA', 'B0BBBBBBBB'], conditionType: 'new_new' })
  })

  it('批量内容格式不对时给出行号', () => {
    expect(parseBatchLines('SKU-1,item_name').problem).toMatch(/第 1 行格式不对/)
    expect(parseBatchLines('SKU-1,item_name,标题\nSKU-2,list_price,9.99').problem).toMatch(/第 2 行：.*价格/)
    expect(parseBatchLines('').problem).toMatch(/至少填写一行/)
    expect(parseBatchLines('SKU-1,item_name,a,b').items[0]?.patches[0]).toMatchObject({ values: ['a,b'] })
  })
})

describe('刊登质量：操作记录', () => {
  it('记录列表显示类型、对象与状态；展开看到结果，批量任务显示逐个商品的结果', async () => {
    const batch = runView({
      id: 'r7',
      kind: 'BATCH',
      kindLabel: '批量刊登任务',
      sku: null,
      itemCount: 2,
      status: 'PARTIAL',
      statusLabel: '部分通过',
      validation: null,
      usableUntil: null,
      summary: { accepted: 1, invalid: 1 },
      rows: [
        { sku: 'SKU-1', ok: true, issues: [] },
        { sku: 'SKU-2', ok: false, issues: [{ code: '1', severity: 'ERROR', message: '标题太长', attributeNames: ['item_name'] }] },
      ],
    })
    const { page } = await open(() => qualityResponse(), { '/listings/runs': () => ok({ items: [batch], truncated: false }) })
    const runs = within(page.getByTestId('listing-runs'))
    expect(await runs.findByText('批量刊登任务')).toBeInTheDocument()
    expect(runs.getByText('部分通过')).toBeInTheDocument()
    fireEvent.click(runs.getByText('批量刊登任务'))
    expect(await screen.findByText(/亚马逊已接受 1 个，未通过 1 个/)).toBeInTheDocument()
    expect(await screen.findByText(/标题太长/)).toBeInTheDocument()
  })

  it('没有任何记录写“尚无记录”', async () => {
    const { page } = await open()
    expect(await within(page.getByTestId('listing-runs')).findByText(/校验、修改刊登、批量任务与刊登限制查询/)).toBeInTheDocument()
  })
})
