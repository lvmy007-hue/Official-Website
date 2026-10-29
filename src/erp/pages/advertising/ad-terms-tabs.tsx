import { useMemo, type Key, type ReactNode } from 'react'
import { Alert, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AD_TERM_ANOMALIES,
  AD_TERM_ANOMALY_LABEL,
  AD_TERM_RULES,
  AD_TERMS_DEFAULT_DAYS,
  ADS_QUADRANT_LABEL,
  anomalyAppliesTo,
  type AdTermListShell,
  type AdTermNegativeRow,
  type AdTermNegativesResponse,
  type AdTermQuadrantResponse,
  type AdTermRootRow,
  type AdTermRootsResponse,
  type AdTermSearchResponse,
  type AdTermSearchRow,
  type AdTermSummary,
  type AdTermTargetRow,
  type AdTermTargetsResponse,
  type AdsQuadrant,
} from '@nova/api-contracts'
import { ChartPanel, DataState, stateFromError } from '../../components'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { PagedTab } from './ads-campaign-paged'
import { moneyCell, numberCell, percentCell, TabNote } from './ads-campaigns-ui'
import { negativeColumns, rootColumns, searchTermColumns, targetColumns } from './ad-terms-columns'
import { buildTermQuadrantOption } from './ad-terms-options'
import { requestOf, type TermsState } from './ad-terms-state'

// 词级中心的 5 个页签（P3-10）。筛选条件变化时换 key 重新挂载分页壳，游标栈随之回到第一页。

export type TabProps = { state: TermsState; onChange: (patch: Partial<TermsState>) => void }

const keyOf = (state: TermsState) => JSON.stringify(requestOf(state))

/** 合计与异常分组：点击分组筛选，再点一次取消；分组只列适用于当前页签的。 */
function SummaryBar({ summary, state, onChange, ready }: { summary: AdTermSummary; ready: boolean } & TabProps) {
  if (!ready) return null
  const tab = state.tab === 'targets' ? 'targets' : 'search-terms'
  return (
    <div data-testid="term-summary" style={{ marginBottom: 8 }}>
      <Space size={[16, 4]} wrap style={{ fontSize: 13 }}>
        <span>
          共 <b className="erp-num">{summary.total}</b> 个词
        </span>
        <span>花费 {moneyCell(summary.totals.spend)}</span>
        <span>广告销售额 {moneyCell(summary.totals.sales)}</span>
        <span>广告成本销售比 {percentCell(summary.ratios.acos)}</span>
        <span>订单 {numberCell(summary.totals.orders)}</span>
      </Space>
      <div style={{ marginTop: 6 }}>
        <Space size={[6, 6]} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            异常分组：
          </Typography.Text>
          {AD_TERM_ANOMALIES.filter(anomaly => anomalyAppliesTo(anomaly, tab)).map(anomaly => (
            <Tag.CheckableTag key={anomaly} checked={state.anomaly === anomaly} onChange={checked => onChange({ anomaly: checked ? anomaly : undefined })}>
              {AD_TERM_ANOMALY_LABEL[anomaly]} {summary.anomalies[anomaly]}
            </Tag.CheckableTag>
          ))}
        </Space>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
        分组规则（自定默认值，不是亚马逊口径）：高花费无成交指花费不低于 {AD_TERM_RULES.MIN_SPEND} 美元、点击不少于 {AD_TERM_RULES.MIN_CLICKS} 次但没有订单；可扩量指订单不少于{' '}
        {AD_TERM_RULES.SCALE_MIN_ORDERS} 且广告成本销售比不高于 {Math.round(AD_TERM_RULES.SCALE_MAX_ACOS * 100)}%；可加词指未投放、订单不少于 {AD_TERM_RULES.ADD_MIN_ORDERS} 且转化率不低于{' '}
        {Math.round(AD_TERM_RULES.ADD_MIN_CVR * 100)}%；否定候选指未投放也未否定、点击不少于 {AD_TERM_RULES.NEGATIVE_MIN_CLICKS} 次、花费不低于 {AD_TERM_RULES.NEGATIVE_MIN_SPEND} 美元但没有订单。
      </Typography.Paragraph>
    </div>
  )
}

/** 没有选日期范围时，说明实际用的默认范围。 */
function RangeNote({ range }: { range: AdTermListShell['range'] }) {
  return range.defaulted ? (
    <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`未选择日期范围，当前显示 ${range.from} 至 ${range.to} 的指标（最近 ${AD_TERMS_DEFAULT_DAYS} 天）`} data-testid="term-range" />
  ) : null
}

function Notes({ data, extra }: { data: Pick<AdTermListShell, 'basis' | 'truncated' | 'range'>; extra?: ReactNode }) {
  return (
    <div data-testid="term-notes">
      <RangeNote range={data.range} />
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.basis} data-testid="term-basis" />
      {data.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="报表分组数超过读取上限，花费较低的词可能缺失" /> : null}
      {extra}
    </div>
  )
}

