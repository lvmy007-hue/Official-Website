import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultNotifyPrefs, type NotifyPrefs, type PreferencesResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import type { Me } from '../../session/session'

// 个人账号页（P5-11）：个人资料、登录安全、会话管理、通知偏好四个页签。
// 假服务端返回固定数据，验证显示、提交内容（版本号、请求体）、冲突提示与禁用原因。

const pages: LivePages = { ProfilePage: { load: () => import('./ProfilePage') } }
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ok = (data: unknown) => ({ body: { success: true, data } })
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const meOf = (patch: Partial<Me> = {}): Me => ({
  ...defaultMe,
  user: { id: 'u1', email: 'owner@example.com', displayName: '林然' },
  tenant: { ...defaultMe.tenant, localTimezone: 'Asia/Shanghai' },
  mfa: { enrolled: false, pending: false, recoveryCodesRemaining: 0 },
  ...patch,
})
const prefs = (patch: Partial<PreferencesResponse> = {}, notify: NotifyPrefs = defaultNotifyPrefs()): PreferencesResponse => ({
  notify,
  favorites: [],
  density: 'STANDARD',
  version: 0,
  updatedAt: null,
  zone: 'Asia/Shanghai',
  ...patch,
})
const PREF = '/me/preferences'
const open = (url: string, handlers: Record<string, Handler> = {}, me: Me = meOf()) => mountApp({ url, pages, me, handlers })
const saveButton = () => screen.getByRole('button', { name: /^保\s?存$/ })

describe('个人资料', () => {
  it('显示名可改，邮箱、企业、企业本地时区只读并写明原因', T, async () => {
    open('/app/profile')
    expect(within(await screen.findByTestId('profile-displayName', {}, WAIT)).getByText('林然')).toBeInTheDocument()
    expect(within(screen.getByTestId('profile-displayName')).getByRole('button', { name: /修\s*改/ })).toBeEnabled()
    for (const id of ['email', 'tenant', 'zone']) {
      expect(within(screen.getByTestId(`profile-${id}`)).queryByRole('button')).not.toBeInTheDocument()
      expect(within(screen.getByTestId(`profile-${id}`)).getByText(/^只读：/)).toBeInTheDocument()
    }
    expect(within(screen.getByTestId('profile-zone')).getByText('Asia/Shanghai')).toBeInTheDocument()
  })

  it('修改显示名：空白被前端拦下；提交只带显示名；成功后重新读取当前登录人', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    let name = '林然'
    const app = open('/app/profile', {
      '/auth/me': (_url, init) => {
        if (init?.method === 'PATCH') {
          bodies.push(bodyOf(init))
          name = String(bodyOf(init).displayName)
          return ok({ displayName: name, changed: true })
        }
        return ok(meOf({ user: { id: 'u1', email: 'owner@example.com', displayName: name } }))
      },
    })
    await screen.findByTestId('profile-displayName', {}, WAIT)
    await userEvent.click(within(screen.getByTestId('profile-displayName')).getByRole('button', { name: /修\s*改/ }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('显示名')
    await userEvent.clear(input)
    await userEvent.type(input, '   ')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    expect(await within(dialog).findByText('请填写显示名')).toBeInTheDocument()
    expect(bodies).toEqual([])
    await userEvent.clear(input)
    await userEvent.type(input, '  林然然  ')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(bodies).toEqual([{ displayName: '林然然' }]))
    expect(within(await screen.findByTestId('profile-displayName', {}, WAIT)).getByText('林然然')).toBeInTheDocument()
    expect(app.calls.filter(call => call.path === '/auth/me' && call.method === 'GET').length).toBeGreaterThan(1)
  })

  it('平台支持访问：只读，不显示邮箱，修改入口禁用并说明', T, async () => {
    open('/app/profile', {}, meOf({ accessMode: 'SUPPORT', user: { id: 'u1', email: '', displayName: '平台支持人员（只读）' } }))
    expect(within(await screen.findByTestId('profile-displayName', {}, WAIT)).getByText('平台支持人员（只读）')).toBeInTheDocument()
    expect(within(screen.getByTestId('profile-displayName')).getByRole('button', { name: /修\s*改/ })).toBeDisabled()
    expect(within(screen.getByTestId('profile-email')).getByText('—')).toBeInTheDocument()
  })
})

