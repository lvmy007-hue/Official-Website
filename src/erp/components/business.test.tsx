import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../api'
import { defaultMe, defaultScopeOptions, jsonResponse } from '../test/app-harness'
import { renderWithApp } from '../test/render'
import type { Me } from '../session/session'
import { ScopeProvider } from '../scope/context'
import { PageHeader } from './page/PageHeader'
import { FreshnessBar, scopeSummary } from './page/FreshnessBar'
import { evaluateGuard } from './action/guard'
import { ActionGuard } from './action/ActionGuard'
import { Delta, MetricCard, MetricStrip } from './metric/MetricCard'
import { DetailLayout } from './detail/DetailLayout'
import { ObjectLink } from './detail/ObjectLink'
import { CommentThread, WatchButton, extractMentions } from './detail/Collaboration'

afterEach(() => vi.unstubAllGlobals())

const limitedMe = (permissions: string[]): Me => ({ ...defaultMe, permissions })

describe('页头与数据新鲜度条', () => {
  it('页头：标题、一句话说明、主动作', () => {
    renderWithApp(<PageHeader title="订单" description="按店铺查看订单" actions={<button>新建</button>} />)
    expect(screen.getByRole('heading', { name: '订单' })).toBeInTheDocument()
    expect(screen.getByText('按店铺查看订单')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
  })

  it('范围摘要：未选为“全部”，选了显示名称，超过两个折叠', () => {
    const options = defaultScopeOptions
    expect(scopeSummary({}, options)).toEqual({ entities: '全部主体', stores: '全部店铺' })
    expect(scopeSummary({ storeIds: ['st1'] }, options).stores).toBe('Northstar US')
    expect(scopeSummary({ storeIds: ['st1', 'st2', 'st3'] }, options).stores).toBe('Northstar US、Oak & Pine 等 3 个')
  })

  it('数据新鲜度条：范围、时区、币种、最近同步、来源、质量提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { success: true, data: defaultScopeOptions })),
    )
    renderWithApp(
      <ScopeProvider scope={{ storeIds: ['st1'], from: '2026-10-01', to: '2026-10-07', displayCurrency: 'ORIGINAL' }}>
        <FreshnessBar freshness={{ lastSuccessAt: '2026-10-20T10:00:00Z', sources: ['订单报告', '库存接口'], qualityIssues: 2 }} />
      </ScopeProvider>,
    )
    const bar = screen.getByTestId('freshness-bar')
    await waitFor(() => expect(within(bar).getByText('店铺：Northstar US')).toBeInTheDocument())
    expect(within(bar).getByText('站点：美国站')).toBeInTheDocument()
    expect(within(bar).getByText('时间：2026-10-01 至 2026-10-07')).toBeInTheDocument()
    expect(within(bar).getByText('时区：America/Los_Angeles')).toBeInTheDocument()
    expect(within(bar).getByText('币种：原币')).toBeInTheDocument()
    expect(within(bar).getByText('最近成功同步：2026-10-20 03:00 PDT')).toBeInTheDocument()
    expect(within(bar).getByText('来源：订单报告、库存接口')).toBeInTheDocument()
    expect(within(bar).getByText('2 条数据质量提示')).toBeInTheDocument()
  })

  it('没有同步记录时如实说明，不编造时间', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { success: true, data: defaultScopeOptions })),
    )
    renderWithApp(<FreshnessBar />)
    expect(screen.getByText('尚无成功同步记录')).toBeInTheDocument()
    expect(screen.queryByText(/数据质量提示/)).toBeNull()
  })

  it('不传新鲜度时按范围读取 /freshness：最近成功时间、已有成功的来源、需关注的来源数', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        calls.push(String(input))
        if (String(input).includes('/freshness'))
          return jsonResponse(200, {
            success: true,
            data: {
              asOf: '2026-10-22T10:00:00Z',
              storeCount: 2,
              sources: [
                { label: '订单', status: 'NORMAL', lastSuccessAt: '2026-10-22T09:50:00Z' },
                { label: '库存', status: 'FAILED', lastSuccessAt: '2026-10-21T09:50:00Z' },
                { label: '财务交易', status: 'NO_RECORD', lastSuccessAt: null },
              ],
              summary: { completeness: 0.5, attention: 2 },
            },
          })
        return jsonResponse(200, { success: true, data: defaultScopeOptions })
      }),
    )
    renderWithApp(<FreshnessBar />)
    await waitFor(() => expect(screen.getByText('来源：订单、库存')).toBeInTheDocument())
    expect(screen.getByText('最近成功同步：2026-10-22 02:50 PDT')).toBeInTheDocument()
    expect(screen.getByText('2 条数据质量提示')).toBeInTheDocument()
    expect(calls.some(url => url.includes('/freshness'))).toBe(true)
  })

  it('传 null 表示页面没有同步来源：不读取 /freshness', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => (calls.push(String(input)), jsonResponse(200, { success: true, data: defaultScopeOptions }))),
    )
    renderWithApp(<FreshnessBar freshness={null} />)
    await screen.findByText('尚无成功同步记录')
    expect(calls.some(url => url.includes('/freshness'))).toBe(false)
  })

  it('读取 /freshness 失败：如实提示，不编造时间', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        String(input).includes('/freshness') ? jsonResponse(500, { error: { code: 'INTERNAL', message: '服务异常' } }) : jsonResponse(200, { success: true, data: defaultScopeOptions }),
      ),
    )
    renderWithApp(<FreshnessBar />)
    expect(await screen.findByText('同步状态暂时读取失败', undefined, { timeout: 5000 })).toBeInTheDocument()
  })

  it('近实时数据标注“实时估算，以日终数据为准”', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { success: true, data: defaultScopeOptions })),
    )
    renderWithApp(<FreshnessBar freshness={{ lastSuccessAt: null, sources: [], qualityIssues: 0, realtime: true }} />)
    expect(screen.getByText('实时估算，以日终数据为准')).toBeInTheDocument()
  })
})

