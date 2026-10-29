import { Alert, Card, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { adsAccountRefState, type AdsAccountBindingList, type AdsAccountBindingRow, type AdsBindingStatus } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { BindActions } from './ads-binding-actions'

// 广告账户与店铺绑定（P3-03，09 章 9.6）：连接中心的最小界面，完整的连接中心在 P5-04。
// 广告数据通过“广告账户绑定的店铺”参与数据范围过滤：同步广告账户时按卖家编号自动匹配（企业内只有一个同编号店铺才绑定，不猜测），
// 对不上的人工绑定；人工绑定不会被自动匹配覆盖。未绑定的广告账户只有“全部店铺”范围的成员看得到，不进入按店铺收窄的业务页。

const STATUS_COLOR: Record<AdsBindingStatus, string> = { AUTO_MATCHED: 'success', MANUAL: 'processing', UNBOUND: 'warning' }
const PATH = '/connections/ads-accounts'

const columns = (data: AdsAccountBindingList, onDone: () => void): ColumnsType<AdsAccountBindingRow> => [
  {
    title: '广告账户',
    key: 'account',
    width: 230,
    render: (_value, row) => (
      <div>
        <div>{row.displayName}</div>
        <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
          档案 {row.profileId} · {row.countryCode} · {row.currency}
        </div>
      </div>
    ),
  },
  { title: '卖家编号', dataIndex: 'accountId', width: 150, render: (value: string | null) => value ?? <Muted>接口未返回</Muted> },
  {
    title: '统一接口账户',
    key: 'adsAccountId',
    width: 170,
    render: (_value, row) => {
      const ref = adsAccountRefState(row)
      return ref.discovered ? ref.adsAccountId : <Muted>未发现广告账户</Muted>
    },
  },
  {
    title: '绑定店铺',
    key: 'store',
    width: 280,
    render: (_value, row) =>
      row.store ? (
        <div>
          <div>{row.store.displayName}</div>
          <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>卖家编号 {row.store.sellerId}</div>
        </div>
      ) : (
        <span data-testid={`unbound-${row.id}`} style={{ color: 'rgba(0,0,0,0.65)', fontSize: 12 }}>
          {row.unboundReasonText}
        </span>
      ),
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render: (_value, row) => (
      <div>
        <Tag color={STATUS_COLOR[row.bindingStatus]} bordered={false} style={{ marginInlineEnd: 0 }}>
          {row.bindingStatusLabel}
        </Tag>
        {row.boundBy ? <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>绑定人 {row.boundBy}</div> : null}
      </div>
    ),
  },
  { title: '操作', key: 'actions', width: 220, fixed: 'right', render: (_value, row) => <BindActions row={row} data={data} onDone={onDone} /> },
]

export function AdsBindingSection() {
  // 绑定是企业层面的设置，不跟全局范围栏走；谁能看到哪些账户由服务端按成员的数据范围决定
  const query = useApiQuery<AdsAccountBindingList>({ domain: 'reference', path: PATH, scoped: false })
  const data = query.data
  const refresh = () => void query.refetch()
  return (
    <Card size="small" title="广告账户与店铺绑定" style={{ marginTop: 16 }} data-testid="ads-binding">
      <p style={{ margin: '0 0 8px', color: 'rgba(0,0,0,0.65)' }}>
        广告数据按“广告账户绑定的店铺”参与数据范围过滤。同步广告账户时按卖家编号自动匹配（企业内只有一家同编号店铺才绑定，不猜测）；对不上的请人工绑定。人工绑定不会被自动匹配覆盖，每次绑定、改绑与解除都会留审计记录。
      </p>
      {data ? (
        <p style={{ margin: '0 0 8px' }} data-testid="ads-binding-summary">
          共 <span className="erp-num">{data.summary.total}</span> 个广告账户：已自动匹配 <span className="erp-num">{data.summary.autoMatched}</span>，人工绑定{' '}
          <span className="erp-num">{data.summary.manual}</span>，未绑定 <span className="erp-num">{data.summary.unbound}</span>
        </p>
      ) : null}
      {data && !data.canBind && data.bindBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`当前账号只能查看：${data.bindBlockedReason}`} /> : null}
      <SimpleGrid<AdsAccountBindingRow>
        gridId="connections.ads-binding-section"
        columns={data ? columns(data, refresh) : []}
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isPending}
        error={query.error}
        onRetry={refresh}
        emptyState={{ kind: 'empty', domain: '广告账户', prerequisite: '尚无广告账户记录；完成广告授权并同步广告账户后显示。' }}
      />
      {data?.truncated ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="只列出前面的广告账户；其余请缩小范围后查看。" /> : null}
    </Card>
  )
}
