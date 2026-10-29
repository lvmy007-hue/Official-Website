import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Popover, Spin, Tag, Typography } from 'antd'
import type { IHeaderParams } from 'ag-grid-community'
import { METRIC_IDS_MAX, type MetricDefinition, type MetricLink } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'

// 列头问号（P6-03，14 章 P6-03 第 4 条）：列定义只写 `metric: 'M-206'`，问号里的内容全部从指标字典（/metrics/definitions）取，
// 页面里不写任何口径文案——口径变了只改字典（freeze/metrics.md），所有页面同时更新。
// 为了不拖慢首屏，表格第一次有人点问号才请求字典，一次最多 50 条（本表格上出现的全部指标一起取）。

type HelpState = { status: 'idle' | 'loading' | 'ready' | 'error'; byId: ReadonlyMap<string, MetricDefinition>; request: () => void }
const MetricHelpContext = createContext<HelpState | null>(null)

/** 表格内核用：收集列上的指标键，提供按需读取的字典。 */
export function MetricHelpProvider({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const [wanted, setWanted] = useState(false)
  const list = useMemo(() => ids.slice(0, METRIC_IDS_MAX), [ids])
  const query = useApiQuery<{ items: MetricDefinition[] }>({
    domain: 'config',
    path: '/metrics/definitions',
    scoped: false,
    params: { ids: list, pageSize: METRIC_IDS_MAX },
    enabled: wanted && list.length > 0,
  })
  const value = useMemo<HelpState>(
    () => ({
      status: query.isError ? 'error' : query.data ? 'ready' : wanted ? 'loading' : 'idle',
      byId: new Map((query.data?.items ?? []).map(item => [item.id, item])),
      request: () => (query.isError ? void query.refetch() : setWanted(true)),
    }),
    [query.isError, query.data, query.refetch, wanted], // eslint-disable-line react-hooks/exhaustive-deps
  )
  return <MetricHelpContext.Provider value={value}>{children}</MetricHelpContext.Provider>
}

const Links = ({ links, none }: { links: readonly MetricLink[]; none: string }) =>
  links.length === 0 ? (
    <Typography.Text type="secondary">{none}</Typography.Text>
  ) : (
    <>
      {links.map((link, index) => (
        <span key={link.route}>
          {index > 0 ? '、' : null}
          <AppLink to={link.route}>{link.label}</AppLink>
        </span>
      ))}
    </>
  )

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="erp-metric-help-row">
    <Typography.Text type="secondary">{label}</Typography.Text>
    <div>{children}</div>
  </div>
)

/** 问号里的内容：定义与公式、来源、刷新频率、口径版本，以及对数、对不上的原因、配置位置。 */
export function MetricHelpBody({ metric, state }: { metric: string; state: HelpState }) {
  if (state.status === 'error') {
    return (
      <div role="alert">
        口径暂时读取失败。{' '}
        <Button type="link" size="small" onClick={state.request}>
          重试
        </Button>
      </div>
    )
  }
  const def = state.byId.get(metric)
  if (state.status !== 'ready') return <Spin size="small" aria-label="正在读取口径" />
  if (!def) return <Typography.Text type="secondary">指标字典里没有 {metric}</Typography.Text>
  return (
    <div className="erp-metric-help" data-testid="metric-help">
      <div>
        <strong>{def.name}</strong> <Tag bordered={false}>{def.type}</Tag> <Typography.Text type="secondary">{def.id}</Typography.Text>
      </div>
      <Row label="定义与公式">{def.definition}</Row>
      <Row label="数据来源">{def.source}</Row>
      <Row label="刷新频率">{def.refresh}</Row>
      <Row label="口径版本">{def.version === null ? '不设指标' : `第 ${def.version} 版`}</Row>
      <Row label="和哪里对数">
        <Links links={def.reconcileWith} none="字典里尚未登记" />
      </Row>
      <Row label="可能对不上的原因">
        {def.mismatchReasons.length === 0 ? (
          <Typography.Text type="secondary">字典里尚未登记</Typography.Text>
        ) : (
          <ul>
            {def.mismatchReasons.map(reason => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </Row>
      <Row label="在哪里配置">{def.configurableAt ? <Links links={[def.configurableAt]} none="" /> : <Typography.Text type="secondary">口径固定，无需配置</Typography.Text>}</Row>
    </div>
  )
}

export function MetricHelp({ metric, label }: { metric: string; label: string }) {
  const state = useContext(MetricHelpContext)
  if (!state) return null
  return (
    <Popover trigger="click" placement="bottom" title={`${label}的口径`} onOpenChange={open => open && state.request()} content={<MetricHelpBody metric={metric} state={state} />}>
      <button type="button" className="erp-metric-help-trigger" aria-label={`${label}的口径说明`} onClick={event => event.stopPropagation()}>
        ?
      </button>
    </Popover>
  )
}

/** 带问号的列头：自己画列名和排序箭头（点列名排序），后面跟问号。 */
export function MetricHeader(params: IHeaderParams & { metric: string }) {
  const { column } = params
  const [sort, setSort] = useState(column.getSort())
  useEffect(() => {
    const sync = () => setSort(column.getSort())
    column.addEventListener('sortChanged', sync)
    return () => column.removeEventListener('sortChanged', sync)
  }, [column])
  return (
    <div className="erp-metric-header">
      {params.enableSorting ? (
        <button type="button" className="erp-metric-header-name" onClick={event => params.progressSort(event.shiftKey)}>
          {params.displayName}
          {sort === 'asc' ? ' ↑' : sort === 'desc' ? ' ↓' : ''}
        </button>
      ) : (
        <span className="erp-metric-header-name">{params.displayName}</span>
      )}
      <MetricHelp metric={params.metric} label={params.displayName} />
    </div>
  )
}
