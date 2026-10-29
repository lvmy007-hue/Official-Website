import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { mountApp } from '../test/app-harness'
import { LIVE_PAGES } from '../routes/live-pages'
import { planList } from './inbound/inbound-fixtures.test-helper'

// 入仓计划已是正式页面。这里仍守一条：页面上不出现非美国站。过渡期旧页面已在 P5-12 删除。

afterEach(() => vi.unstubAllGlobals())

describe('入仓计划页站点范围', () => {
  it('入仓计划页（P2a-12 起是正式页面）：站点只有美国站，没有示例记录', async () => {
    mountApp({
      url: '/app/supply-chain',
      pages: LIVE_PAGES,
      handlers: {
        '/inbound/plans': () => ({ body: { success: true, data: planList([]) } }),
        '/connections': () => ({ body: { success: true, data: { items: [] } } }),
      },
    })
    expect(await screen.findByRole('button', { name: /新建入仓计划/ })).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
    expect(document.body.textContent).not.toMatch(/Amazon\.ca|Amazon\.com\.mx|Amazon\.com\.br/)
  })
})
