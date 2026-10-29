import { Badge, Button, Spin, Tabs, Tag, Typography } from 'antd'
import type { AlertListResponse } from '@nova/api-contracts'
import { useApiMutation, useApiQuery } from '../query/api-query'
import { describeError } from '../query/errors'
import { formatDateTime } from '../format'
import { useAppNavigate } from '../nav/AppLink'
import { specByComponent } from '../routes/manifest'
import { safeRedirectPath } from '../security/safe-url'
import { useSession } from '../session/session'

// 顶栏消息与预警浮层的内容（P6-01，15 章第 11 节）：“消息 / 预警”两个页签各带未读数；底部有“全部”和“设置”入口。
// 每个页签只取最近 5 条（一次请求，不逐条查）；浮层打开时才取数。预警页签显示“待处理”的最近预警，
// 未读的带蓝点；未读数是按人记录的已读状态（P6-15）：接口给 null 表示暂时读不到，不显示数字，不当作 0。

const PAGE_SIZE = 5

type NoticeItem = { id: string; kind: string; title: string; body: string; link: string | null; severity: string; read: boolean; silenced: boolean; createdAt: string }
type NoticeList = { items: NoticeItem[] }

const SEVERITY: Record<string, { text: string; color: string }> = { CRITICAL: { text: '严重', color: 'error' }, WARNING: { text: '警告', color: 'warning' }, INFO: { text: '提示', color: 'default' } }

export type NoticePanelProps = {
  showMessages: boolean
  showAlerts: boolean
  messageUnread: number | undefined
  alertUnread: number | null
  onClose: () => void
}

function Failure({ error }: { error: unknown }) {
  return <Typography.Text type="secondary">{describeError(error).message}</Typography.Text>
}

function MessagesTab({ onClose }: { onClose: () => void }) {
  const navigate = useAppNavigate()
  const query = useApiQuery<NoticeList>({ domain: 'realtime', path: '/notifications', params: { limit: PAGE_SIZE }, scoped: false })
  const markRead = useApiMutation<{ ids: string[] } | { all: true }>({ method: 'POST', path: '/notifications/read', invalidate: ['realtime'], silent: true })
  const center = specByComponent.get('NotificationCenterPage')
  const profile = specByComponent.get('ProfilePage')
  const open = (item: NoticeItem) => {
    if (!item.read) markRead.mutate({ ids: [item.id] })
    // 通知里的链接来自服务端，只放行工作台内部路径
    const target = safeRedirectPath(item.link, center?.path ?? '/app')
    onClose()
    navigate(target, undefined, false)
  }
  const unreadOnPage = query.data?.items.some(item => !item.read) ?? false
  return (
    <div>
      {query.isPending ? <Spin size="small" /> : null}
      {query.isError ? <Failure error={query.error} /> : null}
      {query.data && query.data.items.length === 0 ? <Typography.Text type="secondary">尚无消息记录</Typography.Text> : null}
      {query.data?.items.map(item => (
        <button key={item.id} type="button" className="erp-notice-item" onClick={() => open(item)}>
          <span className="erp-notice-title" data-unread={!item.read}>
            {item.read ? null : <Badge status="processing" aria-label="未读" />}
            <Typography.Text ellipsis>{item.title}</Typography.Text>
            {item.severity !== 'INFO' ? (
              <Tag bordered={false} color={SEVERITY[item.severity]?.color ?? 'default'}>
                {SEVERITY[item.severity]?.text ?? item.severity}
              </Tag>
            ) : null}
          </span>
          <div className="erp-notice-meta">{formatDateTime(item.createdAt)}</div>
        </button>
      ))}
      <div className="erp-notice-foot">
        <Button type="link" size="small" disabled={!center} onClick={() => center && (onClose(), navigate(center.path, undefined, false))}>
          全部
        </Button>
        <Button type="link" size="small" disabled={!unreadOnPage || markRead.isPending} onClick={() => markRead.mutate({ all: true })}>
          全部标为已读
        </Button>
        <Button type="link" size="small" disabled={!profile} onClick={() => profile && (onClose(), navigate(profile.path, { tab: 'notify' }, false))}>
          通知设置
        </Button>
      </div>
    </div>
  )
}

function AlertsTab({ alertUnread, onClose }: { alertUnread: number | null; onClose: () => void }) {
  const navigate = useAppNavigate()
  const { can } = useSession()
  const query = useApiQuery<AlertListResponse>({ domain: 'realtime', path: '/alerts', params: { pageSize: PAGE_SIZE, view: 'open' }, scoped: false })
  const list = specByComponent.get('AlertsPage')
  const rules = specByComponent.get('AlertRulesPage')
  const canRules = Boolean(rules && can(rules.access))
  return (
    <div>
      {alertUnread === null ? <Typography.Paragraph type="secondary">暂时读不到预警的未读数，这里列出最近的待处理预警。</Typography.Paragraph> : null}
      {query.isPending ? <Spin size="small" /> : null}
      {query.isError ? <Failure error={query.error} /> : null}
      {query.data && query.data.items.length === 0 ? <Typography.Text type="secondary">{query.data.note ?? '尚无待处理的预警'}</Typography.Text> : null}
      {query.data?.items.map(item => (
        <button
          key={item.id}
          type="button"
          className="erp-notice-item"
          onClick={() => {
            onClose()
            navigate(`/app/alerts/${encodeURIComponent(item.id)}`, undefined, false)
          }}
        >
          <span className="erp-notice-title" data-unread={!item.read}>
            {item.read ? null : <Badge status="processing" aria-label="未读" />}
            <Tag bordered={false} color={SEVERITY[item.severity]?.color ?? 'default'}>
              {SEVERITY[item.severity]?.text ?? item.severity}
            </Tag>
            <Typography.Text ellipsis>{item.title}</Typography.Text>
          </span>
          <div className="erp-notice-meta">
            {item.storeName ? `${item.storeName} · ` : ''}
            {formatDateTime(item.lastTriggeredAt)}
          </div>
        </button>
      ))}
      <div className="erp-notice-foot">
        <Button type="link" size="small" disabled={!list} onClick={() => list && (onClose(), navigate(list.path, undefined, false))}>
          全部{query.data ? `（待处理 ${query.data.counts.open}）` : ''}
        </Button>
        {rules && canRules ? (
          <Button type="link" size="small" onClick={() => (onClose(), navigate(rules.path, undefined, false))}>
            设置
          </Button>
        ) : (
          <span />
        )}
      </div>
    </div>
  )
}

export function NoticePanel({ showMessages, showAlerts, messageUnread, alertUnread, onClose }: NoticePanelProps) {
  const items = [
    ...(showMessages
      ? [
          {
            key: 'messages',
            label: (
              <Badge count={messageUnread ?? 0} size="small" offset={[10, -2]}>
                消息
              </Badge>
            ),
            children: <MessagesTab onClose={onClose} />,
          },
        ]
      : []),
    ...(showAlerts
      ? [
          {
            key: 'alerts',
            label: (
              <Badge count={alertUnread ?? 0} size="small" offset={[10, -2]}>
                预警
              </Badge>
            ),
            children: <AlertsTab alertUnread={alertUnread} onClose={onClose} />,
          },
        ]
      : []),
  ]
  return (
    <div className="erp-notice-panel" data-testid="notice-panel">
      <Tabs size="small" items={items} destroyInactiveTabPane />
    </div>
  )
}
