import { useState } from 'react'
import { Alert, Button, Form, Input, Modal, Tag } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SUPPORT_TOKEN_MINUTES } from '@nova/api-contracts'
import { DataState } from '../components/data-state/DataState'
import { stateFromError } from '../components/data-state/from-error'
import { PageHeader } from '../components/page/PageHeader'
import { formatDateTime } from '../format'
import { describeError } from '../query/errors'
import { SUPPORT_HANDOVER_KEY } from '../../api'
import { platformPost } from './platform-api'
import { supportAccessQuery, type SupportAccessItem } from './platform-queries'
import { SimpleGrid } from '../components'

// 限时支持访问（P1-19）：只列出企业所有者已授权、且仍在有效期内的授权。领取需要再次输入动态验证码；
// 领取后签发 15 分钟的只读会话令牌，在新标签页打开该企业的工作区（顶部有“限时支持访问”横幅），逐请求审计，企业可随时撤销。

type Claimed = { accessToken: string; expiresAt: string; grantExpiresAt: string; tenant: { id: string; name: string } }

export function PlatformSupportAccessPage() {
  const client = useQueryClient()
  const list = useQuery(supportAccessQuery)
  const [target, setTarget] = useState<SupportAccessItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [form] = Form.useForm<{ code: string }>()

  const claim = async (values: { code: string }) => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const result = await platformPost<Claimed>('/platform/support-access', { accessId: target.id, code: values.code.trim() })
      // 交接：令牌只经 sessionStorage 传给新标签页（读取后立即清除），不写 URL、不落 localStorage
      sessionStorage.setItem(SUPPORT_HANDOVER_KEY, JSON.stringify({ token: result.accessToken, expiresAt: result.expiresAt }))
      window.open('/app/overview', '_blank')
      window.setTimeout(() => sessionStorage.removeItem(SUPPORT_HANDOVER_KEY), 1000)
      form.resetFields()
      setTarget(null)
      await client.invalidateQueries({ queryKey: ['platform', 'support-access'] })
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title="支持访问" description={`企业所有者授权后，才能在这里领取。领取后会话 ${SUPPORT_TOKEN_MINUTES} 分钟有效、只读，每个请求都会记入企业的审计。`} />
      {list.isError ? (
        <DataState {...stateFromError(describeError(list.error), { permission: 'platform.support.access', onRetry: () => void list.refetch() })} />
      ) : list.isPending ? (
        <DataState kind="skeleton" rows={4} />
      ) : list.data.items.length === 0 ? (
        <DataState kind="empty" domain="支持访问授权" prerequisite="目前没有企业授权支持访问。企业所有者可在“企业设置 → 支持访问授权”里限时授权。" />
      ) : (
        <SimpleGrid<SupportAccessItem>
          gridId="platform.platform-support-access-page"
          columns={[
            {
              title: '企业',
              key: 'tenant',
              render: (_, row) => (
                <span>
                  {row.tenant.name}
                  <span style={{ marginLeft: 8, color: 'var(--ant-color-text-tertiary)' }}>{row.tenant.slug}</span>
                </span>
              ),
            },
            { title: '授权原因', dataIndex: 'reason', ellipsis: true },
            { title: '授权到期', dataIndex: 'expiresAt', width: 170, render: (value: string) => formatDateTime(value) },
            { title: '状态', dataIndex: 'claimedByMe', width: 90, render: (mine: boolean) => (mine ? <Tag color="blue">我已领取</Tag> : <Tag color="green">待领取</Tag>) },
            {
              title: '操作',
              key: 'actions',
              width: 150,
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    setError(null)
                    setTarget(row)
                  }}
                >
                  {row.claimedByMe ? '重新打开' : '领取并打开'}
                </Button>
              ),
            },
          ]}
          rows={list.data.items}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      )}
      <Modal
        open={Boolean(target)}
        title={`进入 ${target?.tenant.name ?? ''} 的工作区`}
        okText="验证并打开"
        cancelText="取消"
        onCancel={() => setTarget(null)}
        onOk={() => form.submit()}
        confirmLoading={busy}
        maskClosable={false}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="需要再次验证身份"
          description={`授权原因：${target?.reason ?? ''}。验证通过后在新标签页打开只读工作区，${SUPPORT_TOKEN_MINUTES} 分钟后需要重新验证。`}
        />
        {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error.message} description={error.requestId ? `请求编号：${error.requestId}` : undefined} /> : null}
        <Form form={form} layout="vertical" onFinish={claim} requiredMark={false} disabled={busy} preserve={false}>
          <Form.Item
            label="动态验证码"
            name="code"
            rules={[
              { required: true, message: '请输入验证码' },
              { pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' },
            ]}
            extra="同一个验证码只能用一次；如刚用过，请等待验证器刷新。"
          >
            <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
