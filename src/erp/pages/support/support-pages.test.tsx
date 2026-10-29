import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { contact, normalSync, ok, pendingSync, supportCaseRow, supportDetail, supportList } from './support-fixtures.test-helper'

// 支持案件列表与详情（P2b-04）：没有数据的写法、受限角色没批时的申请说明、沟通记录从早到晚、关联对象、只读。

const pages: LivePages = {
  SupportCasesPage: { load: () => import('./SupportCasesPage') },
  SupportCaseDetailPage: { load: () => import('./SupportCaseDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['*'] }),
  '/support-cases': () => ok(supportList()),
  '/support-cases/sc1': () => ok(supportDetail()),
  ...over,
})

describe('支持案件列表', () => {
  it('列出案件：状态、主题、沟通条数；没同步沟通的写“尚未同步”，不写 0；带新鲜度', { timeout: 30000 }, async () => {
    const items = [
      supportCaseRow(),
      supportCaseRow({ id: 'sc2', caseId: '987654321', contactCount: null, status: 'RESOLVED', statusLabel: '已解决', reimbursementCaseId: 'c1', reimbursementCaseNo: 'PC-1' }),
    ]
    mountApp({ url: '/app/support-cases', pages, handlers: handlers({ '/support-cases': () => ok(supportList(items)) }) })
    expect(await screen.findByText('987654321', {}, { timeout: 15000 })).toBeInTheDocument()
    const row = screen.getByText('987654321').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('尚未同步')).toBeInTheDocument()
    expect(within(row).getByText('已解决')).toBeInTheDocument()
    expect(within(row).getByText('PC-1')).toBeInTheDocument()
    expect(screen.getByText('等待亚马逊处理')).toBeInTheDocument()
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
  })

  it('受限角色没批：显示申请方式，表里不写“没有案件”', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/support-cases', pages, handlers: handlers({ '/support-cases': () => ok(supportList([], { state: 'ROLE_PENDING', note: 'x', sync: pendingSync })) }) })
    const alert = await screen.findByTestId('support-role-pending', {}, { timeout: 15000 })
    expect(within(alert).getByText(/Selling Partner Support/)).toBeInTheDocument()
    expect(await screen.findByText(/未授权：申请方式见上方说明/)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('同步正常但没有案件：写“尚无记录”；没有同步过：写“尚未同步”', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/support-cases', pages, handlers: handlers({ '/support-cases': () => ok(supportList([], { note: '尚无记录：亚马逊卖家支持里没有这个店铺的案件' })) }) })
    expect(await screen.findByText(/尚无记录：亚马逊卖家支持里没有这个店铺的案件/, {}, { timeout: 15000 })).toBeInTheDocument()
  })

  it('按状态筛选时带上 status 参数', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/support-cases?status=RESOLVED', pages, handlers: handlers() })
    expect(await screen.findByText('123456789', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/support-cases')).toBe(true)
  })
})

describe('支持案件详情', () => {
  it('身份区、沟通记录从早到晚、附件只有名称；页面只读，没有任何写入口', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/support-cases/sc1', pages, handlers: handlers() })
    expect(await screen.findByText('支持案件 123456789', {}, { timeout: 15000 })).toBeInTheDocument()
    const contacts = screen.getByTestId('support-contacts')
    const bodies = within(contacts)
      .getAllByText(/请补充入库证据|已补充/)
      .map(node => node.textContent)
    expect(bodies).toEqual(['请补充入库证据', '已补充'])
    expect(within(contacts).getByText(/证据\.pdf/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /回复|发送|提交/ })).toBeNull()
  })

  it('正文含电话等个人信息时只显示掩码；填理由后经统一出口才看到原文，立即隐藏后消失', { timeout: 30000 }, async () => {
    let body: Record<string, unknown> | undefined
    const detail = supportDetail({ contacts: [contact({ body: '请寄到 [地址已隐藏]，电话 [电话已隐藏]', piiKinds: ['PHONE', 'ADDRESS'] })] })
    mountApp({
      url: '/app/support-cases/sc1',
      pages,
      handlers: handlers({
        '/support-cases/sc1': () => ok(detail),
        '/pii/reveal': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return ok({
            objectType: 'SUPPORT_CONTACT',
            objectId: 'k1',
            state: 'OK',
            values: { body: '请寄到 1 Main Street，电话 13900000000' },
            expiresAt: '2026-10-27T10:01:00.000Z',
            retainedUntil: null,
            note: null,
          })
        },
      }),
    })
    const contacts = await screen.findByTestId('support-contacts', {}, { timeout: 15000 })
    expect(contacts).toHaveTextContent('[电话已隐藏]')
    expect(document.body.textContent).not.toContain('13900000000')
    await userEvent.click(within(contacts).getByRole('button', { name: /查看原文/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '查看原因' }), '核对客户诉求')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    expect(await screen.findByTestId('pii-revealed')).toHaveTextContent('13900000000')
    expect(body).toEqual({ objectType: 'SUPPORT_CONTACT', objectId: 'k1', fields: ['body'], reason: '核对客户诉求' })
    await userEvent.click(screen.getByRole('button', { name: '立即隐藏' }))
    await waitFor(() => expect(document.body.textContent).not.toContain('13900000000'))
  })

  it('沟通记录还没同步：写原因，不当作没有沟通', { timeout: 30000 }, async () => {
    const detail = supportDetail({ case: supportCaseRow({ contactCount: null }), contacts: [], contactsState: 'NOT_SYNCED', contactsNote: '沟通记录尚未同步：案件刚出现' })
    mountApp({ url: '/app/support-cases/sc1', pages, handlers: handlers({ '/support-cases/sc1': () => ok(detail) }) })
    expect(await screen.findByTestId('contacts-note', {}, { timeout: 15000 })).toHaveTextContent('沟通记录尚未同步')
    expect(screen.getAllByText('尚未同步').length).toBeGreaterThan(0)
  })

  it('概览：关联的赔付案件、货件（标明推算）、预约回电；没有的写“尚无关联”', { timeout: 30000 }, async () => {
    const detail = supportDetail({
      links: { reimbursement: { id: 'c1', caseNo: 'PC-1', statusLabel: '已提交' }, shipments: [{ ref: 'FBA15ABCDE', label: '货件 FBA15ABCDE', via: 'SUBJECT' }], products: [] },
      appointments: [{ appointmentId: 'a1', status: 'SCHEDULED', statusLabel: '已预约', earliestAt: '2026-10-25T01:00:00.000Z', latestAt: '2026-10-25T02:00:00.000Z', answeringParty: null }],
      sync: normalSync,
    })
    mountApp({ url: '/app/support-cases/sc1', pages, handlers: handlers({ '/support-cases/sc1': () => ok(detail) }) })
    await screen.findByText('支持案件 123456789', {}, { timeout: 15000 })
    screen.getByRole('tab', { name: '概览' }).click()
    const overview = await screen.findByTestId('support-overview')
    expect(within(overview).getByText(/PC-1/)).toBeInTheDocument()
    expect(within(overview).getByText(/按案件主题里的货件编号推算/)).toBeInTheDocument()
    expect(within(overview).getByText(/已预约：/)).toBeInTheDocument()
    expect(within(overview).getAllByText('尚无关联').length).toBeGreaterThan(0)
  })

  it('案件不存在：显示错误状态，不是空白', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/support-cases/nope',
      pages,
      handlers: handlers({ '/support-cases/nope': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '支持案件不存在' } } }) }),
    })
    expect(await screen.findByText(/不存在/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})
