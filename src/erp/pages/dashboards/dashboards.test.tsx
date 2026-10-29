import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 自定义仪表盘详情（P6-33）：布局拖动后保存并还原；组件有数、无权查看、尚无记录三种状态。

const pages: LivePages = { DashboardDetailPage: { load: () => import('./DashboardDetailPage') } }
afterEach(() => vi.unstubAllGlobals())

const layout = {
  items: [
    { widgetId: 'w1', x: 0, y: 0, w: 3, h: 2 },
    { widgetId: 'w2', x: 3, y: 0, w: 3, h: 2 },
    { widgetId: 'w3', x: 6, y: 0, w: 3, h: 2 },
  ],
}

const detail = {
  id: 'd1',
  name: '晨会',
  folderId: null,
  ownerId: 'u1',
  shared: true,
  refreshMinutes: 5,
  version: 4,
  canWrite: true,
  layout,
  widgets: [
    { id: 'w1', type: 'METRIC_CARD', query: { source: 'ads', metrics: ['spend'] }, options: { metric: 'spend' }, version: 1 },
    { id: 'w2', type: 'METRIC_CARD', query: { source: 'ads', metrics: ['spend'] }, options: {}, version: 1 },
    { id: 'w3', type: 'METRIC_CARD', query: { source: 'inventory', metrics: ['sellable'] }, options: { metric: 'sellable' }, version: 1 },
  ],
}

const read = (id: string) => {
  if (id === 'w1') return { state: 'OK', result: { columns: [{ key: 'spend', label: '花费' }], rows: [{ id: 'c1', label: '活动', values: { spend: 12 } }] } }
  if (id === 'w2') return { state: 'RESTRICTED', message: '无权查看' }
  return { state: 'EMPTY', message: '尚无记录' }
}

describe('自定义仪表盘详情', () => {
  it('拖动后保存布局，并显示有数、无权查看、尚无记录', async () => {
    const saved: { body: { layout?: { items: Array<{ widgetId: string; x: number }> }; version?: number; name?: string } | null } = { body: null }
    const handlers: Record<string, Handler> = {
      '/dashboards/tree': () => ({ body: { success: true, data: { folders: [{ id: 'f1', parentId: null, name: '运营', version: 1 }], dashboards: [], shared: [] } } }),
      '/dashboards/d1': (_url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
          saved.body = JSON.parse(String(init?.body ?? '{}')) as { layout?: { items: Array<{ widgetId: string; x: number }> }; version?: number; name?: string }
          return { body: { success: true, data: { version: 5 } } }
        }
        return { body: { success: true, data: detail } }
      },
      '/dashboards/d1/widgets/w1': () => ({ body: { success: true, data: read('w1') } }),
      '/dashboards/d1/widgets/w2': () => ({ body: { success: true, data: read('w2') } }),
      '/dashboards/d1/widgets/w3': () => ({ body: { success: true, data: read('w3') } }),
    }
    mountApp({ url: '/app/dashboards/d1', pages, handlers })
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('无权查看')).toBeInTheDocument()
    expect(screen.getByText('尚无记录')).toBeInTheDocument()
    expect(screen.getByText(/整盘每 5 分钟自动刷新/)).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByTestId('drag-w1'), { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 80, clientY: 0 })
    fireEvent.pointerUp(window)
    const save = screen.getByRole('button', { name: '保存布局' })
    await waitFor(() => expect(save).toBeEnabled())
    await userEvent.click(save)
    await waitFor(() => expect(saved.body).not.toBeNull())
    expect(saved.body?.name).toBe('晨会')
    expect(saved.body?.version).toBe(4)
    expect(saved.body?.layout?.items.find(item => item.widgetId === 'w1')?.x).toBe(2)
  })

  it('组件读取失败显示错误，点刷新成功后错误消失；删除组件后重新读取', async () => {
    let reads = 0
    let removed = false
    const one = { ...detail, layout: { items: [layout.items[0]!] }, widgets: [detail.widgets[0]!] }
    const handlers: Record<string, Handler> = {
      '/dashboards/tree': () => ({ body: { success: true, data: { folders: [], dashboards: [], shared: [] } } }),
      '/dashboards/d1': () => ({ body: { success: true, data: removed ? { ...one, layout: { items: [] }, widgets: [] } : one } }),
      '/dashboards/d1/widgets/w1': (_url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
          removed = true
          return { body: { success: true, data: { id: 'w1' } } }
        }
        reads += 1
        if (reads === 1) return { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: '读取炸了' } } }
        return { body: { success: true, data: read('w1') } }
      },
    }
    mountApp({ url: '/app/dashboards/d1', pages, handlers })
    expect(await screen.findByText(/读取炸了|读取失败|服务/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.queryByText(/读取炸了/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '删除组件' }))
    await waitFor(() => expect(screen.queryByTestId('widget-w1')).not.toBeInTheDocument())
  })
})
