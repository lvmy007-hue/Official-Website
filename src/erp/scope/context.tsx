import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { scopeToApiParams, type ScopeSearch } from './params'

type ScopeValue = {
  /** 已校验的范围（来自地址栏）。 */
  scope: ScopeSearch
  /** 请求服务端时使用的统一范围参数。 */
  apiParams: Record<string, string>
}

const EMPTY: ScopeValue = { scope: {}, apiParams: scopeToApiParams({}) }

const ScopeContext = createContext<ScopeValue>(EMPTY)

export function ScopeProvider({ scope, children }: { scope: ScopeSearch; children: ReactNode }) {
  const value = useMemo<ScopeValue>(() => ({ scope, apiParams: scopeToApiParams(scope) }), [scope])
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export const useScope = () => useContext(ScopeContext)
