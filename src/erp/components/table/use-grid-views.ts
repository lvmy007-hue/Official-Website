import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MIGRATED_VIEW_NAME, emptyViewConfig, pickDefaultView, sortViews, type GridViewConfig, type GridViewItem, type GridViewListResponse, type GridViewScope } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { apiQueryKey, buildPath, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useOptionalSession } from '../../session/session'
import { applyVisibility, clearLegacyHidden, hasLegacyHidden, loadHidden, saveHidden } from './grid-hidden'
import { applyLayout, countInvalid, dropInvalid, sameConfig, withBinding, type LayoutEvent, type ViewFilterBinding } from './grid-view-layout'
import type { ErpColDef } from './grid-types'
import { columnId } from './grid-types'

// 表格的服务端视图状态（P6-03）。一个视图 = 列显示、顺序、列宽、固定、排序、筛选、维度，分我的 / 团队 / 系统三级；
// 进入表格时用默认视图（我的默认 → 团队默认 → 系统默认），没有就用页面自己的默认。
// - 工作中的修改（拖列、改列宽、隐藏列、改排序与筛选）不会立刻保存：显示“有未保存的修改”，由人选“保存修改”或“另存为”；
// - 本机旧的列配置（erp.grid.<表格>.hidden-columns）第一次加载时迁成“我的默认视图”（已有个人默认就迁成不默认的同名视图），成功后删掉本机副本；
// - 视图里引用了已不存在的列、排序或筛选值：忽略并提示“有 N 个条件已失效”，不报错；
// - 读取失败时表格照常用页面默认列显示，并提示“视图暂时不可用”；内部访问与支持访问没有个人账号，不启用服务端视图（沿用本机列配置）。

const LIST_PATH = '/grid-views'

export type GridViewSaveInput = { name: string; scope: GridViewScope; isDefault: boolean }
export type SortLike = { field: string; direction: 'asc' | 'desc' }

export type GridViewsApi = {
  status: 'loading' | 'ready' | 'error'
  items: GridViewItem[]
  active: GridViewItem | null
  /** 当前工作内容和已套用的视图（或页面默认）不一样。 */
  dirty: boolean
  canShare: boolean
  limits: { user: number; team: number }
  /** 视图里已失效、被忽略的条件个数。 */
  invalid: number
  apply: (id: string | null) => void
  saveAs: (input: GridViewSaveInput) => Promise<GridViewItem>
  overwrite: () => Promise<GridViewItem>
  remove: (item: GridViewItem) => Promise<void>
  makeDefault: (item: GridViewItem) => Promise<void>
  retry: () => void
}

type Options = {
  gridId: string
  columnIds: readonly string[]
  sortFields: readonly string[] | null
  /** 当前排序（null 表示页面默认排序）；undefined 表示这个表格不跟踪排序，保存时沿用视图里原来的排序。 */
  sort?: SortLike | null
  binding?: ViewFilterBinding
}

const sameGroup = (a: GridViewItem, b: GridViewItem) => a.scope === b.scope && a.gridId === b.gridId && a.kind === b.kind

