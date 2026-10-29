import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdsWritePreviewResponse, AdsWriteSubmitResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { groupHandlers } from './ads-groups-fixtures.test-helper'
import { ok } from './ads-fixtures.test-helper'

// 广告写入动作（P3-17）：先预览再提交。没有权限不能点；没预览或预览没通过不能提交（也不会发出写请求）；取值改了要重新预览；
// 提交的请求体就是预览用的内容；成功只表示已排队。这里用广告组详情的“修改默认竞价”作为代表入口。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsAdGroupDetailPage: { load: () => import('./AdsAdGroupDetailPage') } }
afterEach(() => vi.unstubAllGlobals())
const url = '/app/advertising/ad-groups/ag-1'

const preview = (over: Partial<AdsWritePreviewResponse> = {}): AdsWritePreviewResponse => ({
  items: [
    {
      index: 0,
      kind: 'AD_GROUP_BID',
      kindLabel: '修改广告组默认竞价',
      entityId: 'ag-1',
      entityLabel: '核心词组',
      blocker: null,
      before: '1.2',
      after: '1.5',
      changePercent: 25,
      warnings: [],
      forecast: null,
    },
  ],
  switches: [{ key: 'sw.ads.bid', label: '修改竞价', enabled: true, reason: null }],
  permitted: true,
  canSubmit: true,
  reason: null,
  note: '预览只读本系统已有的数据',
  ...over,
})

const submitted: AdsWriteSubmitResponse = { runs: [], state: 'QUEUED' }

function setup(previewData: AdsWritePreviewResponse = preview(), me = defaultMe) {
  const bodies: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  const detail = groupHandlers()['/ads/ad-groups/ag-1']!
  const handlers: Record<string, Handler> = {
    ...groupHandlers(),
    '/ads/ad-groups/ag-1': (u, init) => {
      if (init?.method === 'PATCH') {
        bodies.push({ path: u.pathname, method: 'PATCH', body: JSON.parse(String(init.body)) })
        return ok(submitted)
      }
      return detail(u, init)
    },
    '/ads/preview': (u, init) => {
      bodies.push({ path: u.pathname, method: 'POST', body: JSON.parse(String(init?.body)) })
      return ok(previewData)
    },
  }
  mountApp({ url, pages, me, handlers })
  return bodies
}

async function openDialog() {
  const page = await screen.findByTestId('ads-group-detail')
  await within(page).findByText('核心词组')
  await userEvent.click(within(page).getByRole('button', { name: '修改默认竞价' }))
  return within(await screen.findByRole('dialog'))
}

const submitButton = (dialog: ReturnType<typeof within>) => dialog.getByRole('button', { name: /确\s*认\s*提\s*交/ })

