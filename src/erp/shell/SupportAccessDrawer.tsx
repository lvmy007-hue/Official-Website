import { useState } from 'react'
import { Alert, Button, Drawer, Form, Input, InputNumber, Popconfirm, Tag, Tooltip, message } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { SUPPORT_ACCESS_MAX_HOURS } from '@nova/api-contracts'
import { apiFetch } from '../../api'
import { DataState } from '../components/data-state/DataState'
import { stateFromError } from '../components/data-state/from-error'
import { formatDateTime } from '../format'
import { apiQueryKey, useApiQuery } from '../query/api-query'
import { describeError } from '../query/errors'
import { useSession } from '../session/session'
import { SimpleGrid } from '../components'

// 平台支持访问授权（P1-19，企业侧）：只有企业所有者能授权或撤销。授权必须写原因、限时（最长 7 天）、只读，
// 平台人员领取后每个请求都会记入审计，并在界面顶部显示“限时支持访问”横幅。授权要先再次验证身份（密码）。

type Grant = { id: string; reason: string; startsAt: string; expiresAt: string; claimedAt: string | null; revokedAt: string | null; status: 'AVAILABLE' | 'IN_USE' | 'REVOKED' | 'EXPIRED' }
const STATUS = { AVAILABLE: ['待平台领取', 'green'], IN_USE: ['支持中', 'blue'], REVOKED: ['已撤销', 'default'], EXPIRED: ['已过期', 'default'] } as const
const PATH = '/settings/support-access'

export function SupportAccessDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, canPermission } = useSession()
  const client = useQueryClient()
  const list = useApiQuery<Grant[]>({ domain: 'config', path: PATH, scoped: false, enabled: open, staleMs: 0 })
  const [form] = Form.useForm<{ hours: number; reason: string; password: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isOwner = me.permissions.includes('*')
  const refresh = () => client.invalidateQueries({ queryKey: apiQueryKey('config', PATH) })

  const grant = async (values: { hours: number; reason: string; password: string }) => {
    setBusy(true)
    setError(null)
    try {
      // 先再次验证身份（有效期 10 分钟，只对“授权支持访问”这一个操作有效），再提交授权
      await apiFetch('/auth/step-up', { method: 'POST', body: JSON.stringify({ action: 'support.access', method: 'PASSWORD', password: values.password }) })
      await apiFetch(PATH, { method: 'POST', body: JSON.stringify({ hours: values.hours, reason: values.reason }) })
      void message.success('已授权，平台支持人员可在授权期内领取')
      form.resetFields()
      await refresh()
    } catch (failure) {
      const info = describeError(failure)
      setError(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await apiFetch(`${PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      void message.success('授权已撤销，支持人员的会话立即失效')
      await refresh()
    } catch (failure) {
      void message.error(describeError(failure).message)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} width={620} title="平台支持访问授权" destroyOnClose>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="仅在需要平台人员协助排查时授权"
        description={`授权后平台支持人员可以只读查看本企业数据，最长 ${SUPPORT_ACCESS_MAX_HOURS} 小时；他们的每个请求都会记入审计，你可以随时撤销。`}
      />
      {!isOwner ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="只有企业所有者可以授权或撤销" />
      ) : (
        <Form form={form} layout="vertical" size="small" requiredMark={false} disabled={busy} onFinish={grant} initialValues={{ hours: 24 }} style={{ marginBottom: 16 }}>
          {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} /> : null}
          <Form.Item label="授权时长（小时）" name="hours" rules={[{ required: true, message: '请输入时长' }]}>
            <InputNumber min={1} max={SUPPORT_ACCESS_MAX_HOURS} precision={0} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            label="授权原因"
            name="reason"
            rules={[
              { required: true, message: '请填写原因' },
              { min: 5, message: '至少 5 个字' },
            ]}
          >
            <Input.TextArea rows={2} maxLength={500} showCount placeholder="例如：同步任务连续失败，需要平台协助排查" />
          </Form.Item>
          <Form.Item label="登录密码（再次验证身份）" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Tooltip title={canPermission('settings.write') ? undefined : '需要“企业设置·写入”权限'}>
            <Button type="primary" htmlType="submit" loading={busy}>
              授权支持访问
            </Button>
          </Tooltip>
        </Form>
      )}
      {list.isError ? (
        <DataState {...stateFromError(describeError(list.error), { permission: 'settings.read', onRetry: () => void list.refetch() })} />
      ) : list.isPending ? (
        <DataState kind="skeleton" rows={3} />
      ) : list.data.length === 0 ? (
        <DataState kind="empty" domain="授权记录" prerequisite="还没有授权过平台支持访问。" />
      ) : (
        <SimpleGrid<Grant>
          gridId="shell.support-access-drawer"
          columns={[
            { title: '原因', dataIndex: 'reason', ellipsis: true },
            { title: '到期', dataIndex: 'expiresAt', width: 150, render: (value: string) => formatDateTime(value) },
            { title: '状态', dataIndex: 'status', width: 100, render: (status: Grant['status']) => <Tag color={STATUS[status][1]}>{STATUS[status][0]}</Tag> },
            {
              title: '操作',
              key: 'actions',
              width: 80,
              render: (_, row) =>
                (row.status === 'AVAILABLE' || row.status === 'IN_USE') && isOwner ? (
                  <Popconfirm title="撤销这条授权？" description="支持人员的会话会立即失效。" okText="撤销" cancelText="取消" onConfirm={() => void revoke(row.id)}>
                    <Button type="link" size="small" danger>
                      撤销
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
          rows={list.data}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      )}
    </Drawer>
  )
}