describe('动作守卫：判断顺序 权限 → 连接 → 写入开关 → 数据条件', () => {
  const has = (granted: string[]) => (p: string) => granted.includes(p)

  it('全部满足才放行', () => {
    expect(evaluateGuard({ permission: 'a.write', connection: { ok: true }, writeSwitch: { enabled: true }, condition: { ok: true } }, has(['a.write']))).toEqual({ allowed: true })
  })

  it('同时多项不满足时，先报权限，不泄露后面的信息，也没有入口', () => {
    const verdict = evaluateGuard({ permission: 'a.write', connection: { ok: false }, writeSwitch: { enabled: false } }, has([]))
    expect(verdict).toMatchObject({ allowed: false, step: 'permission' })
    expect((verdict as { fix?: unknown }).fix).toBeUndefined()
  })

  it('连接不可用先于写入开关；有权限处理的人看到“前往处理”', () => {
    const input = {
      permission: 'a.write',
      connection: { ok: false, reason: '授权已过期', fix: { label: '前往处理', href: '/app/connections', requires: 'settings.integration.write' } },
      writeSwitch: { enabled: false },
    }
    expect(evaluateGuard(input, has(['a.write', 'settings.integration.write']))).toEqual({
      allowed: false,
      step: 'connection',
      reason: '授权已过期',
      fix: { label: '前往处理', href: '/app/connections' },
    })
    // 没有处理权限的人只看到原因，没有入口
    expect(evaluateGuard(input, has(['a.write']))).toMatchObject({ step: 'connection', fix: undefined })
  })

  it('写入开关未开：说明默认不会发出，并给“前往开启”', () => {
    const verdict = evaluateGuard({ writeSwitch: { enabled: false, fix: { label: '前往开启', href: '/app/settings' } } }, has([]))
    expect(verdict).toMatchObject({ step: 'write-switch', fix: { label: '前往开启', href: '/app/settings' } })
    expect((verdict as { reason: string }).reason).toMatch(/写入开关未开启/)
  })

  it('数据条件不满足：给出业务原因', () => {
    expect(evaluateGuard({ condition: { ok: false, reason: '计划已发货，不能取消' } }, has([]))).toMatchObject({ step: 'condition', reason: '计划已发货，不能取消' })
  })

  it('按钮：不满足时禁用且不会调用服务端', async () => {
    const onExecute = vi.fn(async () => undefined)
    renderWithApp(<ActionGuard label="提交计划" guard={{ permission: 'inbound.write' }} onExecute={onExecute} />, { me: limitedMe(['orders.read']) })
    const button = screen.getByRole('button', { name: '提交计划' })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('按钮：有权限时直接执行；服务端成功才提示成功', async () => {
    const onExecute = vi.fn(async () => undefined)
    const onDone = vi.fn()
    renderWithApp(<ActionGuard label="同步" guard={{ permission: 'sync.run' }} onExecute={onExecute} successText="同步已开始" onDone={onDone} />, { me: limitedMe(['sync.run']) })
    await userEvent.click(screen.getByRole('button', { name: /同\s*步/ }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('同步已开始')).toBeInTheDocument()
  })

  it('按钮：服务端失败时显示原因与请求编号，不提示成功', async () => {
    const onExecute = vi.fn(async () => {
      throw new ApiError(409, 'VERSION_CONFLICT', '数据已被他人修改', undefined, { requestId: 'req-77' })
    })
    renderWithApp(<ActionGuard label="保存修改" guard={{}} onExecute={onExecute} successText="已保存" />, { me: limitedMe([]) })
    await userEvent.click(screen.getByRole('button', { name: /保\s*存修改/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('数据已被他人修改（请求编号 req-77）')
    expect(screen.queryByText('已保存')).toBeNull()
  })

  it('需要预览的动作：先弹出预览，确认后才调服务端；取消不调', async () => {
    const onExecute = vi.fn(async () => undefined)
    renderWithApp(<ActionGuard label="修改价格" guard={{}} onExecute={onExecute} preview={{ title: '确认改价', content: <p>价格将从 $19.99 改为 $17.99</p>, confirmText: '确认改价' }} />, {
      me: limitedMe([]),
    })
    await userEvent.click(screen.getByRole('button', { name: '修改价格' }))
    expect(await screen.findByText('价格将从 $19.99 改为 $17.99')).toBeInTheDocument()
    expect(onExecute).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    expect(onExecute).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '修改价格' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认改价' }))
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1))
  })

  it('预览确认后服务端失败：弹层保持打开并显示原因', async () => {
    const onExecute = vi.fn(async () => {
      throw new ApiError(403, 'WRITE_DISABLED', '写入开关未开启')
    })
    renderWithApp(<ActionGuard label="修改价格" guard={{}} onExecute={onExecute} preview={{ title: '确认改价', content: <p>预览</p>, confirmText: '确认改价' }} />, { me: limitedMe([]) })
    await userEvent.click(screen.getByRole('button', { name: '修改价格' }))
    await userEvent.click(await screen.findByRole('button', { name: '确认改价' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('写入开关未开启')
    expect(screen.getByText('预览')).toBeInTheDocument()
  })
})

describe('指标卡', () => {
  it('金额带币种；同比环比按方向着色并带箭头；无可比数据显示“—”', () => {
    renderWithApp(
      <MetricStrip>
        <MetricCard label="销售额" value={12345.6} format="money" yoy={0.123} mom={null} />
        <MetricCard label="退款率" value={0.05} format="percent" yoy={0.2} goodWhen="down" />
      </MetricStrip>,
    )
    const cards = screen.getAllByTestId('metric-card')
    expect(within(cards[0]!).getByText('$12,345.60')).toBeInTheDocument()
    expect(within(cards[0]!).getByLabelText('同比：+12.3%')).toHaveClass('erp-tone-positive')
    expect(within(cards[0]!).getByLabelText('环比：无可比数据')).toBeInTheDocument()
    // 退款率上升是坏事
    expect(within(cards[1]!).getByLabelText('同比：+20.0%')).toHaveClass('erp-tone-negative')
  })

  it('数值缺失时显示“—”和原因，不显示追溯入口', () => {
    const onTrace = vi.fn()
    renderWithApp(<MetricCard label="广告花费" value={null} format="money" unavailableReason="广告尚未授权" onTrace={onTrace} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('广告尚未授权')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /追溯/ })).toBeNull()
  })

  it('有数值时可点“追溯”；悬停指标名显示口径', async () => {
    const onTrace = vi.fn()
    renderWithApp(<MetricCard label="净利润" value={100} format="money" onTrace={onTrace} definition={{ source: '结算报告', refresh: '每日', version: 'v3', formula: '收入 − 成本' }} />)
    await userEvent.click(screen.getByRole('button', { name: '追溯净利润' }))
    expect(onTrace).toHaveBeenCalled()
    await userEvent.hover(screen.getByText('净利润'))
    expect(await screen.findByText(/口径版本：v3/)).toBeInTheDocument()
    expect(screen.getByText('公式：收入 − 成本')).toBeInTheDocument()
  })

  it('目标对比：显示完成度，封顶 100%', () => {
    renderWithApp(<MetricCard label="销量" value={150} format="number" target={{ value: 100, label: '月目标' }} />)
    expect(screen.getByText(/月目标 100，完成 100%/)).toBeInTheDocument()
  })

  it('Delta：零变化不带箭头', () => {
    renderWithApp(<Delta label="同比" ratio={0} />)
    expect(screen.getByLabelText('同比：0.0%')).toBeInTheDocument()
  })
})

describe('详情布局', () => {
  const tabs = [
    { key: 'a', label: '概览', children: <div>概览内容</div> },
    { key: 'b', label: '趋势', children: <div>趋势内容</div> },
  ]
  const metric = (n: number) => ({ label: `指标${n}`, value: `${n}` })

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(200, { success: true, data: defaultScopeOptions })),
  )

  it('身份区：标题、状态标签、关键指标最多 6 个、主动作、关注按钮', () => {
    renderWithApp(
      <DetailLayout
        title="某商品"
        subtitle="B0TEST"
        statuses={[{ text: '在售', color: 'success' }]}
        metrics={[1, 2, 3, 4, 5, 6, 7].map(metric)}
        primaryActions={<button>调价</button>}
        watch={<button>关注</button>}
        tabs={tabs}
      />,
    )
    const identity = screen.getByTestId('identity')
    expect(within(identity).getByRole('heading', { name: '某商品' })).toBeInTheDocument()
    expect(within(identity).getByText('在售')).toBeInTheDocument()
    expect(within(identity).getByText('指标6')).toBeInTheDocument()
    expect(within(identity).queryByText('指标7')).toBeNull()
    expect(within(identity).getByRole('button', { name: '调价' })).toBeInTheDocument()
    expect(within(identity).getByRole('button', { name: '关注' })).toBeInTheDocument()
  })

  it('建议动作区：每条带规则、依据、预估影响、风险与执行入口；没有建议不显示该区', () => {
    const { rerender } = renderWithApp(<DetailLayout title="x" metrics={[metric(1)]} tabs={tabs} suggestions={[]} />)
    expect(screen.queryByTestId('suggestions')).toBeNull()
    rerender(
      <DetailLayout
        title="x"
        metrics={[metric(1)]}
        tabs={tabs}
        suggestions={[{ id: 's1', rule: '库存不足', evidence: '可售 12 件，日销 6 件', impact: '避免断货 3 至 5 天', risk: '补货周期可能延长', action: <button>去补货</button> }]}
      />,
    )
    const zone = screen.getByTestId('suggestions')
    expect(within(zone).getByText('库存不足')).toBeInTheDocument()
    expect(within(zone).getByText(/依据：可售 12 件/)).toBeInTheDocument()
    expect(within(zone).getByText(/预估影响：避免断货/)).toBeInTheDocument()
    expect(within(zone).getByText(/风险：补货周期/)).toBeInTheDocument()
    expect(within(zone).getByRole('button', { name: '去补货' })).toBeInTheDocument()
  })

  it('页签切换；右侧关联栏可折叠，没有 rail 时不显示', async () => {
    const { rerender } = renderWithApp(<DetailLayout title="x" metrics={[metric(1)]} tabs={tabs} />)
    expect(screen.queryByLabelText('关联信息')).toBeNull()
    expect(screen.getByText('概览内容')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '趋势' }))
    expect(await screen.findByText('趋势内容')).toBeInTheDocument()
    rerender(<DetailLayout title="x" metrics={[metric(1)]} tabs={tabs} rail={[{ key: 'r', title: '关联对象', children: <div>关联内容</div> }]} />)
    expect(screen.getByText('关联内容')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /收起关联栏/ }))
    expect(screen.queryByText('关联内容')).toBeNull()
  })
})

