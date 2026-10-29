import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { densityOf, favoritesOf, type Density, type PreferencesResponse } from '@nova/api-contracts'
import { apiFetch } from '../../api'
import { apiQueryKey, useApiQuery } from '../query/api-query'
import { describeError } from '../query/errors'
import { useSession } from '../session/session'
import { setDensity } from '../theme/density'

// 外壳偏好（P6-01）：侧边导航收藏与界面密度，存在服务端的个人偏好里（GET、PUT /me/preferences），换设备也在。
// 内部访问与平台支持访问没有个人账号，没有偏好：收藏与密度开关不显示，密度用本机缓存或默认值。

const PREFS_PATH = '/me/preferences'
// 缓存键带当前企业编号，要在调用时才算（模块加载时还没有企业）
const prefsKey = () => apiQueryKey('config', PREFS_PATH)

export type PrefsPatch = { favorites?: string[]; density?: Density }
export type PrefsSnapshot = { favorites: string[]; density: Density; version: number }

const snapshotOf = (data: PreferencesResponse): PrefsSnapshot => ({ favorites: favoritesOf(data.favorites), density: densityOf(data.density), version: data.version })

export function useShellPrefs() {
  const { me } = useSession()
  const client = useQueryClient()
  const enabled = me.accessMode === 'NORMAL'
  const query = useApiQuery<PreferencesResponse>({ domain: 'config', path: PREFS_PATH, scoped: false, enabled })
  const data = query.data ? snapshotOf(query.data) : undefined
  // 服务端的密度是准的：读到以后同步到本机，主题随之切换
  useEffect(() => {
    if (data) setDensity(data.density)
  }, [data?.density]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 保存：build 根据“当前偏好”算出要改的项（不用改返回 null）；先乐观更新界面，版本冲突（另一台设备刚改过）时重新读取、
   * 在最新内容上重算一次再保存；仍失败就还原并抛出，由调用方提示。
   */
  const save = useCallback(
    async (build: (current: PrefsSnapshot) => PrefsPatch | null): Promise<void> => {
      const read = () => client.getQueryData<PreferencesResponse>(prefsKey())
      const refresh = () => client.fetchQuery({ queryKey: prefsKey(), queryFn: () => apiFetch<PreferencesResponse>(PREFS_PATH), staleTime: 0 })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = snapshotOf(read() ?? (await refresh()))
        const patch = build(current)
        if (!patch) return
        const before = read()
        if (before)
          client.setQueryData<PreferencesResponse>(prefsKey(), { ...before, ...(patch.favorites ? { favorites: patch.favorites } : {}), ...(patch.density ? { density: patch.density } : {}) })
        if (patch.density) setDensity(patch.density)
        try {
          const saved = await apiFetch<PreferencesResponse>(PREFS_PATH, { method: 'PUT', body: JSON.stringify({ ...patch, version: current.version }) })
          client.setQueryData(prefsKey(), saved)
          return
        } catch (error) {
          if (before) client.setQueryData(prefsKey(), before)
          if (before?.density) setDensity(densityOf(before.density))
          if (describeError(error).kind === 'conflict' && attempt === 0) {
            await refresh()
            continue
          }
          throw error
        }
      }
    },
    [client],
  )

  return { enabled, ready: Boolean(data), loading: enabled && query.isPending, failed: enabled && query.isError, favorites: data?.favorites ?? [], density: data?.density, save }
}
