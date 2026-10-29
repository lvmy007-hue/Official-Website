import { useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { apiFetch } from '../../api'
import { useScope } from '../scope/context'
import { getActiveTenantId } from '../session/tenant-store'
import { staleTimeOf, type DataDomain } from './domains'

// 页面取数的统一入口（P1-06）：
// - 缓存键 = [企业, 数据域, 请求地址]，切换企业不会串数据；
// - 业务数据域默认自动带上全局范围参数，范围一变所有页面重新取数；
// - 缓存新鲜时间由数据域决定；写请求自动带幂等键（在 apiFetch 里）。

type Param = string | number | boolean | readonly string[] | null | undefined

/** 拼接请求地址：数组用逗号连接，空值不写。 */
export function buildPath(path: string, params: Record<string, Param> = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','))
    } else search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path
}

/** 数据域是否默认带范围参数：业务数据带，登录、基础资料、设置不带。 */
const SCOPED_BY_DEFAULT: Record<DataDomain, boolean> = { session: false, reference: false, config: false, list: true, analytics: true, realtime: true }

export type ApiQueryOptions<T, S = T> = {
  domain: DataDomain
  /** 以 / 开头的接口路径，不含 /api/v1。 */
  path: string
  params?: Record<string, Param>
  /** 是否带全局范围参数，缺省按数据域。 */
  scoped?: boolean
  enabled?: boolean
  select?: (data: T) => S
  /** 覆盖数据域的新鲜时间。 */
  staleMs?: number
  /** 轮询间隔（毫秒），用于任务进度等。 */
  refetchIntervalMs?: number | false | ((data: T | undefined) => number | false)
}

export function apiQueryKey(domain: DataDomain, url: string): QueryKey {
  return [getActiveTenantId() ?? 'anonymous', domain, url]
}

export function useApiQuery<T, S = T>(options: ApiQueryOptions<T, S>): UseQueryResult<S> {
  const { apiParams } = useScope()
  const scoped = options.scoped ?? SCOPED_BY_DEFAULT[options.domain]
  const url = buildPath(options.path, { ...(scoped ? apiParams : {}), ...options.params })
  return useQuery({
    queryKey: apiQueryKey(options.domain, url),
    queryFn: ({ signal }) => apiFetch<T>(url, { signal }),
    staleTime: options.staleMs ?? staleTimeOf(options.domain),
    enabled: options.enabled,
    select: options.select,
    refetchInterval:
      typeof options.refetchIntervalMs === 'function'
        ? (query: { state: { data: unknown } }) => (options.refetchIntervalMs as (data: T | undefined) => number | false)(query.state.data as T | undefined)
        : options.refetchIntervalMs,
  })
}

export type ApiMutationOptions<V, R> = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string | ((variables: V) => string)
  /** 请求体；缺省把变量整体作为请求体。 */
  body?: (variables: V) => unknown
  /** 成功后让这些数据域的缓存失效并重新取数。 */
  invalidate?: readonly DataDomain[]
  /** 失败时不弹统一提示（页面自己处理字段错误时使用）。 */
  silent?: boolean
  onSuccess?: (result: R, variables: V) => void
}

export function useApiMutation<V = void, R = unknown>(options: ApiMutationOptions<V, R>) {
  const client = useQueryClient()
  return useMutation<R, Error, V>({
    meta: { silent: options.silent === true },
    mutationFn: variables => {
      const path = typeof options.path === 'function' ? options.path(variables) : options.path
      const payload = options.body ? options.body(variables) : variables
      return apiFetch<R>(path, { method: options.method, body: payload === undefined ? undefined : JSON.stringify(payload) })
    },
    onSuccess: async (result, variables) => {
      const domains = new Set<string>(options.invalidate ?? [])
      if (domains.size) await client.invalidateQueries({ predicate: query => domains.has(String(query.queryKey[1])) })
      options.onSuccess?.(result, variables)
    },
  })
}
