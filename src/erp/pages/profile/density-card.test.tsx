import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultNotifyPrefs, type PreferencesResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import type { Me } from '../../session/session'
import { getDensity, setDensity } from '../../theme/density'

// 界面密度（P6-01）：个人账号页的密度卡片；切换后提交密度与读到的版本号，主题随之变化；冲突、失败、无个人账号时的表现。

const pages: LivePages = { ProfilePage: { load: () => import('./ProfilePage') } }
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }
const ok = (data: unknown) => ({ body: { success: true, data } })
const meOf = (patch: Partial<Me> = {}): Me => ({
  ...defaultMe,
  tenant: { ...defaultMe.tenant, localTimezone: 'Asia/Shanghai' },
  mfa: { enrolled: false, pending: false, recoveryCodesRemaining: 0 },
  ...patch,
})
const prefs = (patch: Partial<PreferencesResponse> = {}): PreferencesResponse => ({
  notify: defaultNotifyPrefs(),
  favorites: [],
  density: 'STANDARD',
  version: 0,
  updatedAt: null,
  zone: 'Asia/Shanghai',
  ...patch,
})

beforeEach(() => {
  localStorage.clear()
  setDensity('STANDARD')
})
afterEach(() => vi.unstubAllGlobals())

describe('界面密度', () => {
  it('默认标准；切换到紧凑：只提交密度与版本号，成功后主题与本机缓存一起变', T, async () => {
    const puts: Array<Record<string, unknown>> = []
    const handler: Handler = (_url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        puts.push(body)
        return ok(prefs({ density: 'COMPACT', version: 1 }))
      }
      return ok(prefs())
    }
    mountApp({ url: '/app/profile', pages, me: meOf(), handlers: { '/me/preferences': handler } })
    const card = await screen.findByTestId('profile-density', {}, WAIT)
    await waitFor(() => expect(within(card).getByRole('radio', { name: '紧凑' })).toBeEnabled(), WAIT)
    await userEvent.click(within(card).getByText('紧凑', { selector: '.ant-segmented-item-label' }))
    await waitFor(() => expect(puts).toEqual([{ density: 'COMPACT', version: 0 }]), WAIT)
    await waitFor(() => expect(getDensity()).toBe('COMPACT'))
    expect(localStorage.getItem('nova.erp.density')).toBe('COMPACT')
  })

  it('保存失败：还原为原来的密度并提示原因，不假装成功', T, async () => {
    const handler: Handler = (_url, init) => (init?.method === 'PUT' ? { status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限修改偏好' } } } : ok(prefs()))
    mountApp({ url: '/app/profile', pages, me: meOf(), handlers: { '/me/preferences': handler } })
    const card = await screen.findByTestId('profile-density', {}, WAIT)
    await waitFor(() => expect(within(card).getByRole('radio', { name: '紧凑' })).toBeEnabled(), WAIT)
    await userEvent.click(within(card).getByText('紧凑', { selector: '.ant-segmented-item-label' }))
    expect(await screen.findByText('没有权限修改偏好', {}, WAIT)).toBeInTheDocument()
    expect(getDensity()).toBe('STANDARD')
  })

  it('服务端已是紧凑：进入页面后本机同步成紧凑（服务端为准）', T, async () => {
    mountApp({ url: '/app/profile', pages, me: meOf(), handlers: { '/me/preferences': () => ok(prefs({ density: 'COMPACT', version: 3 })) } })
    await waitFor(() => expect(getDensity()).toBe('COMPACT'), WAIT)
  })

  it('平台支持访问没有个人账号：只读并说明，不请求偏好', T, async () => {
    const app = mountApp({ url: '/app/profile', pages, me: meOf({ accessMode: 'SUPPORT', user: { id: 'u1', email: '', displayName: '平台支持人员（只读）' } }) })
    const card = await screen.findByTestId('profile-density', {}, WAIT)
    expect(within(card).getByText(/^只读：/)).toBeInTheDocument()
    expect(app.calls.filter(call => call.path === '/me/preferences')).toHaveLength(0)
  })
})
