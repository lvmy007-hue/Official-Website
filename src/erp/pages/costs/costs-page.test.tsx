import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { costDetail, costList, costRow, ok, versionView } from './costs-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 商品成本页（P2b-14）：列表（各项成本、折合美元、到岸成本、覆盖状态）、筛选、没有数据的写法、写入口的权限与范围守卫；
// 详情（版本时间线与来源、被入库批次压过的价格版本、构成图、库存成本估算、版本对比入口）、草稿的确认生效、录入与导入。

const pages: LivePages = { CostsPage: { load: () => import('./CostsPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/costs': () => ok(costList()),
  '/costs/SKU-A': () => ok(costDetail()),
  ...over,
})

describe('商品成本列表', () => {
  it('每个 SKU 一行：各项成本与折合美元、到岸成本合计、覆盖状态；没有的项写“无”不写 0', { timeout: 30000 }, async () => {
    const cny = costRow({
      sku: 'SKU-C',
      title: null,
      coverage: 'STALE',
      parts: { product: { ...costRow().parts.product!, amount: '71.000000', currency: 'CNY', usd: null }, firstMile: null, duty: null, other: null },
      landedUsd: null,
      landedState: 'NO_FX',
    })
    mountApp({ url: '/app/costs', pages, handlers: handlers({ '/costs': () => ok(costList([costRow(), cny])) }) })
    const row = (await screen.findByText('SKU-A', {}, { timeout: 15000 })).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('示例商品 A')).toBeInTheDocument()
    expect(within(row).getByText('已覆盖')).toBeInTheDocument()
    expect(within(row).getByText('$11.50')).toBeInTheDocument()
    expect(within(row).getAllByText('无').length).toBeGreaterThanOrEqual(2)
    expect(within(row).getByText('10')).toBeInTheDocument()
    expect(within(row).getByText('1.5')).toBeInTheDocument()
    const other = screen.getByText('SKU-C').closest('tr, [role=row]') as HTMLElement
    expect(within(other).getByText('成本过期')).toBeInTheDocument()
    expect(within(other).getAllByText('缺汇率').length).toBeGreaterThanOrEqual(2)
    expect(within(other).getByText('没有同步到商品信息')).toBeInTheDocument()
    expect(screen.getByTestId('cost-summary')).toHaveTextContent('缺成本 2')
  })

  it('没有商品也没有成本：写原因，不是空白', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/costs', pages, handlers: handlers({ '/costs': () => ok(costList([], { note: '尚无记录：还没有商品，也没有成本版本。同步商品后会在这里出现，也可以先录入或导入成本。' })) }) })
    expect(await screen.findByText(/尚无记录：还没有商品/, {}, { timeout: 15000 })).toBeInTheDocument()
  })

  it('点覆盖状态与“只看待确认草稿”会带上筛选参数并回到第一页', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/costs', pages, handlers: handlers() })
    await screen.findByText('SKU-A', {}, { timeout: 15000 })
    await userEvent.click(screen.getByText('缺成本 2'))
    await waitFor(() => expect(app.calls.some(call => call.path === '/costs' && call.search.includes('coverage=MISSING'))).toBe(true))
    await userEvent.click(screen.getByRole('checkbox', { name: '只看有待确认草稿的' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/costs' && call.search.includes('draft=true'))).toBe(true))
  })

  it('写入口：没有 costs.write 或没有“全部店铺”范围时按钮禁用', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/costs', pages, handlers: handlers({}, ['costs.read', 'field.cost']) })
    await screen.findByText('SKU-A', {}, { timeout: 15000 })
    expect(screen.getByRole('button', { name: '录入成本' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导入成本文件' })).toBeDisabled()
    mountApp({ url: '/app/costs', pages, handlers: handlers({ '/costs': () => ok(costList([costRow()], { canWrite: false })) }) })
    await waitFor(() => expect(screen.getAllByRole('button', { name: '录入成本' }).some(button => (button as HTMLButtonElement).disabled)).toBe(true))
  })

  it('加载失败：显示错误与重试，不是空白', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/costs',
      pages,
      handlers: handlers({ '/costs': () => ({ status: 403, body: { success: false, error: { code: 'TENANT_ACCESS_DENIED', message: '商品成本需要成本字段权限（field.cost）' } } }) }),
    })
    expect((await screen.findAllByText(/权限/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
  })
})

describe('商品成本详情', () => {
  const open = async (over: Record<string, Handler> = {}) => {
    const app = mountApp({ url: '/app/costs', pages, handlers: handlers(over) })
    await userEvent.click(await screen.findByRole('button', { name: 'SKU-A' }, { timeout: 15000 }))
    await screen.findByTestId('cost-versions', {}, { timeout: 15000 })
    return app
  }

  it('版本时间线：来源与单号、状态、被替换与被入库批次压过的说明；构成图与库存成本估算', { timeout: 30000 }, async () => {
    const versions = costDetail().versions.map(item => (item.id === 'cv3' ? { ...item, ignoredComponents: ['product' as const] } : item))
    await open({ '/costs/SKU-A': () => ok(costDetail({ versions })) })
    const timeline = screen.getByTestId('cost-versions')
    const batch = within(timeline).getByText('PO-2026-001').closest('tr, [role=row]') as HTMLElement
    expect(within(batch).getByText('采购收货')).toBeInTheDocument()
    expect(within(batch).getByText('40')).toBeInTheDocument()
    const replaced = within(timeline).getByText('已替换').closest('tr, [role=row]') as HTMLElement
    expect(within(replaced).getByText('被第 3 版替换')).toBeInTheDocument()
    expect(within(timeline).getByText(/采购单价已被入库批次压过，不参与计价/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '当前各项成本折合美元的构成' })).toBeInTheDocument()
    const valuation = screen.getByTestId('cost-valuation')
    expect(within(valuation).getByText('先进先出')).toBeInTheDocument()
    expect(within(valuation).getByText('$450.00')).toBeInTheDocument()
    expect(within(valuation).getByText(/估算值/)).toBeInTheDocument()
    expect(screen.getByTestId('cost-compare')).toBeInTheDocument()
    expect(screen.getByText('关税目前只在这里记录与折算。')).toBeInTheDocument()
  })

  it('没有库存报告：写“尚无库存报告”，不写 0 件', { timeout: 30000 }, async () => {
    const valuation = {
      ...costDetail().valuation,
      state: 'NO_STOCK_DATA' as const,
      onHandUnits: null,
      valueUsd: null,
      avgUnitUsd: null,
      note: '还没有库存规划报告，不知道现有库存件数，无法估算库存成本',
    }
    await open({ '/costs/SKU-A': () => ok(costDetail({ valuation })) })
    expect(within(screen.getByTestId('cost-valuation')).getAllByText('尚无库存报告').length).toBeGreaterThanOrEqual(2)
  })

  it('草稿：可以修改、丢弃、确认生效；确认时说明会替换哪一版；提交带版本号', { timeout: 30000 }, async () => {
    let body: { items: Array<{ id: string; version: number }> } | undefined
    await open({
      '/costs/activate': (_url, init) => {
        body = JSON.parse(String(init?.body))
        return { status: 201, body: { success: true, data: { activated: 1, replaced: 1, versions: [], message: '已确认' } } }
      },
    })
    const draft = within(screen.getByTestId('cost-versions')).getByText('草稿').closest('tr, [role=row]') as HTMLElement
    expect(within(draft).getByRole('button', { name: /修\s?改/ })).toBeEnabled()
    expect(within(draft).getByRole('button', { name: /丢\s?弃/ })).toBeEnabled()
    await userEvent.click(within(draft).getByRole('button', { name: '确认生效' }))
    const dialog = (await screen.findByText(/生效后会替换第 3 版/)).closest('[role="dialog"]') as HTMLElement
    expect(within(dialog).getByText(/确认 SKU-A 第 4 版生效/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '确认生效' }))
    expect(await screen.findByText('已确认生效')).toBeInTheDocument()
    expect(body).toEqual({ items: [{ id: 'cv4', version: 1 }] })
  })

  it('草稿不能生效（落在已关账期间）：按钮禁用；系统生成的草稿没有“丢弃”', { timeout: 30000 }, async () => {
    const blocked = versionView({
      id: 'cv5',
      versionNo: 5,
      status: 'DRAFT',
      statusLabel: '草稿',
      version: 1,
      source: 'FIRST_MILE_ALLOCATION',
      sourceLabel: '头程分摊',
      editable: 'LIMITED',
      canDiscard: false,
      blockedReason: '生效日 2026-09-10 落在已关账的期间（美国主店 2026-09）',
    })
    await open({ '/costs/SKU-A': () => ok(costDetail({ versions: [blocked] })) })
    const row = within(screen.getByTestId('cost-versions')).getByText('第 5 版').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: '确认生效' })).toBeDisabled()
    expect(within(row).queryByRole('button', { name: /丢\s?弃/ })).toBeNull()
    expect(within(row).getByText(/已关账的期间/)).toBeInTheDocument()
  })

  it('SKU 不在数据范围内：显示不存在，不是空白', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/costs',
      pages,
      handlers: handlers({ '/costs/SKU-A': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '没有这个 SKU，或不在你的数据范围内' } } }) }),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'SKU-A' }, { timeout: 15000 }))
    expect(await screen.findByText(/不在你的数据范围内|不存在/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('录入与导入', () => {
  it('录入：校验必填；提交只带填了的成本项，币种转大写；服务端字段错误回填', { timeout: 30000 }, async () => {
    let body: Record<string, unknown> | undefined
    let reject = true
    mountApp({
      url: '/app/costs',
      pages,
      handlers: handlers({
        '/costs': (_url, init) => {
          if (init?.method !== 'POST') return ok(costList())
          body = JSON.parse(String(init.body))
          if (reject) return { status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '请求参数校验失败', fieldErrors: { sku: ['SKU “X1” 不存在：请先同步商品，或检查拼写'] } } } }
          return { status: 201, body: { success: true, data: { id: 'cv9', version: 1, versionNo: 5, status: 'DRAFT', message: '已新建' } } }
        },
      }),
    })
    await screen.findByText('SKU-A', {}, { timeout: 15000 })
    await userEvent.click(await screen.findByRole('button', { name: '录入成本' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }))
    expect(await within(dialog).findByText('请填写 SKU')).toBeInTheDocument()
    expect(body).toBeUndefined()

    await userEvent.type(within(dialog).getByLabelText('SKU'), 'X1')
    await userEvent.clear(within(dialog).getByLabelText('币种'))
    await userEvent.type(within(dialog).getByLabelText('币种'), 'cny')
    await userEvent.type(within(dialog).getByLabelText('采购单价'), '71.5')
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }))
    expect(await within(dialog).findByText(/SKU “X1” 不存在/)).toBeInTheDocument()
    expect(body).toMatchObject({ sku: 'X1', currency: 'CNY', unitProductCost: 71.5, effectiveFrom: '2026-10-23', activate: false })
    expect(body).not.toHaveProperty('unitDutyCost', 0)

    reject = false
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }))
    expect(await screen.findByText('已保存成本版本')).toBeInTheDocument()
  })

  it('导入：读出 CSV 文本连同文件名提交；服务端逐行拒绝时错误显示在文件下面', { timeout: 30000 }, async () => {
    let body: Record<string, unknown> | undefined
    let reject = true
    mountApp({
      url: '/app/costs',
      pages,
      handlers: handlers({
        '/costs/import': (_url, init) => {
          body = JSON.parse(String(init?.body))
          if (reject)
            return {
              status: 422,
              body: { error: { code: 'VALIDATION_FAILED', message: '文件内容有误，没有导入任何数据', fieldErrors: { content: ['第 3 行：生效日期“2026-13-01”格式应为 YYYY-MM-DD'] } } },
            }
          return { status: 201, body: { success: true, data: { batchId: 'IMPabc', imported: 1, skus: 1, fileName: 'c.csv', message: '已导入' } } }
        },
      }),
    })
    await screen.findByText('SKU-A', {}, { timeout: 15000 })
    await userEvent.click(await screen.findByRole('button', { name: '导入成本文件' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '导 入' }))
    expect(await within(dialog).findByText('请选择文件')).toBeInTheDocument()
    expect(body).toBeUndefined()
    const csv = 'SKU,生效日期,币种,采购单价\nSKU-A,2026-10-01,USD,9\n'
    await userEvent.upload(within(dialog).getByLabelText('成本文件'), new File([csv], 'c.csv', { type: 'text/csv' }))
    expect(await within(dialog).findByText(/已读取 c\.csv/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '导 入' }))
    expect(await within(dialog).findByText(/第 3 行：生效日期/)).toBeInTheDocument()
    expect(body).toEqual({ fileName: 'c.csv', content: csv })
    reject = false
    await userEvent.click(within(dialog).getByRole('button', { name: '导 入' }))
    expect(await screen.findByText('已导入成本草稿')).toBeInTheDocument()
  })
})
