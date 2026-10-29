import { App, Button, Popconfirm, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'

// 会话管理（09 章 9.15 第 3 块，由 P1-17 的登录会话迁入）：列出自己在各设备上的登录，可以注销其中任何一个；只能操作自己的会话。
// 注销当前设备会回到登录页；成功提示只在服务端返回成功之后出现。

type SessionRow = { id: string; device: string; ipMasked: string | null; signedInAt: string; lastSeenAt: string; expiresAt: string; current: boolean }
type SessionList = { items: SessionRow[]; total: number }

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function SessionsPanel() {
  const { message } = App.useApp()
  const query = useApiQuery<SessionList>({ domain: 'session', path: '/auth/sessions', scoped: false, params: { pageSize: 50 } })
  const revoke = useApiMutation<SessionRow, unknown>({ method: 'DELETE', path: row => `/auth/sessions/${row.id}`, body: () => undefined, invalidate: ['session'], silent: true })

  const remove = async (row: SessionRow) => {
    try {
      await revoke.mutateAsync(row)
      message.success('已注销该登录')
      if (row.current) window.location.assign('/login')
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '注销失败，请稍后重试')
    }
  }

  const columns: ColumnsType<SessionRow> = [
    {
      title: '设备',
      dataIndex: 'device',
      render: (value: string, row) => (
        <Space size={6}>
          {value}
          {row.current ? (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              当前设备
            </Tag>
          ) : null}
        </Space>
      ),
    },
    { title: '登录地址', dataIndex: 'ipMasked', render: (value: string | null) => value ?? '—' },
    { title: '登录时间', dataIndex: 'signedInAt', render: (value: string) => formatDateTime(value, { timeZone: localZone() }) },
    { title: '最近活动', dataIndex: 'lastSeenAt', render: (value: string) => formatDateTime(value, { timeZone: localZone() }) },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_: unknown, row) => (
        <Popconfirm
          title={row.current ? '退出当前设备？' : '注销该设备上的登录？'}
          description={row.current ? '退出后需要重新登录。' : '该设备需要重新登录才能继续使用。'}
          okText="注销"
          cancelText="取消"
          onConfirm={() => remove(row)}
        >
          <Button type="link" size="small" danger>
            {row.current ? '退出' : '注销'}
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <SimpleGrid<SessionRow>
      gridId="profile.sessions-panel"
      columns={columns}
      rows={query.data?.items}
      rowKey={row => row.id}
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      emptyState={{ kind: 'empty', domain: '没有有效的登录会话', prerequisite: '登录后会在这里列出每台设备上的登录。' }}
    />
  )
}