type ListShell = Pick<AdTermListShell, 'state' | 'note' | 'pageInfo' | 'truncated' | 'basis' | 'range'>
type ListProps<T extends object, R extends ListShell & { items: T[] }> = TabProps & {
  columns: ColumnsType<T>
  rowKey: (row: T) => Key
  domain: string
  scrollX: number
  header?: (data: R) => ReactNode
}

function ListTab<T extends object, R extends ListShell & { items: T[] }>({ state, columns, rowKey, domain, scrollX, header }: ListProps<T, R>) {
  const request = requestOf(state)
  return (
    <PagedTab<T, R>
      key={keyOf(state)}
      path={request.path}
      params={request.params}
      columns={columns}
      rowKey={rowKey}
      domain={domain}
      scrollX={scrollX}
      header={data => (data ? header?.(data) : null)}
    />
  )
}

export function SearchTermsTab(props: TabProps) {
  const columns = useMemo(searchTermColumns, [])
  return (
    <ListTab<AdTermSearchRow, AdTermSearchResponse>
      {...props}
      columns={columns}
      rowKey={row => row.key}
      domain="搜索词"
      scrollX={1500}
      header={data => (
        <>
          <Notes
            data={data}
            extra={
              <>
                {data.targetingNote ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data.targetingNote} data-testid="term-targeting-note" /> : null}
                {data.undisclosedSpend !== null ? (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 8 }}
                    message={`被亚马逊合并成“其他”的搜索词花费 ${data.undisclosedSpend.toFixed(2)} 美元，不在下面的列表里`}
                    data-testid="term-undisclosed"
                  />
                ) : null}
              </>
            }
          />
          <SummaryBar summary={data.summary} ready={data.state === 'OK'} {...props} />
        </>
      )}
    />
  )
}

export function TargetsTab(props: TabProps) {
  const columns = useMemo(targetColumns, [])
  return (
    <ListTab<AdTermTargetRow, AdTermTargetsResponse>
      {...props}
      columns={columns}
      rowKey={row => row.key}
      domain="投放对象"
      scrollX={1800}
      header={data => (
        <>
          <Notes data={data} />
          <SummaryBar summary={data.summary} ready={data.state === 'OK'} {...props} />
        </>
      )}
    />
  )
}

export function NegativesTab(props: TabProps) {
  const columns = useMemo(negativeColumns, [])
  return (
    <ListTab<AdTermNegativeRow, AdTermNegativesResponse>
      {...props}
      columns={columns}
      rowKey={row => row.id}
      domain="否定词"
      scrollX={1300}
      header={data => <Notes data={data} extra={<Typography.Text type="secondary">共 {data.total} 条否定记录</Typography.Text>} />}
    />
  )
}

export function RootsTab(props: TabProps) {
  const columns = useMemo(rootColumns, [])
  return (
    <ListTab<AdTermRootRow, AdTermRootsResponse>
      {...props}
      columns={columns}
      rowKey={row => row.root}
      domain="词根"
      scrollX={1200}
      header={data => <Notes data={data} extra={<Typography.Text type="secondary">共分析 {data.termCount} 个不同的搜索词</Typography.Text>} />}
    />
  )
}

export function QuadrantTab({ state }: TabProps) {
  const request = requestOf(state)
  const query = useApiQuery<AdTermQuadrantResponse>({ domain: 'analytics', path: request.path, params: request.params })
  const data = query.data
  const option = useMemo(() => (data ? buildTermQuadrantOption(data) : {}), [data])
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (!data) return <DataState kind="skeleton" rows={4} />
  if (data.state !== 'OK') return <TabNote state={data.state} note={data.note} />
  return (
    <div data-testid="term-quadrant">
      <RangeNote range={data.range} />
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.basis} data-testid="term-basis" />
      <ChartPanel title={`${state.subject === 'targets' ? '投放词' : '搜索词'}四象限（花费 × 广告成本销售比）`} ariaLabel="词级四象限" option={option} height={320} />
      <Space size={[8, 4]} wrap style={{ fontSize: 12, marginTop: 8 }}>
        {(Object.keys(ADS_QUADRANT_LABEL) as AdsQuadrant[]).map(key => (
          <Tag key={key} bordered={false}>
            {ADS_QUADRANT_LABEL[key]}：{data.counts[key]} 个
          </Tag>
        ))}
        {data.withoutSales.terms > 0 ? (
          <Typography.Text type="secondary">
            另有 {data.withoutSales.terms} 个词有花费但没有广告销售额{data.withoutSales.spend !== null ? `（合计花费 ${data.withoutSales.spend.toFixed(2)} 美元）` : ''}
            ，画不出广告成本销售比，请看“高花费无成交”分组
          </Typography.Text>
        ) : null}
        {data.truncated ? (
          <Typography.Text type="secondary">
            共 {data.total} 个点，图上只画花费最高的 {data.points.length} 个
          </Typography.Text>
        ) : null}
        {data.note ? <Typography.Text type="secondary">{data.note}</Typography.Text> : null}
      </Space>
    </div>
  )
}
