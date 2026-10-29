import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 自定义指标页（P6-32）：空列表写出前置条件，检查公式把服务端的问题显示出来。

const pages: LivePages = { CustomMetricsPage: { load: () => import('./CustomMetricsPage') } }
afterEach(() => vi.unstubAllGlobals())

const handlers = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/custom-metrics': () => ({ body: { success: true, data: { items: [], total: 0, page: 1, pageSize: 50 } } }),
  ...extra,
})

describe('自定义指标页', () => {
  it('没有记录时说明前置条件，检查公式会显示问题', async () => {
    mountApp({
      url: '/app/reports/custom-metrics',
      pages,
      handlers: handlers({
        '/custom-metrics/validate': () => ({ body: { success: true, data: { ok: false, issues: ['不能除以常数 0'], refs: [], gates: [] } } }),
      }),
    })
    expect(await screen.findByText(/填写名称和公式并保存后，会出现在这里/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('指标编号'), 'C-ZERO')
    await userEvent.type(screen.getByLabelText('指标名称'), '除零')
    await userEvent.type(screen.getByLabelText('公式'), 'M-001 / 0')
    await userEvent.click(screen.getByRole('button', { name: '检查公式' }))
    expect(await screen.findByText('不能除以常数 0')).toBeInTheDocument()
  })
})