describe('广告写入动作：先预览再提交', () => {
  it('没有写入权限：按钮禁用', async () => {
    setup(preview(), { ...defaultMe, permissions: ['ads.read'] })
    const page = await screen.findByTestId('ads-group-detail')
    await within(page).findByText('核心词组')
    expect(within(page).getByRole('button', { name: '修改默认竞价' })).toBeDisabled()
  })

  it('取值不完整：预览按钮禁用并写明要填什么', async () => {
    setup()
    const dialog = await openDialog()
    expect(dialog.getByRole('button', { name: /预览修改/ })).toBeDisabled()
    expect(dialog.getByText('请填写新的默认竞价')).toBeInTheDocument()
  })

  it('预览通过后提交：预览与提交用同样的内容；预览显示修改前后、变化与开关', async () => {
    const calls = setup()
    const dialog = await openDialog()
    await userEvent.type(dialog.getByLabelText('新的默认竞价（美元）'), '1.5')
    await userEvent.click(dialog.getByRole('button', { name: /预览修改/ }))
    const verdict = await dialog.findByTestId('ads-write-preview-verdict')
    expect(verdict).toHaveTextContent('预览通过，可以提交')
    const panel = within(dialog.getByTestId('ads-write-preview'))
    expect(panel.getByText('1.2')).toBeInTheDocument()
    expect(panel.getByText('1.5')).toBeInTheDocument()
    expect(panel.getByText('+25%')).toBeInTheDocument()
    expect(panel.getByText('修改竞价：已开启')).toBeInTheDocument()
    expect(calls[0]).toMatchObject({ path: '/api/v1/ads/preview', body: { ops: [{ kind: 'AD_GROUP_BID', entityId: 'ag-1', amount: 1.5 }] } })

    await userEvent.click(submitButton(dialog))
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1))
    const sent = calls.find(call => call.method === 'PATCH')!
    expect(sent.path).toBe('/api/v1/ads/ad-groups/ag-1')
    expect(sent.body).toEqual({ kind: 'AD_GROUP_BID', amount: 1.5 })
  })

  it('没点预览就提交：提示先预览，不发写请求', async () => {
    const calls = setup()
    const dialog = await openDialog()
    await userEvent.type(dialog.getByLabelText('新的默认竞价（美元）'), '1.5')
    await userEvent.click(submitButton(dialog))
    expect(await screen.findByText(/请先点击“预览修改”/)).toBeInTheDocument()
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0)
  })

  it('预览没通过（开关关闭）：显示原因与开关状态，不能提交', async () => {
    const blocked = preview({
      canSubmit: false,
      reason: '写入开关“修改竞价”没有开启',
      switches: [{ key: 'sw.ads.bid', label: '修改竞价', enabled: false, reason: '默认只读，需要管理员开启' }],
    })
    const calls = setup(blocked)
    const dialog = await openDialog()
    await userEvent.type(dialog.getByLabelText('新的默认竞价（美元）'), '1.5')
    await userEvent.click(dialog.getByRole('button', { name: /预览修改/ }))
    expect(await dialog.findByTestId('ads-write-preview-verdict')).toHaveTextContent('写入开关“修改竞价”没有开启')
    expect(dialog.getByText('修改竞价：默认只读，需要管理员开启')).toBeInTheDocument()
    await userEvent.click(submitButton(dialog))
    expect((await screen.findAllByText(/写入开关“修改竞价”没有开启/)).length).toBeGreaterThan(1)
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0)
  })

  it('预览之后又改了取值：提示重新预览，旧预览不能用来提交', async () => {
    const calls = setup()
    const dialog = await openDialog()
    const input = dialog.getByLabelText('新的默认竞价（美元）')
    await userEvent.type(input, '1.5')
    await userEvent.click(dialog.getByRole('button', { name: /预览修改/ }))
    await dialog.findByTestId('ads-write-preview-verdict')
    fireEvent.change(input, { target: { value: '2.50' } })
    expect(await dialog.findByText('取值已修改，请重新预览')).toBeInTheDocument()
    expect(dialog.queryByTestId('ads-write-preview-verdict')).toBeNull()
    await userEvent.click(submitButton(dialog))
    expect(await screen.findByText(/请先点击“预览修改”/)).toBeInTheDocument()
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0)
  })

  it('预览里有提醒与对象不存在的原因：逐项显示', async () => {
    const data = preview({
      canSubmit: false,
      reason: '有对象不能修改',
      items: [
        {
          index: 0,
          kind: 'AD_GROUP_BID',
          kindLabel: '修改广告组默认竞价',
          entityId: 'ag-1',
          entityLabel: null,
          blocker: '对象不存在或不在数据范围内',
          before: null,
          after: '9',
          changePercent: null,
          warnings: ['当前值尚未同步，无法计算变化幅度'],
          forecast: null,
        },
      ],
    })
    setup(data)
    const dialog = await openDialog()
    await userEvent.type(dialog.getByLabelText('新的默认竞价（美元）'), '9')
    await userEvent.click(dialog.getByRole('button', { name: /预览修改/ }))
    const panel = within(await dialog.findByTestId('ads-write-preview'))
    expect(await panel.findByText('对象不存在或不在数据范围内')).toBeInTheDocument()
    expect(panel.getByText('当前值尚未同步，无法计算变化幅度')).toBeInTheDocument()
    expect(panel.getByText('尚未同步')).toBeInTheDocument()
  })
})
