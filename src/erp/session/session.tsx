import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../api'
import { resetForTenantChange } from '../query/client'
import { staleTimeOf } from '../query/domains'
import { canAccess, type AccessSubject, type RouteAccess } from '../routes/manifest'
import { setActiveTenantId } from './tenant-store'

// 登录会话（P1-03/P1-06）：当前成员、企业、权限点。权限只用于决定“显示什么”，真正的拦截永远在服务端。

export type AccessMode = 'NORMAL' | 'INTERNAL_DIRECT' | 'SUPPORT'

export type Me = {
  user: { id: string; email: string; displayName: string }
  tenant: {
    id: string
    name: string
    slug: string
    mode: string
    timezone: string
    /** 企业本地时区（日报发送时间等用）；数据口径时区是 timezone（美国太平洋时区） */
    localTimezone?: string
    defaultCurrency: string
    lifecycleStatus?: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'CLOSING' | 'CLOSED'
    /** 初始化向导是否已完成；未完成时外壳显示提示 */
    onboardingCompleted?: boolean
  }
  activeTenantId: string
  permissions: string[]
  accessMode: AccessMode
  mfa?: { enrolled: boolean; pending: boolean; recoveryCodesRemaining: number }
}

export const ME_QUERY_KEY = ['session', 'me'] as const

export const meQueryOptions = {
  queryKey: ME_QUERY_KEY,
  queryFn: () => apiFetch<Me>('/auth/me'),
  staleTime: staleTimeOf('session'),
  // 登录失效不重试，直接回登录页
  retry: false,
} as const

type SessionValue = { me: Me; subject: AccessSubject; can: (access: RouteAccess) => boolean; canPermission: (permission: string) => boolean }

const SessionContext = createContext<SessionValue | null>(null)

/** 登录后的会话提供者：同时负责“企业变化时清缓存”。 */
export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const client = useQueryClient()
  useEffect(() => {
    const { changed } = setActiveTenantId(me.activeTenantId)
    if (changed) {
      resetForTenantChange(client)
      // 清缓存会连同会话一起清掉，这里放回当前会话，外壳不必重新加载
      client.setQueryData(ME_QUERY_KEY, me)
    }
  }, [me, client])
  const value = useMemo<SessionValue>(() => {
    const subject: AccessSubject = { permissions: me.permissions }
    return {
      me,
      subject,
      can: access => canAccess(access, subject),
      canPermission: permission => canAccess({ kind: 'permission', permission }, subject),
    }
  }, [me])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession 必须在 SessionProvider 内使用')
  return value
}

/** 读取会话；未登录时返回 null（登录页等公开页面使用）。 */
export function useOptionalSession(): SessionValue | null {
  return useContext(SessionContext)
}

export function useMeQuery() {
  return useQuery(meQueryOptions)
}