describe('登录安全与会话管理', () => {
  it('地址栏 ?mfa=required：直接落在登录安全并提示必须先启用', T, async () => {
    open('/app/profile?mfa=required')
    expect(await screen.findByText('管理员账号必须先启用多因素认证', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /启用多因素认证/ })).toBeInTheDocument()
  })

  it('绑定：先领取密钥，再提交 6 位验证码；成功后显示恢复码，勾选已保存才能完成', T, async () => {
    const order: string[] = []
    let enrolled = false
    open('/app/profile?tab=security', {
      '/auth/me': () => ok(meOf({ mfa: { enrolled, pending: false, recoveryCodesRemaining: enrolled ? 8 : 0 } })),
      '/auth/mfa/enroll': () => (order.push('enroll'), ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Nova:owner?secret=JBSWY3DPEHPK3PXP' })),
      '/auth/mfa/verify': (_url, init) => {
        order.push(`verify:${String(bodyOf(init).code)}`)
        enrolled = true
        return ok({ recoveryCodes: ['AAAA-1111', 'BBBB-2222'] })
      },
    })
    expect(await screen.findByText('未启用', {}, WAIT)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /启用多因素认证/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument()
    const submit = within(dialog).getByRole('button', { name: /验证并启用/ })
    expect(submit).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('6 位验证码'), '12a3456')
    expect(submit).toBeEnabled()
    await userEvent.click(submit)
    expect(await screen.findByText('AAAA-1111', {}, WAIT)).toBeInTheDocument()
    expect(order).toEqual(['enroll', 'verify:123456'])
    const done = screen.getByRole('button', { name: /^完\s?成$/ })
    expect(done).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /已妥善保存恢复码/ }))
    expect(done).toBeEnabled()
    expect(await screen.findByText(/剩余恢复码 8 个/, {}, WAIT)).toBeInTheDocument()
  })

  it('验证码错误：显示服务端给的原因，不显示启用成功', T, async () => {
    open('/app/profile?tab=security', {
      '/auth/mfa/enroll': () => ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Nova:owner?secret=JBSWY3DPEHPK3PXP' }),
      '/auth/mfa/verify': () => ({ status: 403, body: { error: { code: 'MFA_CODE_INVALID', message: '验证码不正确' } } }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /启用多因素认证/ }, WAIT))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(await within(dialog).findByLabelText('6 位验证码'), '000000')
    await userEvent.click(within(dialog).getByRole('button', { name: /验证并启用/ }))
    expect(await screen.findByText(/验证码不正确或已使用过/, {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByText('保存恢复码')).not.toBeInTheDocument()
  })

  it('会话管理：标出当前设备；注销别的设备只调用一次 DELETE 并重新读取', T, async () => {
    const deleted: string[] = []
    let rows = [
      { id: 's1', device: 'Chrome · Windows', ipMasked: '203.0.113.*', signedInAt: '2026-10-24T01:00:00Z', lastSeenAt: '2026-10-25T01:00:00Z', expiresAt: '2026-11-24T01:00:00Z', current: true },
      { id: 's2', device: 'Safari · iPhone', ipMasked: null, signedInAt: '2026-10-20T01:00:00Z', lastSeenAt: '2026-10-22T01:00:00Z', expiresAt: '2026-11-20T01:00:00Z', current: false },
    ]
    open('/app/profile?tab=sessions', {
      '/auth/sessions': () => ok({ items: rows, total: rows.length }),
      '/auth/sessions/s2': (_url, init) => {
        if (init?.method === 'DELETE') {
          deleted.push('s2')
          rows = rows.filter(row => row.id !== 's2')
        }
        return ok({ revoked: true, current: false })
      },
    })
    expect(await screen.findByText('Safari · iPhone', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('当前设备')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /注\s?销/ }))
    await userEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: /注\s?销/ }))
    await waitFor(() => expect(deleted).toEqual(['s2']))
    await waitFor(() => expect(screen.queryByText('Safari · iPhone')).not.toBeInTheDocument(), WAIT)
  })
})

