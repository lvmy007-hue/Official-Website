import { Tag, Tooltip } from 'antd'
import { useApiQuery } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { describeRange } from '../../scope/actions'
import { formatDateTime, MARKETPLACE_TIME_ZONE } from '../../format'
import type { ScopeOptions } from '../../shell/ScopeBar'

// 数据新鲜度条（03 章 3.2）：数据范围（主体、店铺、站点、时间）、时区、币种、最近成功同步时间、数据来源、数据质量提示数。
// 范围部分来自地址栏；同步时间、来源、质量提示由页面传入（来自各数据域的新鲜度记录）。
// 没有新鲜度记录时如实显示“尚无成功同步记录”，不编造时间。

export type FreshnessInfo = {
  lastSuccessAt: string | null
  sources: string[]
  qualityIssues: number
  /** 近实时数据：标注“实时估算，以日终数据为准”。 */
  realtime?: boolean
}

export function scopeSummary(scope: { legalEntityIds?: unknown; storeIds?: unknown }, options: Pick<ScopeOptions, 'entities' | 'stores'> | undefined) {
  const pick = (ids: unknown, list: Array<{ id: string; name: string }> | undefined, all: string) => {
    const selected = Array.isArray(ids) ? (ids as string[]) : []
    if (selected.length === 0) return all
    const names = selected.map(id => list?.find(item => item.id === id)?.name ?? '未知')
    return names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 个`
  }
  return { entities: pick(scope.legalEntityIds, options?.entities, '全部主体'), stores: pick(scope.storeIds, options?.stores, '全部店铺') }
}

type FreshnessResponse = { sources: Array<{ label: string; status: string; lastSuccessAt: string | null }>; summary: { attention: number } }

/** 把 /freshness 的聚合结果换成新鲜度条要显示的内容；来源只列出已经有成功同步的，质量提示数 = 需要关注的来源数。 */
export function freshnessFromApi(data: unknown): FreshnessInfo | null {
  const value = data as Partial<FreshnessResponse> | null | undefined
  if (!value || !Array.isArray(value.sources) || typeof value.summary?.attention !== 'number') return null
  const done = value.sources.filter(source => source.lastSuccessAt)
  const times = done.map(source => source.lastSuccessAt as string).sort()
  const latest = times[times.length - 1] ?? null
  return { lastSuccessAt: latest, sources: done.map(source => source.label), qualityIssues: value.summary.attention }
}

/** 不传 freshness 时，新鲜度条按当前范围自己读取 /freshness；传 null 表示该页面没有同步来源（只显示范围）。 */
export function FreshnessBar({ freshness: given }: { freshness?: FreshnessInfo | null }) {
  const { scope } = useScope()
  const loaded = useApiQuery<unknown>({ domain: 'realtime', path: '/freshness', enabled: given === undefined })
  const freshness = given === undefined ? freshnessFromApi(loaded.data) : given
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const names = scopeSummary(scope, options.data)
  const currency = scope.displayCurrency === 'ORIGINAL' ? '原币' : '美元'
  const range = scope.from && scope.to ? describeRange({ from: scope.from, to: scope.to }) : describeRange({})
  return (
    <div data-testid="freshness-bar" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', fontSize: 12, color: 'var(--ant-color-text-secondary)', margin: '0 0 8px' }}>
      <span>主体：{names.entities}</span>
      <span>店铺：{names.stores}</span>
      <span>站点：美国站</span>
      <span>时间：{range}</span>
      <span>时区：{MARKETPLACE_TIME_ZONE}</span>
      <span>币种：{currency}</span>
      <span aria-hidden>|</span>
      {freshness?.lastSuccessAt ? (
        <span>最近成功同步：{formatDateTime(freshness.lastSuccessAt)}</span>
      ) : (
        <span>{given === undefined && loaded.isError ? '同步状态暂时读取失败' : '尚无成功同步记录'}</span>
      )}
      {freshness?.sources.length ? <span>来源：{freshness.sources.join('、')}</span> : null}
      {freshness?.realtime ? (
        <Tag color="processing" bordered={false}>
          实时估算，以日终数据为准
        </Tag>
      ) : null}
      {freshness && freshness.qualityIssues > 0 ? (
        <Tooltip title="存在数据质量提示，相关数字请谨慎使用">
          <Tag color="warning" bordered={false}>
            {freshness.qualityIssues} 条数据质量提示
          </Tag>
        </Tooltip>
      ) : null}
    </div>
  )
}
