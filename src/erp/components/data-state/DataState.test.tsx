import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../api'
import { describeError } from '../../query/errors'
import { renderWithApp } from '../../test/render'
import { DATA_STATE_KINDS, DataState, isBannerState, type DataStateProps } from './DataState'
import { stateFromError } from './from-error'

// 数据状态组件必须覆盖 03 章 3.2 的 9 种状态，每种都要有该有的信息与入口。
const SAMPLES: Record<DataStateProps['kind'], DataStateProps> = {
  skeleton: { kind: 'skeleton' },
  unauthorized: { kind: 'unauthorized', domain: '广告数据', authorize: { label: '去授权', href: '/app/connections' } },
  forbidden: { kind: 'forbidden', permission: 'orders.read' },
  qualification: { kind: 'qualification', requirement: '品牌所有者资格', explanation: '品牌分析数据只对品牌所有者开放' },
  empty: {
    kind: 'empty',
    domain: '本页展示订单明细',
    prerequisite: '先完成店铺授权并同步订单',
    sync: { label: '立即同步', onClick: () => undefined },
    lastJob: { status: '失败', failureReason: '令牌过期', handle: { label: '去处理', href: '/app/sync' } },
  },
  delayed: { kind: 'delayed', lastSuccessAt: '2026-10-20T10:00:00Z', expectedRecoveryAt: '2026-10-21T10:00:00Z' },
  'partial-failure': { kind: 'partial-failure', failed: [{ domain: '广告报表', impact: '广告花费暂缺' }], onRetry: () => undefined },
  'server-error': { kind: 'server-error', errorCode: 'INTERNAL', requestId: 'req-123', onRetry: () => undefined },
  'partial-available': { kind: 'partial-available', available: ['订单'], unavailable: [{ name: '广告', reason: '未授权' }] },
}

