import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp } from './test/app-harness'
import type { LivePages } from './routes/live-pages'
import type { Me } from './session/session'
import { hasPlatformToken, setPlatformToken } from './platform/platform-api'

// 企业生命周期相关页面（P1-19）：邀请激活、状态横幅、平台登录与路由守卫。

const pages: LivePages = { OrdersPage: { load: async () => ({ default: () => <div>订单页</div> }) } }
const withTenant = (patch: Partial<Me['tenant']>, extra: Partial<Me> = {}): Me => ({ ...defaultMe, ...extra, tenant: { ...defaultMe.tenant, ...patch } })

afterEach(() => {
  vi.unstubAllGlobals()
  setPlatformToken(null)
})

describe('企业状态横幅', () => {
  it('企业被暂停：显示红色横幅，说明只读与同步停止', async () => {
    mountApp({ url: '/app/orders', pages, me: withTenant({ lifecycleStatus: 'SUSPENDED' }) })
    const banner = await screen.findByTestId('suspended-banner')
    expect(banner).toHaveTextContent('企业已被平台暂停')
    expect(banner).toHaveTextContent('后台同步已停止')
  })

  it('初始化未完成：管理员看到"去完成"入口，点击进入向导', async () => {
    const app = mountApp({ url: '/app/orders', pages, me: withTenant({ lifecycleStatus: 'ACTIVE', onboardingCompleted: false }) })
    const banner = await screen.findByTestId('onboarding-banner')
    expect(banner).toHaveTextContent('企业初始化尚未完成')
    await userEvent.click(screen.getByRole('button', { name: /去完成/ }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/onboarding'))
  })

  it('初始化未完成：没有管理权限的成员只看到提示，没有入口', async () => {
    mountApp({ url: '/app/orders', pages, me: withTenant({ onboardingCompleted: false }, { permissions: ['orders.read'] }) })
    const banner = await screen.findByTestId('onboarding-banner')
    expect(banner).toHaveTextContent('请联系企业管理员完成初始化')
    expect(screen.queryByRole('button', { name: /去完成/ })).toBeNull()
  })

  it('已完成初始化的正常企业：不显示任何生命周期横幅', async () => {
    mountApp({ url: '/app/orders', pages, me: withTenant({ lifecycleStatus: 'ACTIVE', onboardingCompleted: true }) })
    await screen.findByText('订单页')
    expect(screen.queryByTestId('suspended-banner')).toBeNull()
    expect(screen.queryByTestId('onboarding-banner')).toBeNull()
  })
})

describe('邀请激活页', () => {
  const preview = { success: true, data: { tenantName: '星河贸易', email: 'new@example.com', firstAdmin: true } }

  it('无效、过期或已使用的链接：给出统一提示，不出现表单', async () => {
    mountApp({ url: '/invite/bad-token', pages, me: null })
    expect(await screen.findByText('邀请链接不可用')).toBeInTheDocument()
    expect(screen.getByText(/邀请链接无效、已过期或已被使用/)).toBeInTheDocument()
    expect(screen.queryByLabelText('姓名')).toBeNull()
  })

  it('弱密码与不一致的确认密码在前端被拦下，不会调用激活接口', async () => {
    const app = mountApp({ url: '/invite/tok-1', pages, me: null, handlers: { '/auth/invitations/tok-1': () => ({ body: preview }) } })
    expect(await screen.findByText('加入 星河贸易')).toBeInTheDocument()
    expect(screen.getByText('new@example.com')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('姓名'), '王芳')
    await userEvent.type(screen.getByLabelText('设置密码'), 'short')
    await userEvent.type(screen.getByLabelText('确认密码'), 'other')
    await userEvent.click(screen.getByRole('button', { name: /激活账号/ }))
    expect(await screen.findByText('两次输入的密码不一致')).toBeInTheDocument()
    expect(app.calls.some(call => call.path.endsWith('/accept'))).toBe(false)
  })

  it('填写合规密码后激活成功：提示首次登录要绑定动态验证码，并可去登录', async () => {
    const app = mountApp({
      url: '/invite/tok-1',
      pages,
      me: null,
      handlers: {
        '/auth/invitations/tok-1': () => ({ body: preview }),
        '/auth/invitations/tok-1/accept': () => ({ body: { success: true, data: { email: 'new@example.com', tenantName: '星河贸易', mfaEnrollmentRequired: true } } }),
      },
    })
    await screen.findByText('加入 星河贸易')
    await userEvent.type(screen.getByLabelText('姓名'), '王芳')
    await userEvent.type(screen.getByLabelText('设置密码'), 'Correct-Horse-Battery-9')
    await userEvent.type(screen.getByLabelText('确认密码'), 'Correct-Horse-Battery-9')
    await userEvent.click(screen.getByRole('button', { name: /激活账号/ }))
    expect(await screen.findByText('账号已激活')).toBeInTheDocument()
    expect(screen.getByText(/首次登录后需要先绑定动态验证码/)).toBeInTheDocument()
    const accept = app.calls.find(call => call.path.endsWith('/accept'))
    expect(accept?.method).toBe('POST')
  })
})

describe('平台运营后台入口', () => {
  it('没有平台令牌直接访问后台页面：回到平台登录页，不会进入企业登录', async () => {
    const app = mountApp({ url: '/platform/tenants', pages, me: null })
    expect(await screen.findByText('平台运营后台')).toBeInTheDocument()
    expect(app.router.state.location.pathname).toBe('/platform/login')
    expect(screen.getByText(/登录需要密码与动态验证码/)).toBeInTheDocument()
  })

  it('密码通过后进入验证码步骤；验证码通过才取得令牌并进入租户列表', async () => {
    const app = mountApp({
      url: '/platform/login',
      pages,
      me: null,
      handlers: {
        '/platform/auth/login': () => ({ body: { data: { stage: 'VERIFY', challengeToken: 'c'.repeat(32) } } }),
        '/platform/auth/mfa/verify': () => ({
          body: {
            data: { accessToken: 'platform-token', expiresInSeconds: 3600, admin: { id: 'p1', email: 'ops@example.com', displayName: '平台负责人', role: 'PLATFORM_OWNER', permissions: ['*'] } },
          },
        }),
        '/platform/auth/me': () => ({ body: { data: { id: 'p1', email: 'ops@example.com', displayName: '平台负责人', role: 'PLATFORM_OWNER', permissions: ['*'] } } }),
        '/platform/tenants': () => ({ body: { data: { items: [], nextCursor: null } } }),
      },
    })
    await userEvent.type(await screen.findByLabelText('平台账号（邮箱）'), 'ops@example.com')
    await userEvent.type(screen.getByLabelText('登录密码'), 'Some-Long-Password-1')
    await userEvent.click(screen.getByRole('button', { name: /下一步/ }))
    expect(await screen.findByText(/请输入验证器 App 当前显示的 6 位验证码/)).toBeInTheDocument()
    expect(hasPlatformToken()).toBe(false)
    await userEvent.type(screen.getByLabelText('动态验证码'), '123456')
    await userEvent.click(screen.getByRole('button', { name: /^登\s?录$/ }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/platform/tenants'))
    expect(hasPlatformToken()).toBe(true)
  })

  it('验证码格式不对：前端拦下，不调用验证接口', async () => {
    const app = mountApp({
      url: '/platform/login',
      pages,
      me: null,
      handlers: { '/platform/auth/login': () => ({ body: { data: { stage: 'VERIFY', challengeToken: 'c'.repeat(32) } } }) },
    })
    await userEvent.type(await screen.findByLabelText('平台账号（邮箱）'), 'ops@example.com')
    await userEvent.type(screen.getByLabelText('登录密码'), 'Some-Long-Password-1')
    await userEvent.click(screen.getByRole('button', { name: /下一步/ }))
    await userEvent.type(await screen.findByLabelText('动态验证码'), '12ab')
    await userEvent.click(screen.getByRole('button', { name: /^登\s?录$/ }))
    expect(await screen.findByText('请输入 6 位数字验证码')).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/platform/auth/mfa/verify')).toBe(false)
  })
})
