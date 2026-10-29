import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { setAccessToken } from '../../api'
import { CACHE_GC_MS, CACHE_MAX_ENTRIES } from './domains'
import { describeError, shouldRetry, type ErrorInfo } from './errors'

// 请求层的全局配置（P1-06）：缓存回收、重试策略、统一错误处理、切换租户清缓存。

export type ErrorNotifier = (info: ErrorInfo) => void
export type UnauthorizedHandler = () => void

let notifier: ErrorNotifier = () => undefined
let onUnauthorized: UnauthorizedHandler = () => undefined

/** 注册写操作失败时的提示方式（由外壳接上界面提示）。 */
export const setErrorNotifier = (fn: ErrorNotifier) => {
  notifier = fn
}
/** 注册登录失效后的处理（由外壳接上跳转登录页）。 */
export const setUnauthorizedHandler = (fn: UnauthorizedHandler) => {
  onUnauthorized = fn
}

/** 回收超限缓存：只回收当前无人使用的条目，按最后更新时间从旧到新。 */
export function enforceCacheLimit(client: QueryClient, max = CACHE_MAX_ENTRIES) {
  const cache = client.getQueryCache()
  const all = cache.getAll()
  if (all.length <= max) return 0
  const removable = all.filter(query => query.getObserversCount() === 0).sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
  let removed = 0
  for (const query of removable) {
    if (all.length - removed <= max) break
    cache.remove(query)
    removed += 1
  }
  return removed
}

function handleFailure(error: unknown, silent: boolean) {
  const info = describeError(error)
  if (info.kind === 'unauthorized') {
    // 刷新凭据也失败：本地不再保留任何令牌，回到登录页
    setAccessToken(null)
    onUnauthorized()
    return
  }
  if (!silent) notifier(info)
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      // 查询失败由页面用“服务端错误 / 无权限 / 延迟”等状态呈现，这里只处理登录失效
      onError: error => {
        if (describeError(error).kind === 'unauthorized') handleFailure(error, true)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => handleFailure(error, mutation.meta?.silent === true),
    }),
    defaultOptions: {
      queries: {
        gcTime: CACHE_GC_MS,
        staleTime: 60_000,
        retry: (count, error) => shouldRetry(error, count),
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: false,
      },
      // 写操作不自动重试：重复提交由幂等键兜底，是否再试交给用户
      mutations: { retry: false },
    },
  })
  client.getQueryCache().subscribe(event => {
    if (event.type === 'added') enforceCacheLimit(client)
  })
  return client
}

/**
 * 切换租户（或登录身份变化）时清空全部缓存：
 * 否则上一个企业的数据可能在新企业的页面里闪现。
 */
export function resetForTenantChange(client: QueryClient) {
  void client.cancelQueries()
  client.clear()
}
