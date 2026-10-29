import type { ReactNode } from 'react'
import { Alert, Button, Card, Space, Tag } from 'antd'
import { BR_METRIC_INFO, type BrCommon, type BrMetricKey, type BrPoint, type BrStoreState, type CursorPageInfo } from '@nova/api-contracts'
import { DataState, FreshnessBar, stateFromError } from '../../components'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { formatMetric } from './business-reports-options'

// 业务报告各页签共用：外框（新鲜度、错误、范围与说明）、各店铺同步情况、数值显示（空值写“尚无记录”，绝不写 0）、翻页。

type QueryLike<T> = { data?: T; error: unknown; refetch: () => unknown }

/** 一个指标值：没有值写“尚无记录”。 */
export const Figure = ({ metric, value }: { metric: BrMetricKey; value: number | null | undefined }): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMetric(metric, value)}</span>

const SOURCE_TEXT: Record<NonNullable<BrPoint['source']>, string> = { DATA_KIOSK: '数据中心', REPORT: '报告补充', MIXED: '混合' }
export const SourceTag = ({ source }: { source: BrPoint['source'] }) =>
  source === null ? (
    <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
      无记录
    </Tag>
  ) : (
    <Tag bordered={false} color={source === 'REPORT' ? 'warning' : 'blue'} style={{ marginInlineEnd: 0 }}>
      {SOURCE_TEXT[source]}
    </Tag>
  )

const STORE_COLOR: Record<BrStoreState, string> = { AVAILABLE: 'success', NO_BRAND: 'warning', FAILED: 'error', NO_RECORD: 'default' }

/** 各店铺的同步情况：缺品牌分析角色、同步失败、没有同步过分别写明；已同步的只列店铺名。 */
export function StoreStatuses({ stores }: { stores: BrCommon['stores'] }) {
  const attention = stores.filter(store => store.state !== 'AVAILABLE')
  return (
    <div style={{ margin: '4px 0 8px' }} data-testid="br-stores">
      <Space wrap size={[4, 4]}>
        <span>店铺同步：</span>
        {stores.map(store => (
          <Tag key={store.sellerAccountId} color={STORE_COLOR[store.state]} bordered={false} style={{ marginInlineEnd: 0 }}>
            {store.storeName} · {store.stateLabel}
          </Tag>
        ))}
        {stores.length === 0 ? <Muted>范围内没有店铺</Muted> : null}
      </Space>
      {attention.map(store => (
        <div key={store.sellerAccountId} style={{ color: 'rgba(0,0,0,0.65)', fontSize: 12 }}>
          {store.storeName}：{store.note}
        </div>
      ))}
    </div>
  )
}

/** 范围提示、读取上限提示与各店铺同步情况（Frame 与表格外框共用）。 */
function Notices({ data }: { data: BrCommon }) {
  return (
    <>
      {data.range.defaulted ? (
        <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择日期范围，当前显示 ${data.range.from} 至 ${data.range.to}（${data.range.days} 天）`} data-testid="br-defaulted" />
      ) : null}
      {data.state === 'NO_DATA' && data.note ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={data.note} data-testid="br-empty" /> : null}
      {data.truncated ? (
        <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="数据量超过读取上限，合计与列表只含已读到的部分" description="请缩小日期范围或选择店铺后再看。" data-testid="br-truncated" />
      ) : null}
      <StoreStatuses stores={data.stores} />
    </>
  )
}

const Basis = ({ basis }: { basis: string }) => (
  <p style={{ margin: '8px 0 0' }} data-testid="br-basis">
    <Muted>口径：{basis}</Muted>
  </p>
)

export function Frame<T extends BrCommon>({ query, testId, children }: { query: QueryLike<T>; testId: string; children: (data: T) => ReactNode }) {
  const data = query.data
  return (
    <div data-testid={testId}>
      <FreshnessBar freshness={data?.freshness} />
      {query.error ? (
        <DataState {...stateFromError(describeError(query.error), { permission: 'analytics.read', onRetry: () => void query.refetch() })} />
      ) : !data ? (
        <DataState kind="skeleton" rows={5} />
      ) : (
        <>
          <Notices data={data} />
          {children(data)}
          <Basis basis={data.basis} />
        </>
      )}
    </div>
  )
}

/** 表格自己取数（MassiveGrid / PagedGrid）时的外框：读到第一页后才有新鲜度、提示与口径，读取失败由表格自己显示。 */
export function GridFrame({ meta, testId, children }: { meta: BrCommon | null; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId}>
      <FreshnessBar freshness={meta?.freshness} />
      {meta ? <Notices data={meta} /> : null}
      {children}
      {meta ? <Basis basis={meta.basis} /> : null}
    </div>
  )
}
/** 指标小卡：数值，可带“对比期”一行。 */
export function StatCard({ title, children, footer, testId }: { title: string; children: ReactNode; footer?: ReactNode; testId?: string }) {
  return (
    <Card size="small" styles={{ body: { padding: '10px 12px' } }} style={{ minWidth: 0 }} data-testid={testId ?? 'br-card'}>
      <div style={{ color: 'rgba(0,0,0,0.65)', fontSize: 13 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 600, margin: '2px 0' }}>{children}</div>
      {footer ? <div style={{ fontSize: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>{footer}</div> : null}
    </Card>
  )
}

export const metricLabel = (key: BrMetricKey) => BR_METRIC_INFO[key].label

/** 游标分页（上一页、下一页）：栈顶是当前页的游标，undefined 表示第一页。 */
export function Pager({
  stack,
  setStack,
  pageInfo,
  fetching,
}: {
  stack: Array<string | undefined>
  setStack: (next: (current: Array<string | undefined>) => Array<string | undefined>) => void
  pageInfo?: CursorPageInfo
  fetching: boolean
}) {
  const next = pageInfo?.hasMore ? pageInfo.nextCursor : null
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={stack.length <= 1 || fetching} onClick={() => setStack(current => current.slice(0, -1))}>
        上一页
      </Button>
      <Button disabled={!next || fetching} onClick={() => next && setStack(current => [...current, next])}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>
        第 {stack.length} 页{pageInfo?.approxTotal === null || pageInfo?.approxTotal === undefined ? '' : `，共约 ${pageInfo.approxTotal} 条`}
      </span>
    </Space>
  )
}
