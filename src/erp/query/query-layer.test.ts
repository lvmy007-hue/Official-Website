import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api'
import { DATA_DOMAINS, staleTimeOf } from './domains'
import { createQueryClient, enforceCacheLimit, resetForTenantChange, setErrorNotifier } from './client'
import { buildPath } from './api-query'
import { describeError, shouldRetry } from './errors'

describe('错误归类', () => {
  const api = (status: number, code?: string, extra = {}) => new ApiError(status, code, '出错了', undefined, extra)

  it('按状态码与错误码归成页面能用的几类', () => {
    expect(describeError(api(401)).kind).toBe('unauthorized')
    expect(describeError(api(403, 'FORBIDDEN')).kind).toBe('forbidden')
    expect(describeError(api(404)).kind).toBe('not-found')
    expect(describeError(api(409, 'CONFLICT')).kind).toBe('conflict')
    expect(describeError(api(422)).kind).toBe('validation')
    expect(describeError(api(429)).kind).toBe('rate-limited')
    expect(describeError(api(500)).kind).toBe('server')
    expect(describeError(api(504, 'QUERY_TIMEOUT')).kind).toBe('timeout')
    expect(describeError(new TypeError('Failed to fetch')).kind).toBe('network')
  })

  it('带出请求编号、可重试标记与字段错误，方便页面展示与反馈', () => {
    const info = describeError(api(500, 'INTERNAL', { requestId: 'req_abc', retryable: true, fieldErrors: { name: ['必填'] } }))
    expect(info).toMatchObject({ requestId: 'req_abc', retryable: true, fieldErrors: { name: ['必填'] } })
  })

  it('只自动重试网络、限流与服务端故障；4xx 与查询超时不重试；最多两次', () => {
    expect(shouldRetry(api(500), 0)).toBe(true)
    expect(shouldRetry(api(500), 2)).toBe(false)
    expect(shouldRetry(new TypeError('x'), 1)).toBe(true)
    expect(shouldRetry(api(429), 0)).toBe(true)
    expect(shouldRetry(api(403), 0)).toBe(false)
    expect(shouldRetry(api(422), 0)).toBe(false)
    expect(shouldRetry(api(504, 'QUERY_TIMEOUT'), 0)).toBe(false)
  })
})

describe('缓存新鲜时间按数据域设置', () => {
  it('越实时的数据域越短', () => {
    expect(staleTimeOf('realtime')).toBeLessThan(staleTimeOf('list'))
    expect(staleTimeOf('list')).toBeLessThan(staleTimeOf('analytics'))
    expect(Object.keys(DATA_DOMAINS).sort()).toEqual(['analytics', 'config', 'list', 'realtime', 'reference', 'session'])
  })
})

describe('请求地址拼接', () => {
  it('数组用逗号连接，空值不写，参数按字母顺序保证缓存键稳定', () => {
    expect(buildPath('/orders', { storeIds: ['a', 'b'], q: '', from: '2026-10-01', empty: [], none: undefined })).toBe('/orders?from=2026-10-01&storeIds=a%2Cb')
    expect(buildPath('/orders?x=1', { y: 2 })).toBe('/orders?x=1&y=2')
    expect(buildPath('/orders')).toBe('/orders')
  })
})

describe('缓存上限与回收', () => {
  it('超过上限时回收最旧且无人使用的条目', () => {
    const client = new QueryClient()
    for (let i = 0; i < 10; i += 1) client.setQueryData(['t', 'list', `/q${i}`], i, { updatedAt: 1000 + i })
    const removed = enforceCacheLimit(client, 6)
    expect(removed).toBe(4)
    const left = client
      .getQueryCache()
      .getAll()
      .map(query => query.queryKey[2])
    expect(left).toEqual(['/q4', '/q5', '/q6', '/q7', '/q8', '/q9'])
  })

  it('正在被页面使用的条目不会被回收', () => {
    const client = new QueryClient()
    client.setQueryData(['t', 'list', '/old'], 1, { updatedAt: 1 })
    client.setQueryData(['t', 'list', '/new'], 2, { updatedAt: 2 })
    const used = client.getQueryCache().find({ queryKey: ['t', 'list', '/old'] })!
    vi.spyOn(used, 'getObserversCount').mockReturnValue(1)
    enforceCacheLimit(client, 1)
    expect(
      client
        .getQueryCache()
        .getAll()
        .map(query => query.queryKey[2]),
    ).toEqual(['/old'])
  })

  it('新增缓存时自动触发回收，缓存条目数不会无限增长', () => {
    const client = createQueryClient()
    for (let i = 0; i < 320; i += 1) client.setQueryData(['t', 'list', `/q${i}`], i, { updatedAt: i + 1 })
    expect(client.getQueryCache().getAll().length).toBeLessThanOrEqual(300)
  })
})

describe('切换租户清空缓存', () => {
  it('清空后上一个企业的数据不再可读', () => {
    const client = createQueryClient()
    client.setQueryData(['t1', 'list', '/orders'], { items: [1] })
    resetForTenantChange(client)
    expect(client.getQueryData(['t1', 'list', '/orders'])).toBeUndefined()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })
})

describe('写操作失败的统一提示', () => {
  it('写操作失败走统一提示；标记为静默的由页面自己处理', async () => {
    const client = createQueryClient()
    const seen = vi.fn()
    setErrorNotifier(seen)
    const failing = () => Promise.reject(new ApiError(409, 'CONFLICT', '数据已被他人修改'))
    await client
      .getMutationCache()
      .build(client, { mutationFn: failing })
      .execute(undefined)
      .catch(() => undefined)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'conflict', message: '数据已被他人修改' }))
    seen.mockClear()
    await client
      .getMutationCache()
      .build(client, { mutationFn: failing, meta: { silent: true } })
      .execute(undefined)
      .catch(() => undefined)
    expect(seen).not.toHaveBeenCalled()
  })
})
