import type { ReactNode } from 'react'
import { Card, Space, Tag, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { ME_QUERY_KEY } from '../../session/session'

// 个人账号的共用部件（P5-11）：信息卡片与“刷新当前登录人信息”。

export const PROFILE_PERMISSION = 'profile.manage'

/** 个人信息变化（显示名、多因素认证状态）后，让外壳重新读取当前登录人。 */
export function useRefreshMe() {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: ME_QUERY_KEY })
}

export function InfoCard({ id, name, value, note, action, readonlyBy }: { id: string; name: string; value: ReactNode; note?: ReactNode; action?: ReactNode; readonlyBy?: string }) {
  return (
    <Card size="small" title={name} extra={readonlyBy ? <Tag>只读</Tag> : null} data-testid={`profile-${id}`} style={{ height: '100%' }}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Typography.Text strong>{value}</Typography.Text>
        {note ? <Typography.Text type="secondary">{note}</Typography.Text> : null}
        {readonlyBy ? <Typography.Text type="secondary">只读：{readonlyBy}</Typography.Text> : <div>{action}</div>}
      </Space>
    </Card>
  )
}

export function CardRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>{children}</div>
}
