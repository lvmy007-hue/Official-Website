import {
  AD_TERM_ANOMALIES,
  AD_TERM_NEGATIVE_LEVELS,
  AD_TERM_PAGE_TABS,
  AD_TERM_ROOT_SORTS,
  AD_TERM_SORTS,
  AD_TERM_SUBJECTS,
  anomalyAppliesTo,
  type AdsTermStatus,
  type AdTermAnomaly,
  type AdTermListTab,
  type AdTermNegativeLevel,
  type AdTermPageTab,
  type AdTermRootSort,
  type AdTermSort,
  type AdTermSubject,
} from '@nova/api-contracts'

// 词级中心的筛选状态（P3-10）：页签与每个页签适用的筛选、排序；保存视图存的就是这份状态。
// 切换页签会丢掉不适用的筛选（服务端对不适用的筛选返回 422，不静默忽略，所以前端不能带过去）。

export type TermSortField = AdTermSort | AdTermRootSort
export interface TermsState {
  tab: AdTermPageTab
  q?: string
  anomaly?: AdTermAnomaly
  status?: AdsTermStatus
  level?: AdTermNegativeLevel
  matchType?: string
  subject: AdTermSubject
  sort: TermSortField
  dir: 'asc' | 'desc'
}

export const TERM_STATUSES = ['TARGETED', 'NEGATED', 'UNTARGETED'] as const

export const defaultSortOf = (tab: AdTermPageTab): Pick<TermsState, 'sort' | 'dir'> => (tab === 'negatives' ? { sort: 'term', dir: 'asc' } : { sort: 'spend', dir: 'desc' })

export const initialState = (tab: AdTermPageTab = 'targets'): TermsState => ({ tab, subject: 'search-terms', ...defaultSortOf(tab) })

/** 每个页签可选的排序字段：否定词库只能按词排序，四象限不排序。 */
export function sortFieldsOf(tab: AdTermPageTab): readonly TermSortField[] {
  if (tab === 'negatives') return ['term']
  if (tab === 'quadrant') return []
  return tab === 'roots' ? AD_TERM_ROOT_SORTS : AD_TERM_SORTS
}

/** 切换页签：保留关键字，丢掉不适用的筛选，排序回到该页签的默认。 */
export function switchTab(state: TermsState, tab: AdTermPageTab): TermsState {
  const next: TermsState = { ...initialState(tab), q: state.q, subject: state.subject }
  const listTab = tab as AdTermListTab
  if (tab !== 'roots' && state.anomaly && anomalyAppliesTo(state.anomaly, listTab)) next.anomaly = state.anomaly
  if (tab === 'targets' || tab === 'negatives') next.matchType = state.matchType
  return next
}

const sortParam = (state: TermsState) => `${state.sort}:${state.dir}`

/** 接口路径与请求参数（只带该页签适用的筛选）。 */
export function requestOf(state: TermsState): { path: string; params: Record<string, string | undefined> } {
  const { tab, q } = state
  switch (tab) {
    case 'roots':
      return { path: '/ads/terms/roots', params: { q, sort: sortParam(state) } }
    case 'search-terms':
      return { path: '/ads/terms', params: { tab, q, anomaly: state.anomaly, status: state.status, sort: sortParam(state) } }
    case 'targets':
      return { path: '/ads/terms', params: { tab, q, anomaly: state.anomaly, matchType: state.matchType, sort: sortParam(state) } }
    case 'negatives':
      return { path: '/ads/terms', params: { tab, q, level: state.level, matchType: state.matchType, sort: sortParam(state) } }
    case 'quadrant':
      return { path: '/ads/terms', params: { tab, q, anomaly: state.anomaly, subject: state.subject } }
  }
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined)

/** 从保存视图里还原状态；认不出的字段丢弃，整体不是对象返回 null。 */
export function parseView(filter: unknown): TermsState | null {
  if (!filter || typeof filter !== 'object') return null
  const raw = filter as Record<string, unknown>
  const tab = oneOf(
    AD_TERM_PAGE_TABS.map(item => item.key),
    raw.tab,
  )
  if (!tab) return null
  const base = initialState(tab)
  const sort = oneOf(sortFieldsOf(tab), raw.sort)
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined)
  const merged: TermsState = {
    ...base,
    q: text(raw.q),
    anomaly: oneOf(AD_TERM_ANOMALIES, raw.anomaly),
    status: oneOf(TERM_STATUSES, raw.status),
    level: oneOf(AD_TERM_NEGATIVE_LEVELS, raw.level),
    matchType: text(raw.matchType)?.slice(0, 40),
    subject: oneOf(AD_TERM_SUBJECTS, raw.subject) ?? base.subject,
    ...(sort ? { sort, dir: raw.dir === 'asc' ? ('asc' as const) : ('desc' as const) } : {}),
  }
  // 经过一次切换同样的清理，保证还原出来的组合是合法的
  return { ...switchTab({ ...merged }, tab), status: tab === 'search-terms' ? merged.status : undefined, level: tab === 'negatives' ? merged.level : undefined, sort: merged.sort, dir: merged.dir }
}
