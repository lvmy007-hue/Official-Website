import { useState } from 'react'
import { Alert, Button, Card } from 'antd'
import { useSearch } from '@tanstack/react-router'
import { CONNECTION_KINDS, CONNECTION_KIND_LABEL, CONNECTION_KIND_NOTE, type ConnectionCenterResponse, type ConnectionKind, type ConnectionRow } from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { AdsBindingSection } from './AdsBindingSection'
import { AuthorizeActions } from './AuthorizeActions'
import { CallbackNotice } from './CallbackNotice'
import { RoleComparison } from './RoleComparison'
import { authorizedColumns, derivedColumns } from './connection-ui'

// 连接中心（P5-04，09 章 9.6）：四类连接（卖家接口、广告接口、报告权限、品牌分析资格）、授权范围、健康检查、失败码、令牌更新时间与预计失效，
// 角色对照，广告账户与店铺绑定；授权、重新授权、健康检查、断开都在这里，每次都写审计。
// 连接是企业层面的设置，不跟全局范围栏走；谁能看到哪些连接由服务端按成员的数据范围决定。

const EMPTY: Record<ConnectionKind, string> = {
  SELLER: '尚未授权卖家接口；点右上角“授权卖家接口”开始。',
  ADS: '尚未授权广告接口；没有广告业务可以跳过。',
  REPORT_ROLE: '需要先授权卖家接口并完成一次同步，才能判断报告权限。',
  BRAND_ANALYTICS: '需要先授权卖家接口并完成一次同步，才能判断品牌分析资格。',
}
const POLL_MS = 4000
const POLL_WINDOW_MS = 90_000

function KindCard({
  kind,
  rows,
  onDone,
  loading,
  error,
  onRetry,
}: {
  kind: ConnectionKind
  rows: ConnectionRow[] | undefined
  onDone: (poll?: boolean) => void
  loading: boolean
  error: unknown
  onRetry: () => void
}) {
  const authorized = kind === 'SELLER' || kind === 'ADS'
  return (
    <Card
      size="small"
      title={CONNECTION_KIND_LABEL[kind]}
      extra={<span style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>{CONNECTION_KIND_NOTE[kind]}</span>}
      style={{ marginTop: 16 }}
      data-testid={`kind-${kind}`}
    >
      <SimpleGrid<ConnectionRow>
        gridId="connections.connections-page"
        columns={authorized ? authorizedColumns(onDone) : derivedColumns(kind)}
        rows={rows}
        rowKey={row => row.id}
        loading={loading}
        error={error}
        onRetry={onRetry}
        emptyState={{ kind: 'empty', domain: CONNECTION_KIND_LABEL[kind], prerequisite: EMPTY[kind] }}
      />
    </Card>
  )
}

export default function ConnectionsPage() {
  const search = useSearch({ strict: false }) as { provider?: unknown; status?: unknown; code?: unknown }
  // 健康检查是后台任务：提交后短时间内每几秒取一次，结果出来就自动显示
  const [pollUntil, setPollUntil] = useState(0)
  const query = useApiQuery<ConnectionCenterResponse>({
    domain: 'reference',
    path: '/connections',
    scoped: false,
    refetchIntervalMs: () => (Date.now() < pollUntil ? POLL_MS : false),
  })
  const data = query.data
  const refresh = () => void query.refetch()
  const done = (poll?: boolean) => {
    if (poll) setPollUntil(Date.now() + POLL_WINDOW_MS)
    refresh()
  }
  const rowsOf = (kind: ConnectionKind) => data?.items.filter(item => item.kind === kind)
  return (
    <div data-testid="connections-page">
      <PageHeader
        title="连接中心"
        description="亚马逊卖家接口与广告接口的授权、健康状态与权限一览；授权、重新授权、健康检查、断开都会留审计记录。"
        actions={
          <>
            <Button onClick={refresh} loading={query.isFetching}>
              刷新
            </Button>
            <AuthorizeActions data={data} />
          </>
        }
      />
      <CallbackNotice search={search} />
      {data ? (
        <p style={{ margin: '8px 0 0' }} data-testid="connections-summary">
          共 <span className="erp-num">{data.summary.total}</span> 个连接，已授权 <span className="erp-num">{data.summary.authorized}</span>，需要处理{' '}
          <span className="erp-num">{data.summary.attention}</span>
        </p>
      ) : null}
      {data && !data.canManage && data.manageBlockedReason ? <Alert type="info" showIcon style={{ marginTop: 8 }} message={`当前账号只能查看：${data.manageBlockedReason}`} /> : null}
      {CONNECTION_KINDS.map(kind => (
        <KindCard key={kind} kind={kind} rows={rowsOf(kind)} onDone={done} loading={query.isPending} error={query.error} onRetry={refresh} />
      ))}
      {data?.truncated ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="只列出前面的连接；其余请联系管理员按店铺缩小范围后查看。" /> : null}
      {data ? <RoleComparison roles={data.roles} /> : null}
      <AdsBindingSection />
    </div>
  )
}
