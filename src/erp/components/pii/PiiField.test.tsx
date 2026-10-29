import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, jsonResponse } from '../../test/app-harness'
import { renderWithApp } from '../../test/render'
import type { Me } from '../../session/session'
import { PiiField, type PiiFieldSpec } from './PiiField'

// 个人信息字段（P6-14）：默认遮罩；没有 field.buyer 不能查看；理由必填；服务端拒绝、过期、没有内容时如实说明；换对象或到点就清掉明文。

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const FIELDS: readonly PiiFieldSpec[] = [
  { name: 'buyerName', label: '姓名' },
  { name: 'buyerPhone', label: '电话' },
]
const meWith = (permissions: string[]): Me => ({ ...defaultMe, permissions })
const revealOk = (objectId = 'o1') => ({
  objectType: 'ORDER',
  objectId,
  state: 'OK',
  values: { buyerName: '张三', buyerPhone: null },
  expiresAt: '2026-10-27T10:01:00.000Z',
  retainedUntil: null,
  note: null,
})

const stubReveal = (respond: (body: Record<string, unknown>) => { status: number; body: unknown }) => {
  const calls: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes('/pii/reveal')) {
        const body = JSON.parse(String(init?.body))
        calls.push(body)
        const out = respond(body)
        return jsonResponse(out.status, out.body)
      }
      return jsonResponse(200, { success: true, data: {} })
    }),
  )
  return calls
}

const reveal = async (reason = '客服处理退款咨询') => {
  await userEvent.click(screen.getByRole('button', { name: /查看明文/ }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.type(within(dialog).getByRole('textbox', { name: '查看原因' }), reason)
  await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
}

describe('PiiField', () => {
  it('默认只有锁与遮罩，没有任何明文', () => {
    renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['field.buyer']) })
    expect(screen.getAllByLabelText('已隐藏')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('张三')
  })

  it('没有 field.buyer：按钮禁用，不发任何请求', async () => {
    const calls = stubReveal(() => ({ status: 200, body: { success: true, data: revealOk() } }))
    renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['orders.read']) })
    const button = screen.getByRole('button', { name: /查看明文/ })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(calls).toHaveLength(0)
  })

  it('理由必填；填写后带着对象与字段发出；立即隐藏后明文消失', async () => {
    const calls = stubReveal(() => ({ status: 200, body: { success: true, data: revealOk() } }))
    renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['field.buyer']) })
    await userEvent.click(screen.getByRole('button', { name: /查看明文/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
    await userEvent.type(within(dialog).getByRole('textbox', { name: '查看原因' }), '客服处理退款咨询')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    expect(await screen.findByTestId('pii-revealed')).toHaveTextContent('张三')
    expect(screen.getByTestId('pii-revealed')).toHaveTextContent('尚无记录')
    expect(calls).toEqual([{ objectType: 'ORDER', objectId: 'o1', fields: ['buyerName', 'buyerPhone'], reason: '客服处理退款咨询' }])
    await userEvent.click(screen.getByRole('button', { name: '立即隐藏' }))
    await waitFor(() => expect(document.body.textContent).not.toContain('张三'))
  })

  it('服务端拒绝：显示原因，页面上不出现明文', async () => {
    stubReveal(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: '没有查看买家信息的权限' } } }))
    renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['field.buyer']) })
    await reveal()
    expect(await screen.findByRole('alert')).toHaveTextContent('没有查看买家信息的权限')
    expect(document.body.textContent).not.toContain('张三')
  })

  it('已过保留期与没有内容：写明原因，不显示明文', async () => {
    stubReveal(() => ({ status: 200, body: { success: true, data: { objectType: 'ORDER', objectId: 'o1', state: 'EXPIRED', values: {}, expiresAt: null, retainedUntil: null, note: null } } }))
    renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['field.buyer']) })
    await reveal()
    expect(await screen.findByText(/已超过保留期/)).toBeInTheDocument()
    expect(screen.queryByTestId('pii-revealed')).not.toBeInTheDocument()
  })

  it('对象换了：之前看到的明文立刻清除', async () => {
    stubReveal(() => ({ status: 200, body: { success: true, data: revealOk() } }))
    const { rerender } = renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['field.buyer']) })
    await reveal()
    await screen.findByTestId('pii-revealed')
    rerender(<PiiField objectType="ORDER" objectId="o2" fields={FIELDS} />)
    await waitFor(() => expect(screen.queryByTestId('pii-revealed')).not.toBeInTheDocument())
    expect(document.body.textContent).not.toContain('张三')
  })

  it('到点自动隐藏', async () => {
    stubReveal(() => ({ status: 200, body: { success: true, data: revealOk() } }))
    renderWithApp(<PiiField objectType="ORDER" objectId="o1" fields={FIELDS} />, { me: meWith(['field.buyer']) })
    await reveal()
    await screen.findByTestId('pii-revealed')
    expect(screen.getByTestId('pii-field')).toHaveTextContent('60 秒后自动隐藏')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await waitFor(() => expect(screen.queryByTestId('pii-revealed')).not.toBeInTheDocument(), { timeout: 4000 })
  })

  it('文字布局：遮罩状态显示传入的已掩码内容与类别；没有内容可看时只给说明、不给按钮', () => {
    const { rerender } = renderWithApp(
      <PiiField objectType="SUPPORT_CONTACT" objectId="k1" fields={[{ name: 'body', label: '正文' }]} layout="text" kinds={['PHONE']} maskedContent="电话 [电话已隐藏]" />,
      {
        me: meWith(['field.buyer']),
      },
    )
    expect(screen.getByTestId('pii-masked-block')).toHaveTextContent('[电话已隐藏]')
    expect(screen.getByText('电话')).toBeInTheDocument()
    rerender(<PiiField objectType="SUPPORT_CONTACT" objectId="k1" fields={[{ name: 'body', label: '正文' }]} layout="text" available={false} unavailableNote="已清除" />)
    expect(screen.getByText('已清除')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /查看明文/ })).not.toBeInTheDocument()
  })
})
