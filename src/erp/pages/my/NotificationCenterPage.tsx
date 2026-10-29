import { useEffect, useState } from 'react'
import { Badge, Button, Segmented, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { NOTIFY_DOMAINS, NOTIFY_DOMAIN_LABEL, type NotifyDomain } from '@nova/api-contracts'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ActionGuard, PageHeader, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'

// 通知中心（P1-28-4，P5-11 增加业务域与免打扰筛选）：站内通知的完整列表。
// - 通知由后台任务（待办升级、预警、汇率获取失败、导出完成、开关被自动关闭等）按权限推送给相关成员；
// - 点击一条会先标记已读，再跳到它指向的页面；“全部已读”只影响当前账号；
// - 免打扰期间收到的通知在这里带“免打扰期间”标记，不计入未读数；免打扰结束后的汇总通知链接到 ?silenced=true（可带 domain）；
// - 读取与标记失败时如实提示，不会假装已读。

type Notice = {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  read: boolean
  createdAt: string
  domain: string | null
  silenced: boolean
}
type Page = { items: Notice[]; pageInfo: { nextCursor: string | null; hasMore: boolean }; unreadCount: number }
type View = 'all' | 'unread' | 'silenced'

const SEVERITY: Record<Notice['severity'], [string, string]> = { INFO: ['提示', 'default'], WARNING: ['警告', 'warning'], CRITICAL: ['严重', 'error'] }
const DOMAIN_OPTIONS = [{ value: '', label: '全部业务域' }, ...NOTIFY_DOMAINS.map(value => ({ value, label: NOTIFY_DOMAIN_LABEL[value] })), { value: 'OTHER', label: '其他' }]
const domainText = (domain: string | null) => (domain && (NOTIFY_DOMAINS as readonly string[]).includes(domain) ? NOTIFY_DOMAIN_LABEL[domain as NotifyDomain] : '其他')
const domainOf = (value: unknown) => (typeof value === 'string' && (value === 'OTHER' || (NOTIFY_DOMAINS as readonly string[]).includes(value)) ? value : '')

export default function NotificationCenterPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { silenced?: string; domain?: string }
  const [view, setView] = useState<View>(search.silenced === 'true' ? 'silenced' : 'all')
  const [domain, setDomain] = useState(domainOf(search.domain))
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors[cursors.length - 1]
  // 已经在本页时点汇总通知，地址栏参数变了，筛选要跟着变
  useEffect(() => {
    setView(search.silenced === 'true' ? 'silenced' : 'all')
    setDomain(domainOf(search.domain))
    setCursors([])
  }, [search.silenced, search.domain])
  const query = useApiQuery<Page>({
    domain: 'realtime',
    path: '/notifications',
    scoped: false,
    params: { unread: view === 'unread' ? 'true' : undefined, silenced: view === 'silenced' ? 'true' : undefined, domain: domain || undefined, cursor, limit: 30 },
  })
  const markRead = useApiMutation<{ ids?: string[]; all?: true }, unknown>({ method: 'POST', path: '/notifications/read', body: v => v, invalidate: ['realtime'], silent: true })
  const unread = query.data?.unreadCount ?? 0

  const open = async (item: Notice) => {
    if (!item.read) await markRead.mutateAsync({ ids: [item.id] }).catch(() => undefined)
    if (item.link?.startsWith('/')) {
      // 汇总通知的链接带筛选参数（?silenced=true&domain=…）：拆成路径与参数再跳转
      const [path, rawSearch] = item.link.split('?')
      void navigate({ to: path, search: Object.fromEntries(new URLSearchParams(rawSearch ?? '')) as never })
    }
  }

  const columns: ColumnsType<Notice> = [
    {
      title: '通知',
      key: 'title',
      render: (_, item) => (
        <div>
          <Badge dot={!item.read && !item.silenced} offset={[4, 0]}>
            <Typography.Link onClick={() => void open(item)} style={{ fontWeight: item.read ? 400 : 600 }}>
              {item.title}
            </Typography.Link>
          </Badge>
          {item.silenced ? (
            <Tag style={{ marginInlineStart: 8 }} data-testid="silenced-tag">
              免打扰期间
            </Tag>
          ) : null}
          {item.body ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{item.body}</div> : null}
        </div>
      ),
    },
    { title: '业务域', dataIndex: 'domain', width: 110, render: (value: string | null) => domainText(value) },
    { title: '级别', dataIndex: 'severity', width: 80, render: (value: Notice['severity']) => <Tag color={SEVERITY[value][1]}>{SEVERITY[value][0]}</Tag> },
    { title: '时间', dataIndex: 'createdAt', width: 170, render: (value: string) => formatDateTime(value) },
    { title: '状态', dataIndex: 'read', width: 80, render: (value: boolean) => (value ? '已读' : '未读') },
  ]

  const actions = (
    <ActionGuard label="全部标为已读" guard={{ condition: { ok: unread > 0, reason: '没有未读通知' } }} onExecute={() => markRead.mutateAsync({ all: true })} onDone={() => setCursors([])} />
  )

  const emptyText = view === 'unread' ? '没有未读通知' : view === 'silenced' ? '没有免打扰期间的通知' : '还没有通知'

  return (
    <div>
      <PageHeader title="通知中心" description="系统推送给你的通知。只会收到你有权限处理的内容。" actions={actions} />
      <Space wrap style={{ margin: '8px 0 12px' }}>
        <Segmented
          value={view}
          onChange={value => {
            setView(value as View)
            setCursors([])
          }}
          options={[
            { value: 'all', label: '全部' },
            { value: 'unread', label: `未读${unread ? `（${unread}）` : ''}` },
            { value: 'silenced', label: '免打扰期间' },
          ]}
        />
        <Select
          aria-label="业务域"
          value={domain}
          style={{ width: 140 }}
          options={DOMAIN_OPTIONS}
          onChange={value => {
            setDomain(value)
            setCursors([])
          }}
        />
        <AppLink to="/app/profile" search={{ tab: 'notify' }}>
          <Typography.Link>通知偏好与免打扰设置</Typography.Link>
        </AppLink>
      </Space>
      <SimpleGrid<Notice>
        gridId="my.notification-center-page"
        columns={columns}
        rows={query.data?.items}
        rowKey={item => item.id}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: emptyText, prerequisite: '待办超时、汇率获取失败、导出完成等事件发生后会出现在这里。' }}
      />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={cursors.length === 0} onClick={() => setCursors(list => list.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!query.data?.pageInfo.hasMore || !query.data.pageInfo.nextCursor} onClick={() => setCursors(list => [...list, query.data?.pageInfo.nextCursor as string])}>
          下一页
        </Button>
      </Space>
    </div>
  )
}
