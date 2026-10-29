import { useMemo, useState } from 'react'
import { Alert, Button, Input, Select, Space, Typography } from 'antd'
import { SUBSCRIPTION_STATES, SUBSCRIPTION_STATE_LABEL, type SubscriptionCenterResponse, type SubscriptionItem } from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { subscriptionColumns } from './subscription-columns'

// 消息推送订阅（P5-05，09 章 9.7）：每个店铺 × 每种推送类型一行，显示订阅状态、过滤条件、目的地、最近收到时间、近 24 小时事件数与失败数；
// 动作是订阅、取消订阅、修改过滤条件、重放失败事件。接收端（部署专项）没建好时，正式显示“接收端未接入”、所需配置与受影响的页面。
// 订阅属于企业设置，不跟全局范围栏走；谁能看到哪些店铺由服务端按数据范围决定。

const POLL_MS = 5000
const POLL_WINDOW_MS = 60_000
const ALL = 'ALL'
const SUBSCRIBED = 'SUBSCRIBED'

function DestinationNotice({ data }: { data: SubscriptionCenterResponse }) {
  const { destination } = data
  if (destination.configured) {
    return <Alert type="info" showIcon style={{ marginTop: 12 }} data-testid="destination-alert" message={`推送接收端已配置（${destination.hint ?? '已隐藏'}）`} />
  }
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      data-testid="destination-alert"
      message="推送接收端尚未接入（部署专项）"
      description={
        <div>
          <p style={{ margin: '0 0 4px' }}>接收端建成之前不能创建订阅，也不会创建任何记录。所需配置：</p>
          <ol style={{ margin: '0 0 8px', paddingLeft: 20 }}>
            {destination.setupSteps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p style={{ margin: '0 0 4px' }}>受影响的页面：</p>
          <ul style={{ margin: '0 0 8px', paddingLeft: 20 }} data-testid="affected-pages">
            {data.affectedPages.map(item => (
              <li key={item.page}>
                {item.page}（{item.types.join('、')}）
              </li>
            ))}
          </ul>
          <p style={{ margin: 0 }}>{destination.fallbackNote}</p>
        </div>
      }
    />
  )
}

function Summary({ data }: { data: SubscriptionCenterResponse }) {
  const { summary } = data
  return (
    <p style={{ margin: '12px 0 0' }} data-testid="subscriptions-summary">
      已订阅 <span className="erp-num">{summary.active}</span>，处理中 <span className="erp-num">{summary.pending}</span>，已失效 <span className="erp-num">{summary.invalid}</span>
      {data.destination.configured || summary.events24h > 0 ? (
        <>
          ；近 24 小时收到 <span className="erp-num">{summary.events24h}</span> 条事件，失败 <span className="erp-num">{summary.failures24h}</span> 条
        </>
      ) : (
        '；接收端接入后才会有事件'
      )}
    </p>
  )
}

const matches = (row: SubscriptionItem, store: string, status: string, keyword: string) => {
  if (store !== ALL && row.sellerAccountId !== store) return false
  if (status === SUBSCRIBED ? !row.id : status !== ALL && row.state !== status) return false
  const text = keyword.trim().toLowerCase()
  return !text || row.label.toLowerCase().includes(text) || row.notificationType.toLowerCase().includes(text) || row.pages.some(page => page.includes(text))
}

export default function NotificationSubscriptionsPage() {
  const [pollUntil, setPollUntil] = useState(0)
  const [store, setStore] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [keyword, setKeyword] = useState('')
  // 创建、重建与取消都是后台任务：操作后一分钟内每几秒取一次，状态变化自动显示
  const query = useApiQuery<SubscriptionCenterResponse>({
    domain: 'reference',
    path: '/notifications/subscriptions',
    scoped: false,
    refetchIntervalMs: () => (Date.now() < pollUntil ? POLL_MS : false),
  })
  const data = query.data
  const refresh = () => void query.refetch()
  const done = (poll?: boolean) => {
    if (poll) setPollUntil(Date.now() + POLL_WINDOW_MS)
    refresh()
  }
  const rows = useMemo(() => data?.items.filter(row => matches(row, store, status, keyword)), [data, store, status, keyword])
  const filtered = store !== ALL || status !== ALL || keyword.trim() !== ''
  const reset =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
    }
  return (
    <div data-testid="subscriptions-page">
      <PageHeader
        title="消息推送订阅"
        description="亚马逊卖家接口的消息推送订阅：订阅、取消订阅、修改过滤条件、重放失败事件；每次操作都会留审计记录。"
        actions={
          <Button onClick={refresh} loading={query.isFetching}>
            刷新
          </Button>
        }
      />
      {data ? <DestinationNotice data={data} /> : null}
      {data ? <Summary data={data} /> : null}
      {data && !data.canManage ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="当前账号只能查看；订阅管理需要“消息推送订阅管理”权限。" /> : null}
      <Space wrap style={{ margin: '12px 0' }}>
        <Select
          aria-label="订阅店铺"
          style={{ width: 200 }}
          value={store}
          onChange={reset(setStore)}
          options={[{ value: ALL, label: '全部店铺' }, ...(data?.stores ?? []).map(item => ({ value: item.id, label: item.displayName }))]}
        />
        <Select
          aria-label="订阅状态"
          style={{ width: 170 }}
          value={status}
          onChange={reset(setStatus)}
          options={[{ value: ALL, label: '全部状态' }, { value: SUBSCRIBED, label: '已有订阅记录' }, ...SUBSCRIPTION_STATES.map(value => ({ value, label: SUBSCRIPTION_STATE_LABEL[value] }))]}
        />
        <Input aria-label="搜索推送类型" allowClear style={{ width: 240 }} placeholder="搜索推送类型或页面" value={keyword} onChange={event => reset(setKeyword)(event.target.value)} />
        {data?.truncated ? <Typography.Text type="secondary">只列出前面的店铺；其余请联系管理员按店铺缩小范围后查看。</Typography.Text> : null}
      </Space>
      <SimpleGrid<SubscriptionItem>
        columns={subscriptionColumns(done, store === ALL)}
        gridId="connections.subscriptions"
        rows={rows}
        resetKey={JSON.stringify([store, status, keyword])}
        rowKey={row => `${row.sellerAccountId}|${row.notificationType}`}
        loading={query.isPending}
        error={query.error}
        onRetry={refresh}
        emptyState={{
          kind: 'empty',
          domain: '推送订阅',
          prerequisite: filtered ? '没有符合筛选条件的订阅，调整店铺、状态或关键字再试。' : '还没有店铺；先到连接中心授权卖家接口，再回来订阅。',
        }}
      />
      {data && data.stores.some(item => !item.authorized) ? (
        <p style={{ marginTop: 8 }}>
          没有有效授权的店铺不能订阅需要卖家授权的类型，请到{' '}
          <AppLink to="/app/connections">
            <Typography.Link>连接中心</Typography.Link>
          </AppLink>
          授权。
        </p>
      ) : null}
    </div>
  )
}