describe('对象悬停卡片', () => {
  it('没有摘要来源时只是普通链接；悬停才请求摘要', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, data: { title: '商品甲', stock: 12 } }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithApp(
      <ObjectLink
        label="商品甲"
        to="/app/products/p1"
        summaryPath="/products/p1/summary"
        renderSummary={(d: { title: string; stock: number }) => (
          <span>
            {d.title}，可售 {d.stock} 件
          </span>
        )}
      />,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.hover(screen.getByText('商品甲'))
    expect(await screen.findByText('商品甲，可售 12 件')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('摘要加载失败显示原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { error: { code: 'INTERNAL', message: '服务出错' } })),
    )
    renderWithApp(<ObjectLink label="商品乙" to="/app/products/p2" summaryPath="/products/p2/summary" renderSummary={() => <span>x</span>} />)
    await userEvent.hover(screen.getByText('商品乙'))
    expect(await screen.findByText(/摘要加载失败/, undefined, { timeout: 5000 })).toBeInTheDocument()
  }, 10000)
})

describe('评论与关注', () => {
  it('提取评论里被提到的成员', () => {
    const members = [
      { id: 'm1', name: '林然' },
      { id: 'm2', name: '周宁' },
    ]
    expect(extractMentions('@林然 请看，@林然 再看一下 @周宁', members).sort()).toEqual(['m1', 'm2'])
    expect(extractMentions('没有提到任何人', members)).toEqual([])
  })

  it('没有评论时说明；发表后清空输入；失败保留输入并提示', async () => {
    const onSubmit = vi.fn<(input: { body: string; mentions: string[] }) => Promise<void>>().mockRejectedValueOnce(new Error('评论保存失败')).mockResolvedValueOnce(undefined)
    renderWithApp(<CommentThread items={[]} members={[{ id: 'm1', name: '林然' }]} onSubmit={onSubmit} />)
    expect(screen.getByText(/还没有评论/)).toBeInTheDocument()
    const box = screen.getByLabelText('评论内容')
    const send = screen.getByRole('button', { name: /发\s*表/ })
    expect(send).toBeDisabled()
    await userEvent.type(box, '价格需要复核')
    await userEvent.click(send)
    expect(await screen.findByRole('alert')).toHaveTextContent('评论保存失败')
    expect(box).toHaveValue('价格需要复核')
    await userEvent.click(send)
    await waitFor(() => expect(box).toHaveValue(''))
    expect(onSubmit).toHaveBeenLastCalledWith({ body: '价格需要复核', mentions: [] })
  })

  it('列出已有评论的作者与内容', () => {
    renderWithApp(<CommentThread items={[{ id: 'c1', authorName: '周宁', body: '已确认', createdAt: '2026-10-20T10:00:00Z' }]} members={[]} onSubmit={async () => undefined} />)
    expect(screen.getByText('周宁')).toBeInTheDocument()
    expect(screen.getByText('已确认')).toBeInTheDocument()
  })

  it('关注按钮：切换状态由服务端结果决定；无权限时禁用并说明', async () => {
    const onToggle = vi.fn(async () => undefined)
    const { rerender } = renderWithApp(<WatchButton watching={false} onToggle={onToggle} />)
    await userEvent.click(screen.getByRole('button', { name: /关\s*注/ }))
    expect(onToggle).toHaveBeenCalled()
    rerender(<WatchButton watching onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: /已关注/ })).toHaveAttribute('aria-pressed', 'true')
    rerender(<WatchButton watching={false} onToggle={onToggle} disabledReason="没有关注权限" />)
    expect(screen.getByRole('button', { name: /关\s*注/ })).toBeDisabled()
  })
})