describe('通知偏好', () => {
  it('默认全部接收、免打扰关闭；没改动时保存禁用；说明按企业本地时区与严重级别不受限', T, async () => {
    open('/app/profile?tab=notify', { [PREF]: () => ok(prefs()) })
    expect(await screen.findByText(/时段按企业本地时区（Asia\/Shanghai）计算/, {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText(/严重级别通知与待办超时升级通知不受免打扰限制/)).toBeInTheDocument()
    expect(screen.getByText(/还没有保存过，当前是默认设置/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '库存·严重' })).toBeChecked()
    expect(screen.getByRole('switch', { name: '开启免打扰' })).not.toBeChecked()
    expect(screen.getByLabelText('免打扰开始时间')).toBeDisabled()
    expect(saveButton()).toBeDisabled()
  })

  it('关掉库存·提示、开启免打扰并改时间：提交带整份偏好与读取时的版本号；保存后版本更新', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    let saved: NotifyPrefs | null = null
    let version = 3
    open('/app/profile?tab=notify', {
      [PREF]: (_url, init) => {
        if (init?.method === 'PUT') {
          const body = bodyOf(init)
          bodies.push(body)
          saved = body.notify as NotifyPrefs
          version += 1
          return ok({ version })
        }
        return ok(prefs({ version, updatedAt: '2026-10-24T01:00:00Z' }, saved ?? defaultNotifyPrefs()))
      },
    })
    await screen.findByText(/最近保存：/, {}, WAIT)
    await userEvent.click(screen.getByRole('switch', { name: '库存·提示' }))
    expect(saveButton()).toBeEnabled()
    await userEvent.click(screen.getByRole('switch', { name: '开启免打扰' }))
    const start = screen.getByLabelText('免打扰开始时间')
    await userEvent.clear(start)
    await userEvent.type(start, '23:30')
    await userEvent.click(saveButton())
    await waitFor(() => expect(bodies.length).toBe(1))
    const sent = bodies[0] as { notify: NotifyPrefs; version: number }
    expect(sent.version).toBe(3)
    expect(sent.notify.domains.INVENTORY).toEqual({ INFO: false, WARNING: true, CRITICAL: true })
    expect(sent.notify.domains.FINANCE).toEqual({ INFO: true, WARNING: true, CRITICAL: true })
    expect(sent.notify.dnd).toEqual({ enabled: true, start: '23:30', end: '08:00' })
    // 保存后重新取数，草稿与服务端一致，保存再次禁用
    await waitFor(() => expect(saveButton()).toBeDisabled(), WAIT)
    expect(screen.getByRole('switch', { name: '库存·提示' })).not.toBeChecked()
  })

  it('开始与结束时间相同：前端提示并禁用保存，不调用服务端', T, async () => {
    const puts: unknown[] = []
    open('/app/profile?tab=notify', { [PREF]: (_url, init) => (init?.method === 'PUT' ? (puts.push(1), ok({ version: 1 })) : ok(prefs())) })
    await screen.findByText(/时段按企业本地时区/, {}, WAIT)
    await userEvent.click(screen.getByRole('switch', { name: '开启免打扰' }))
    const end = screen.getByLabelText('免打扰结束时间')
    await userEvent.clear(end)
    await userEvent.type(end, '22:00')
    expect(await screen.findByText(/开始与结束时间不能相同/)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    expect(puts).toEqual([])
  })

  it('别处已修改（409）：提示并刷新为最新内容，不假装保存成功', T, async () => {
    let latest = prefs({ version: 2, updatedAt: '2026-10-24T01:00:00Z' })
    let conflicted = false
    open('/app/profile?tab=notify', {
      [PREF]: (_url, init) => {
        if (init?.method === 'PUT') {
          conflicted = true
          const next = defaultNotifyPrefs()
          next.domains.ADS.WARNING = false
          latest = prefs({ version: 3, updatedAt: '2026-10-25T01:00:00Z' }, next)
          return { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: '偏好已被修改' } } }
        }
        return ok(latest)
      },
    })
    await screen.findByText(/最近保存：/, {}, WAIT)
    await userEvent.click(screen.getByRole('switch', { name: '财务·提示' }))
    await userEvent.click(saveButton())
    expect(await screen.findByText(/已在别处被修改，已为你刷新为最新内容/, {}, WAIT)).toBeInTheDocument()
    expect(conflicted).toBe(true)
    await waitFor(() => expect(screen.getByRole('switch', { name: '广告·警告' })).not.toBeChecked(), WAIT)
    expect(screen.getByRole('switch', { name: '财务·提示' })).toBeChecked()
    expect(screen.queryByText('通知偏好已保存')).not.toBeInTheDocument()
  })

  it('读取失败：显示错误并可重试，不显示成默认值', T, async () => {
    open('/app/profile?tab=notify', { [PREF]: () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } } }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 20000 })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('switch', { name: '库存·提示' })).not.toBeInTheDocument()
  })
})
