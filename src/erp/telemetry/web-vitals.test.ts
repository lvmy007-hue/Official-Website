import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeRouteTemplate } from '@nova/api-contracts'
import { apiFetch, setAccessToken, setApiTimingListener } from '../../api'
import { createVitalsReporter, type VitalItem } from './web-vitals'

// 性能埋点（P1-09）：只含指标名、耗时与路由模板，不含个人信息。
describe('路由模板归一', () => {
  it('去掉查询参数，把形似编号的段换成 :id', () => {
    expect(normalizeRouteTemplate('/orders/ckabcdefghij1234567890/items?page=2&q=张三')).toBe('/orders/:id/items')
    expect(normalizeRouteTemplate('/app/orders/12345')).toBe('/app/orders/:id')
    expect(normalizeRouteTemplate('/app/advertising/campaigns')).toBe('/app/advertising/campaigns')
    expect(normalizeRouteTemplate('/scope/options#top')).toBe('/scope/options')
  })
})

describe('指标缓冲与上报', () => {
  const sample = (route: string, valueMs = 120.4): VitalItem => ({ name: 'API', valueMs, route })

  it('登录前先缓冲，登录后一次性上报；耗时取整、路径归一', async () => {
    let allowed = false
    const send = vi.fn().mockResolvedValue(undefined)
    const reporter = createVitalsReporter({ send, canSend: () => allowed })
    reporter.add(sample('/orders/9876543210/items?x=1'))
    await reporter.flush()
    expect(send).not.toHaveBeenCalled()
    allowed = true
    await reporter.flush()
    expect(send).toHaveBeenCalledWith([{ name: 'API', valueMs: 120, route: '/orders/:id/items' }])
    expect(reporter.size()).toBe(0)
  })

  it('每批最多 30 条；缓冲满了丢最旧的；非法耗时被忽略', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const reporter = createVitalsReporter({ send, canSend: () => true, maxBuffer: 70 })
    for (let index = 0; index < 80; index += 1) reporter.add(sample(`/r${index}`, index))
    reporter.add(sample('/bad', Number.NaN))
    reporter.add(sample('/neg', -1))
    expect(reporter.size()).toBe(70)
    await reporter.flush()
    expect(send.mock.calls.map(call => call[0].length)).toEqual([30, 30, 10])
    expect(send.mock.calls[0][0][0].route).toBe('/r10')
  })

  it('上报失败直接丢弃该批，不抛错也不重试', async () => {
    const send = vi.fn().mockRejectedValue(new Error('网络错误'))
    const reporter = createVitalsReporter({ send, canSend: () => true })
    reporter.add(sample('/a'))
    await expect(reporter.flush()).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
    expect(reporter.size()).toBe(0)
  })
})

describe('接口耗时观察', () => {
  afterEach(() => {
    setApiTimingListener(null)
    setAccessToken(null)
    vi.unstubAllGlobals()
  })

  it('一次调用只记一次；登录过期后自动重试也只记一次', async () => {
    const calls: Array<[string, number]> = []
    setApiTimingListener((path, ms) => calls.push([path, ms]))
    setAccessToken('old')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accessToken: 'new' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/orders?page=1')).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/orders?page=1')
    expect(calls[0][1]).toBeGreaterThanOrEqual(0)
  })

  it('请求失败也记录耗时，错误照常抛出', async () => {
    const calls: string[] = []
    setApiTimingListener(path => calls.push(path))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INTERNAL', message: '出错' } }), { status: 500, headers: { 'content-type': 'application/json' } })))
    await expect(apiFetch('/inventory')).rejects.toMatchObject({ status: 500 })
    expect(calls).toEqual(['/inventory'])
  })
})
