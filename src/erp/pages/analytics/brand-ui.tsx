import { useState, type ReactNode } from 'react'
import { Alert, Segmented, Select, Space } from 'antd'
import { BA_PERIOD_LABEL, BA_PERIODS, BRAND_ANALYTICS_READ, type BaCommon, type BaPeriod } from '@nova/api-contracts'
import { DataState, FreshnessBar, stateFromError } from '../../components'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { StoreStatuses } from './business-reports-ui'

// 品牌分析五页共用的外框（P4-04）：新鲜度、周期选择（周/月/季 + 起始日，没有日期范围）、错误、各店铺同步情况（缺品牌分析角色单独写明）、
// 无数据说明、读取上限提示与口径。官方没给的值写“尚无记录”，不当 0；品牌分析没有示例数字。

type QueryLike<T> = { data?: T; error: unknown; refetch: () => unknown }

export interface BrandPeriodState {
  kind: BaPeriod
  start: string | undefined
  /** 并入请求参数。 */
  params: { period: BaPeriod; periodStart: string | undefined }
  setKind: (kind: BaPeriod) => void
  setStart: (start: string | undefined) => void
}

/** 周期选择状态；换周期种类时起始日清空（回到这一种类里最近有数据的周期），onChange 用来让翻页回到第一页。 */
export function useBrandPeriod(onChange?: () => void): BrandPeriodState {
  const [kind, setKindState] = useState<BaPeriod>('WEEK')
  const [start, setStartState] = useState<string | undefined>()
  return {
    kind,
    start,
    params: { period: kind, periodStart: start },
    setKind: next => {
      setKindState(next)
      setStartState(undefined)
      onChange?.()
    },
    setStart: next => {
      setStartState(next)
      onChange?.()
    },
  }
}

function PeriodBar({ period, data }: { period: BrandPeriodState; data?: BaCommon }) {
  const available = data?.period.available ?? []
  const current = data?.period.start ?? period.start
  const options = [...new Set([...(current ? [current] : []), ...available])].map(value => ({ value, label: value }))
  return (
    <Space wrap style={{ margin: '4px 0 8px' }} data-testid="ba-period-bar">
      <Segmented aria-label="周期种类" value={period.kind} options={BA_PERIODS.map(kind => ({ value: kind, label: BA_PERIOD_LABEL[kind] }))} onChange={value => period.setKind(value as BaPeriod)} />
      <Select
        showSearch
        style={{ width: 150 }}
        aria-label="周期起始日"
        placeholder="最近有数据的周期"
        value={period.start ?? undefined}
        allowClear
        options={options}
        onChange={value => period.setStart(value ?? undefined)}
        notFoundContent="这一种周期还没有数据"
      />
      {data?.period.start ? (
        <span data-testid="ba-period-range">
          <Muted>
            {data.period.start} 至 {data.period.end}
            {data.period.previousStart ? `，对比上一周期 ${data.period.previousStart}` : ''}
          </Muted>
        </span>
      ) : null}
    </Space>
  )
}

export function BrandFrame<T extends BaCommon>({ query, period, testId, children }: { query: QueryLike<T>; period: BrandPeriodState; testId: string; children: (data: T) => ReactNode }) {
  const data = query.data
  return (
    <div data-testid={testId}>
      <FreshnessBar freshness={data?.freshness} />
      <PeriodBar period={period} data={data} />
      {query.error ? (
        <DataState {...stateFromError(describeError(query.error), { permission: BRAND_ANALYTICS_READ, onRetry: () => void query.refetch() })} />
      ) : !data ? (
        <DataState kind="skeleton" rows={5} />
      ) : (
        <>
          {data.period.defaulted && data.period.start ? (
            <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择周期起始日，当前显示最近一个有数据的周期：${data.period.start} 至 ${data.period.end}`} data-testid="ba-defaulted" />
          ) : null}
          {data.state === 'NO_DATA' && data.note ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={data.note} data-testid="ba-empty" /> : null}
          {data.truncated ? (
            <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="数据量超过读取上限，统计只含已读到的部分" description="请选择店铺、ASIN 或品牌后再看。" data-testid="ba-truncated" />
          ) : null}
          <StoreStatuses stores={data.stores} />
          {children(data)}
          <p style={{ margin: '8px 0 0' }} data-testid="ba-basis">
            <Muted>口径：{data.basis}</Muted>
          </p>
        </>
      )}
    </div>
  )
}