function useServerViews(options: Options & { enabled: boolean }) {
  const { gridId, columnIds, sortFields, enabled } = options
  const client = useQueryClient()
  const listUrl = buildPath(LIST_PATH, { gridId })
  const listKey = apiQueryKey('config', listUrl)
  const query = useApiQuery<GridViewListResponse>({ domain: 'config', path: LIST_PATH, params: { gridId }, scoped: false, enabled })
  const [activeId, setActiveId] = useState<string | null | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const [legacy, setLegacy] = useState<string[] | null>(() => (enabled && hasLegacyHidden(gridId) ? loadHidden(gridId) : null))
  const [ignored, setIgnored] = useState(0)
  const forceApply = useRef(false)
  const bindingRef = useRef(options.binding)
  bindingRef.current = options.binding

  const status: GridViewsApi['status'] = query.isError ? 'error' : query.data ? 'ready' : 'loading'
  const items = useMemo(() => query.data?.items ?? [], [query.data])
  const resolved = useMemo(() => {
    if (status !== 'ready') return null
    if (activeId === undefined) return pickDefaultView(items)
    return activeId === null ? null : (items.find(item => item.id === activeId) ?? null)
  }, [status, items, activeId])

  const base = useMemo<GridViewConfig>(() => {
    if (resolved) return dropInvalid(resolved.config, columnIds, sortFields)
    return legacy && legacy.length > 0 ? { ...emptyViewConfig(), hidden: legacy } : emptyViewConfig()
  }, [resolved, legacy, columnIds, sortFields])

  // 工作中的版式（隐藏、顺序、列宽、固定）：套用的视图变了就重置为该视图
  const key = `${status}|${resolved?.id ?? '-'}|${nonce}`
  const [seen, setSeen] = useState('')
  const [work, setWork] = useState<GridViewConfig>(emptyViewConfig)
  if (seen !== key) {
    setSeen(key)
    setWork(base)
  }

  // 套用视图里的筛选与维度：没有筛选的初始状态不去动页面的默认值
  useEffect(() => {
    if (status !== 'ready') return
    const config = resolved?.config ?? emptyViewConfig()
    const hasFilters = Object.keys(config.filters).length > 0 || config.dimension !== null
    if ((hasFilters || forceApply.current) && bindingRef.current) setIgnored(bindingRef.current.apply(config.filters, config.dimension))
    else setIgnored(0)
    forceApply.current = false
  }, [status, resolved?.id, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const writeCache = useCallback(
    (update: (list: GridViewItem[]) => GridViewItem[]) => client.setQueryData<GridViewListResponse>(listKey, old => (old ? { ...old, items: sortViews(update(old.items)) } : old)),
    // listKey 是按企业与地址算出的数组，内容变化才算变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, listUrl],
  )

  // 本机旧列配置 → 服务端“我的”视图（只做一次；失败就保留本机副本，下次再试，期间列显示仍按本机配置）
  const migrating = useRef(false)
  useEffect(() => {
    if (status !== 'ready' || legacy === null || migrating.current) return
    migrating.current = true
    const done = () => {
      clearLegacyHidden(gridId)
      setLegacy(null)
    }
    if (items.some(item => item.mine && item.name === MIGRATED_VIEW_NAME)) return done()
    const hasPersonalDefault = items.some(item => item.mine && item.isDefault)
    apiFetch<GridViewItem>(LIST_PATH, {
      method: 'POST',
      body: JSON.stringify({ gridId, name: MIGRATED_VIEW_NAME, scope: 'USER', isDefault: !hasPersonalDefault, config: { ...emptyViewConfig(), hidden: legacy } }),
    })
      .then(created => {
        writeCache(list => [...list.map(item => (created.isDefault && item.scope === 'USER' ? { ...item, isDefault: false } : item)), created])
        done()
      })
      .catch(() => {
        // 失败：保留本机副本（列显示仍按它），本次加载内不再重试，下次打开页面再迁
      })
  }, [status, legacy, items, gridId, writeCache])

  const sortTracked = options.sort !== undefined
  const live = useMemo<GridViewConfig>(() => {
    const merged = { ...work, sort: sortTracked ? (options.sort ?? null) : base.sort, filters: base.filters, dimension: base.dimension }
    return withBinding(merged, options.binding)
  }, [work, sortTracked, options.sort, base, options.binding])
  const dirty = status !== 'loading' && !sameConfig(live, base)

  const body = (input: Partial<GridViewSaveInput>) => ({ gridId, ...input, config: live })
  const refreshOnConflict = (error: unknown): never => {
    if (describeError(error).kind === 'conflict') void client.invalidateQueries({ queryKey: listKey })
    throw error
  }

  const api: GridViewsApi = {
    status,
    items,
    active: resolved,
    dirty,
    canShare: query.data?.canShare ?? false,
    limits: query.data?.limits ?? { user: 20, team: 30 },
    invalid: (resolved ? countInvalid(resolved.config, columnIds, sortFields) : 0) + ignored,
    apply: id => {
      forceApply.current = true
      setActiveId(id)
      setNonce(value => value + 1)
    },
    saveAs: async input => {
      const created = await apiFetch<GridViewItem>(LIST_PATH, { method: 'POST', body: JSON.stringify(body(input)) })
      writeCache(list => [...list.map(item => (created.isDefault && sameGroup(item, created) ? { ...item, isDefault: false } : item)), created])
      setActiveId(created.id)
      return created
    },
    overwrite: async () => {
      if (!resolved) throw new Error('没有正在使用的视图')
      const saved = await apiFetch<GridViewItem>(`${LIST_PATH}/${resolved.id}`, { method: 'PUT', body: JSON.stringify({ version: resolved.version, config: live }) }).catch(refreshOnConflict)
      writeCache(list => list.map(item => (item.id === saved.id ? saved : item)))
      return saved
    },
    remove: async item => {
      await apiFetch(`${LIST_PATH}/${item.id}`, { method: 'DELETE' })
      writeCache(list => list.filter(entry => entry.id !== item.id))
      if (activeId === item.id) setActiveId(undefined)
    },
    makeDefault: async item => {
      const saved = await apiFetch<GridViewItem>(`${LIST_PATH}/${item.id}/default`, { method: 'POST' })
      writeCache(list => list.map(entry => (sameGroup(entry, saved) ? { ...entry, isDefault: entry.id === saved.id } : entry)))
    },
    retry: () => void query.refetch(),
  }
  return { api, work, setWork, base, status, key }
}

export type GridLayoutOptions = Omit<Options, 'columnIds'> & {
  /** 页面把 serverViews 打开才启用服务端视图；不开就沿用本机列配置。 */
  serverViews: boolean
}

/**
 * 表格的列版式：隐藏、顺序、列宽、固定。开启服务端视图时来自视图（带保存、另存为、默认、共享），否则是 P6-02 的本机隐藏列。
 * 返回的 columns 已按视图重排并套上列宽与固定。
 */
export function useGridLayout<T>(columns: ErpColDef<T>[], options: GridLayoutOptions) {
  const session = useOptionalSession()
  const enabled = options.serverViews && (session === null || session.me.accessMode === 'NORMAL')
  const allIds = useMemo(() => columns.map(columnId).filter(Boolean), [columns])
  const server = useServerViews({ ...options, columnIds: allIds, enabled })
  const [local, setLocal] = useState<string[]>(() => loadHidden(options.gridId))
  const { work, setWork } = server

  const rawHidden = enabled ? work.hidden : local
  // 列改版后旧记录可能把现有列全部隐藏：当作没有隐藏，免得表格显示成空表头
  const hidden = allIds.length > 0 && allIds.every(id => rawHidden.includes(id)) ? [] : rawHidden

  const setVisible = useCallback(
    (ids: readonly string[], visible: boolean) => {
      if (enabled) setWork(prev => ({ ...prev, hidden: applyVisibility(prev.hidden, allIds, ids, visible) }))
      else
        setLocal(prev => {
          const next = applyVisibility(prev, allIds, ids, visible)
          if (next.length !== prev.length || next.some((item, index) => item !== prev[index])) saveHidden(options.gridId, next)
          return next
        })
    },
    [enabled, setWork, allIds, options.gridId],
  )
  const onLayout = useCallback(
    (event: LayoutEvent) => {
      if (!enabled) return
      setWork(prev => {
        const order = event.order && event.order.join('\u0000') !== prev.order.join('\u0000') ? event.order : prev.order
        const widths = event.widths ? { ...prev.widths, ...event.widths } : prev.widths
        const widthChanged = JSON.stringify(Object.entries(widths).sort()) !== JSON.stringify(Object.entries(prev.widths).sort())
        return order === prev.order && !widthChanged ? prev : { ...prev, order, widths }
      })
    },
    [enabled, setWork],
  )
  const setPin = useCallback(
    (id: string, side: 'left' | 'right' | null) =>
      setWork(prev => {
        const pinned = { ...prev.pinned }
        if (side) pinned[id] = side
        else delete pinned[id]
        return { ...prev, pinned }
      }),
    [setWork],
  )
  const laidOut = useMemo(() => (enabled ? applyLayout(columns, work) : columns), [enabled, columns, work])
  return {
    hidden,
    setVisible,
    columns: laidOut,
    onLayout,
    setPin,
    pinned: work.pinned,
    views: enabled ? server.api : null,
    ready: !enabled || server.status !== 'loading',
    /** 套用的视图变了就变（含读取完成）；表格据此把排序同步成视图里的排序。 */
    viewKey: enabled ? server.key : '',
    viewSort: enabled ? server.base.sort : null,
  }
}