describe('数据状态组件', () => {
  it('9 种状态全集与样例一一对应', () => {
    expect([...DATA_STATE_KINDS].sort()).toEqual(Object.keys(SAMPLES).sort())
    expect(DATA_STATE_KINDS).toHaveLength(9)
  })

  it.each(DATA_STATE_KINDS)('%s：能渲染且带有对应的状态标记', kind => {
    const { container } = renderWithApp(<DataState {...SAMPLES[kind]} />)
    const name = kind === 'skeleton' ? 'skeleton' : kind
    expect(container.querySelector(`[data-state="${name}"]`)).not.toBeNull()
  })

  it('首次加载：骨架屏，对读屏声明正在加载', () => {
    renderWithApp(<DataState kind="skeleton" />)
    expect(screen.getByLabelText('正在加载')).toHaveAttribute('aria-busy', 'true')
  })

  it('未授权：说明数据域并给出授权入口；没有入口时提示联系管理员', async () => {
    const { unmount } = renderWithApp(<DataState {...SAMPLES.unauthorized} />)
    expect(await screen.findByText(/广告数据/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去授权' })).toBeInTheDocument()
    unmount()
    renderWithApp(<DataState kind="unauthorized" domain="广告数据" />)
    expect(await screen.findByText('请联系企业管理员完成授权。')).toBeInTheDocument()
  })

  it('无权限：写明缺少的权限点和联系管理员', async () => {
    renderWithApp(<DataState {...SAMPLES.forbidden} />)
    expect(await screen.findByText('orders.read')).toBeInTheDocument()
    expect(screen.getByText(/联系企业管理员/)).toBeInTheDocument()
  })

  it('资格不足：写明缺少的资格和原因', async () => {
    renderWithApp(<DataState {...SAMPLES.qualification} />)
    expect(await screen.findByText(/品牌所有者资格/)).toBeInTheDocument()
    expect(screen.getByText(/只对品牌所有者开放/)).toBeInTheDocument()
  })

  it('无数据：数据域说明、前置条件、同步按钮、最近任务状态、失败原因与处理入口', async () => {
    const onClick = vi.fn()
    renderWithApp(<DataState {...(SAMPLES.empty as Extract<DataStateProps, { kind: 'empty' }>)} sync={{ label: '立即同步', onClick }} />)
    expect(await screen.findByText('本页展示订单明细')).toBeInTheDocument()
    expect(screen.getByText(/先完成店铺授权并同步订单/)).toBeInTheDocument()
    expect(screen.getByText(/最近任务：失败/)).toHaveTextContent('失败原因：令牌过期')
    expect(screen.getByRole('button', { name: '去处理' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '立即同步' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('无数据：前置条件不满足时同步按钮禁用并说明原因', async () => {
    renderWithApp(<DataState kind="empty" domain="库存" prerequisite="先授权" sync={{ label: '立即同步', disabledReason: '店铺尚未授权' }} />)
    const button = await screen.findByRole('button', { name: '立即同步' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '店铺尚未授权')
  })

  it('数据延迟：显示最近成功时间（带时区）与预计恢复；没有成功记录时如实说明', () => {
    const { unmount } = renderWithApp(<DataState {...SAMPLES.delayed} />)
    expect(screen.getByText(/最近成功同步：2026-10-20 03:00 PDT/)).toBeInTheDocument()
    expect(screen.getByText(/预计恢复：2026-10-21 03:00 PDT/)).toBeInTheDocument()
    unmount()
    renderWithApp(<DataState kind="delayed" lastSuccessAt={null} />)
    expect(screen.getByText(/尚无成功记录/)).toBeInTheDocument()
    expect(screen.getByText(/暂无预计恢复时间/)).toBeInTheDocument()
  })

  it('局部同步失败：列出失败数据域与影响范围，可重试', async () => {
    const onRetry = vi.fn()
    renderWithApp(
      <DataState
        kind="partial-failure"
        failed={[
          { domain: '广告报表', impact: '广告花费暂缺' },
          { domain: '结算', impact: '回款滞后' },
        ]}
        onRetry={onRetry}
      />,
    )
    expect(screen.getByText('2 个数据域同步失败')).toBeInTheDocument()
    expect(screen.getByText(/广告报表：广告花费暂缺/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('服务端错误：显示错误编号、请求编号与重试', async () => {
    const onRetry = vi.fn()
    renderWithApp(<DataState kind="server-error" errorCode="INTERNAL" requestId="req-123" onRetry={onRetry} />)
    expect(await screen.findByText(/错误编号：INTERNAL/)).toBeInTheDocument()
    expect(screen.getByText(/请求编号：req-123/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('部分数据可用：列出可用与不可用部分及原因', () => {
    renderWithApp(<DataState {...SAMPLES['partial-available']} />)
    expect(screen.getByText('可用：订单')).toBeInTheDocument()
    expect(screen.getByText('不可用：广告（未授权）')).toBeInTheDocument()
  })

  it('横幅型状态与阻断型状态的区分', () => {
    expect(DATA_STATE_KINDS.filter(isBannerState).sort()).toEqual(['delayed', 'partial-available', 'partial-failure'])
  })

  it('请求错误转状态：403 → 无权限；超时 → 服务端错误并提示缩小范围；其余带请求编号', () => {
    const forbidden = stateFromError(describeError(new ApiError(403, 'FORBIDDEN', '没有权限', undefined, { requestId: 'req-1' })), { permission: 'orders.read' })
    expect(forbidden).toEqual({ kind: 'forbidden', permission: 'orders.read' })
    const timeout = stateFromError(describeError(new ApiError(504, 'QUERY_TIMEOUT', '查询超时', undefined, { requestId: 'req-2' })))
    expect(timeout).toMatchObject({ kind: 'server-error', requestId: 'req-2' })
    expect((timeout as { message?: string }).message).toMatch(/缩小时间范围/)
    const server = stateFromError(describeError(new ApiError(500, 'INTERNAL', '服务出错', undefined, { requestId: 'req-3' })))
    expect(server).toMatchObject({ kind: 'server-error', errorCode: 'INTERNAL', requestId: 'req-3' })
  })
})
