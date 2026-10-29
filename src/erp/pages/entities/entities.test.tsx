import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { entityDetail, entityList, entityRow, ok } from './entities-fixtures.test-helper'

// 法律主体列表与详情（P5-07）：真实计数写 0、未填写与无权查看的写法、停用的守卫、修改带版本号。

const pages: LivePages = {
  EntitiesPage: { load: () => import('./EntitiesPage') },
  EntityDetailPage: { load: () => import('./EntityDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/entities': () => ok(entityList()),
  '/entities/e1': () => ok(entityDetail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('法律主体列表', () => {
  it('显示状态汇总；店铺数为 0 写 0，注册号没填写写“未填写”', async () => {
    mountApp({ url: '/app/entities', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: '深圳跨境科技' })
    expect(link).toHaveAttribute('href', '/app/entities/e1')
    expect(screen.getByText(/共 2 个主体：使用中 1，已停用 1/)).toBeInTheDocument()
    const second = screen.getByRole('link', { name: '美国空壳公司' }).closest('tr, [role=row]') as HTMLElement
    expect(within(second).getByText('未填写')).toBeInTheDocument()
    expect(within(second).getByText('已停用')).toBeInTheDocument()
    expect(within(second).getAllByText('0').length).toBe(2)
  })

  it('没有主体：说明下一步，不是空表', async () => {
    mountApp({ url: '/app/entities', pages, handlers: handlers({ '/entities': () => ok(entityList({ items: [], total: 0, summary: { total: 0, active: 0, inactive: 0 } })) }) })
    expect(await screen.findByText(/还没有法律主体/)).toBeInTheDocument()
  })

  it('只读账号：新增按钮不可用并说明原因', async () => {
    mountApp({
      url: '/app/entities',
      pages,
      handlers: handlers({ '/entities': () => ok(entityList({ canWrite: false, writeBlockedReason: '没有“新增、修改法律主体”权限' })) }, ['entity.read']),
    })
    await screen.findByRole('link', { name: '深圳跨境科技' })
    expect(screen.getByRole('button', { name: /新增法律主体/ })).toBeDisabled()
    expect(screen.getByText(/当前账号只能查看/)).toBeInTheDocument()
  })

  it('新增：名称与注册地必填；成功后按填写内容发出，空注册号不带上', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/entities',
      pages,
      handlers: handlers({
        '/entities': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: entityRow({ id: 'e3' }) } }
          }
          return ok(entityList())
        },
      }),
    })
    await screen.findByRole('link', { name: '深圳跨境科技' })
    await userEvent.click(screen.getByRole('button', { name: /新增法律主体/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    expect(await within(dialog).findByText('请填写主体名称')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('textbox', { name: '主体名称' }), ' 香港贸易 ')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '注册地' }), '中国香港')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    await waitFor(() => expect(body).toEqual({ name: '香港贸易', registeredCountry: '中国香港' }))
  })

  it('加载失败：显示错误与重试', async () => {
    mountApp({ url: '/app/entities', pages, handlers: handlers({ '/entities': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: '服务异常' } } }) }) })
    expect(await screen.findByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })
})

describe('法律主体详情', () => {
  it('四个指标与名下店铺、广告账户；未授权的店铺写“尚未授权”', async () => {
    mountApp({ url: '/app/entities/e1', pages, handlers: handlers() })
    expect((await screen.findAllByText('深圳跨境科技')).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: '名下店铺与广告账户' }))
    expect(await screen.findByText('主力店广告')).toBeInTheDocument()
    expect(screen.getByText('已授权')).toBeInTheDocument()
    expect(screen.getByText('尚未授权')).toBeInTheDocument()
    expect(screen.getByText('已自动匹配')).toBeInTheDocument()
  })

  it('被授权成员：整个主体与指定店铺分别写明', async () => {
    mountApp({ url: '/app/entities/e1', pages, handlers: handlers() })
    await screen.findAllByText('深圳跨境科技')
    await userEvent.click(screen.getByRole('tab', { name: '被授权成员' }))
    expect(await screen.findByText('整个主体')).toBeInTheDocument()
    expect(screen.getByText('指定店铺：主力店')).toBeInTheDocument()
  })

  it('没有成员查看权限：写“无权查看”和缺的权限点，不显示空列表', async () => {
    const restricted = entityDetail({ members: { state: 'RESTRICTED', items: [], truncated: false } })
    mountApp({ url: '/app/entities/e1', pages, handlers: handlers({ '/entities/e1': () => ok(restricted) }) })
    await screen.findAllByText('深圳跨境科技')
    expect(screen.getByText('无权查看')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '被授权成员' }))
    expect(await screen.findByText(/member\.read/)).toBeInTheDocument()
  })

  it('变更记录：写明操作人与字段的前后值', async () => {
    mountApp({ url: '/app/entities/e1', pages, handlers: handlers() })
    await screen.findAllByText('深圳跨境科技')
    await userEvent.click(screen.getByRole('tab', { name: '变更记录' }))
    expect(await screen.findByText('管理员')).toBeInTheDocument()
    expect(screen.getByText(/主体名称：深圳跨境 → 深圳跨境科技/)).toBeInTheDocument()
  })

  it('名下还有店铺时停用按钮不可用，并写明原因', async () => {
    mountApp({ url: '/app/entities/e1', pages, handlers: handlers() })
    await screen.findAllByText('深圳跨境科技')
    expect(screen.getByRole('button', { name: /停\s*用/ })).toBeDisabled()
  })

  it('停用：必须填原因；发出时带着版本号', async () => {
    let body: Record<string, unknown> | undefined
    const free = entityDetail({ canDeactivate: true, deactivateBlockedReason: null, stores: [] })
    mountApp({
      url: '/app/entities/e1',
      pages,
      handlers: handlers({
        '/entities/e1': (_url, init) => {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body))
            return ok({ entity: entityRow({ status: 'INACTIVE' }), changed: true })
          }
          return ok(free)
        },
      }),
    })
    await screen.findAllByText('深圳跨境科技')
    await userEvent.click(screen.getByRole('button', { name: /停\s*用/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^停\s*用$/ }))
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('textbox', { name: /停用原因/ }), '主体已注销')
    await userEvent.click(within(dialog).getByRole('button', { name: /^停\s*用$/ }))
    await waitFor(() => expect(body).toEqual({ version: 3, status: 'INACTIVE', reason: '主体已注销' }))
  })

  it('已停用的主体显示“恢复使用”，没有“停用”', async () => {
    const inactive = entityDetail({ entity: { ...entityDetail().entity, status: 'INACTIVE' } })
    mountApp({ url: '/app/entities/e1', pages, handlers: handlers({ '/entities/e1': () => ok(inactive) }) })
    expect(await screen.findByRole('button', { name: /恢复使用/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^停\s*用$/ })).not.toBeInTheDocument()
  })

  it('编辑：带着看到的版本号发出；清空注册号传 null', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/entities/e1',
      pages,
      handlers: handlers({
        '/entities/e1': (_url, init) => {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body))
            return ok({ entity: entityRow(), changed: true })
          }
          return ok(entityDetail())
        },
      }),
    })
    await screen.findAllByText('深圳跨境科技')
    await userEvent.click(screen.getByRole('button', { name: /^编\s*辑$/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.clear(within(dialog).getByRole('textbox', { name: '注册号' }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(body).toEqual({ version: 3, name: '深圳跨境科技', registeredCountry: '中国', registrationNo: null }))
  })
})
