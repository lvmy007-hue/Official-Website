import type { ReactNode } from 'react'
import { Card, Space, Tag, Typography } from 'antd'
import type { EnterpriseSettingsResponse, SettingsEditor, SettingsUpdateResult } from '@nova/api-contracts'
import { DataState } from '../../components'
import { stateFromError } from '../../components/data-state/from-error'
import { formatDateTime } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'

// 企业设置的共用部件（P5-10）：每个配置项一张卡片——配置名、当前值、影响范围、编辑入口；
// 只读项不放编辑入口，并写明由谁或在哪里控制。

export const SETTINGS_PATH = '/settings'

export type ConfigCardProps = {
  name: string
  value: ReactNode
  impact: ReactNode
  /** 补充说明（取值范围、对已有数据的影响等）。 */
  note?: ReactNode
  /** 编辑入口（FormAction）；只读项不传。 */
  action?: ReactNode
  /** 只读项必填：由谁或在哪里控制。 */
  readonlyBy?: string
  id: string
}

export function ConfigCard({ id, name, value, impact, note, action, readonlyBy }: ConfigCardProps) {
  return (
    <Card size="small" title={name} extra={readonlyBy ? <Tag>只读</Tag> : null} data-testid={`config-${id}`} style={{ height: '100%' }}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <div>
          <Typography.Text type="secondary">当前值：</Typography.Text>
          <Typography.Text strong>{value}</Typography.Text>
        </div>
        <div>
          <Typography.Text type="secondary">影响范围：</Typography.Text>
          <Typography.Text>{impact}</Typography.Text>
        </div>
        {note ? <Typography.Text type="secondary">{note}</Typography.Text> : null}
        {readonlyBy ? <Typography.Text type="secondary">只读：{readonlyBy}</Typography.Text> : <div>{action}</div>}
      </Space>
    </Card>
  )
}

/** 卡片栅格：一行最多三张。 */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>{children}</div>
}

/** 最近一次修改的说明。 */
export function EditedNote({ editor }: { editor: SettingsEditor }) {
  if (!editor.updatedAt) return <Typography.Text type="secondary">还没有人修改过，现在用的是系统默认。</Typography.Text>
  return (
    <Typography.Text type="secondary">
      最近修改：{editor.updatedByName ?? '—'} · {formatDateTime(editor.updatedAt)}
    </Typography.Text>
  )
}

/** 读取企业设置总览；失败与加载中由这里统一处理。 */
export function SettingsLoader({ children }: { children: (data: EnterpriseSettingsResponse) => ReactNode }) {
  const query = useApiQuery<EnterpriseSettingsResponse>({ domain: 'config', path: SETTINGS_PATH, scoped: false })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'settings.read', onRetry: () => void query.refetch() })} />
  if (!query.data) return <DataState kind="skeleton" rows={5} />
  return <>{children(query.data)}</>
}

/** 提交修改：失败不弹统一提示（表单自己显示服务端给的原因）。 */
export function useSettingsPatch() {
  return useApiMutation<Record<string, unknown>, SettingsUpdateResult>({ method: 'PATCH', path: SETTINGS_PATH, invalidate: ['config'], silent: true })
}
