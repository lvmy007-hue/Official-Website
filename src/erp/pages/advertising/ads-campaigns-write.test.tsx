import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdsWritePreviewResponse } from '@nova/api-contracts'
import { mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { listHandlers, listResponse } from './ads-campaigns-fixtures.test-helper'
import { ok } from './ads-fixtures.test-helper'

// 广告活动列表的写入动作（P3-17）：勾选活动后才能点；一批活动一次预览、一次提交，整批全有或全无；请求体是 { ops }。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsCampaignsPage: { load: () => import('./AdsCampaignsPage') } }
afterEach(() => vi.unstubAllGlobals())

const preview: AdsWritePreviewResponse = {
  items: [
    {
      index: 0,
      kind: 'CAMPAIGN_STATE',
      kindLabel: '暂停或启用活动',
      entityId: 'cam-1',
      entityLabel: '春季推广',
      blocker: null,
      before: 'ENABLED',
      after: 'PAUSED',
      changePercent: null,
      warnings: ['暂停后该对象不再产生花费与订单'],
      forecast: null,
    },
  ],
  switches: [{ key: 'sw.ads.status', label: '活动状态', enabled: true, reason: null }],
  permitted: true,
  canSubmit: true,
  reason: null,
  note: '预览只读本系统已有的数据',
}

describe('广告活动列表：批量写入', () => {
  it('勾选后暂停：先预览（带提醒），再提交到 /ads/campaigns；请求体带所选活动', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = []
    const handlers: Record<string, Handler> = {
      ...listHandlers(() => listResponse()),
      '/ads/preview': (u, init) => {
        calls.push({ path: u.pathname, method: 'POST', body: JSON.parse(String(init?.body)) })
        return ok(preview)
      },
      '/ads/campaigns': (u, init) => {
        if (init?.method === 'PATCH') {
          calls.push({ path: u.pathname, method: 'PATCH', body: JSON.parse(String(init.body)) })
          return ok({ runs: [], state: 'QUEUED' })
        }
        return listHandlers(() => listResponse())['/ads/campaigns']!(u, init)
      },
    }
    mountApp({ url: '/app/advertising/campaigns', pages, handlers })
    const page = within(await screen.findByTestId('ads-campaigns-page'))
    await page.findByText('春季推广')
    expect(page.queryByRole('toolbar', { name: '批量操作' })).toBeNull()
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    expect(await page.findByText('已选 1 项')).toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: /暂\s*停/ }))

    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /预览修改/ }))
    expect(await dialog.findByTestId('ads-write-preview-verdict')).toHaveTextContent('预览通过，可以提交')
    expect(dialog.getByText('暂停后该对象不再产生花费与订单')).toBeInTheDocument()
    expect(calls[0]!.body).toEqual({ ops: [{ kind: 'CAMPAIGN_STATE', entityId: expect.any(String), state: 'PAUSED' }] })

    await userEvent.click(dialog.getByRole('button', { name: /确\s*认\s*提\s*交/ }))
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1))
    expect(calls.find(call => call.method === 'PATCH')).toMatchObject({ path: '/api/v1/ads/campaigns', body: { ops: [{ kind: 'CAMPAIGN_STATE', state: 'PAUSED' }] } })
  })
})
