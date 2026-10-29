import { useState } from 'react'
import { Alert, App, Button, Card, Input, Space, Switch, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  NOTIFY_DOMAINS,
  NOTIFY_DOMAIN_HINT,
  NOTIFY_DOMAIN_LABEL,
  NOTIFY_SEVERITIES,
  NOTIFY_SEVERITY_LABEL,
  isClockTime,
  type NotifyDomain,
  type NotifyPrefs,
  type NotifySeverity,
  type PreferencesResponse,
} from '@nova/api-contracts'
import { DataState, SimpleGrid } from '../../components'
import { stateFromError } from '../../components/data-state/from-error'
import { formatDateTime } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'

// 通知偏好（09 章 9.15 第 4 块，CR-096）：按“业务域 × 严重级别”选择是否接收；个人免打扰时段按企业本地时区计算。
// 关掉的组合不会写入消息中心；免打扰期间的通知仍在消息中心里，只是不进入提醒，结束后合并成一条汇总。
// 严重级别通知与待办超时升级通知不受免打扰限制。保存带版本号，别处已改过会提示并刷新。

const PATH = '/me/preferences'

type Row = { domain: NotifyDomain }
type Saved = { version: number }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function Editor({ data, onConflict }: { data: PreferencesResponse; onConflict: () => void }) {
  const { message } = App.useApp()
  const [draft, setDraft] = useState<NotifyPrefs>(data.notify)
  const [failure, setFailure] = useState<string | null>(null)
  const save = useApiMutation<{ notify: NotifyPrefs; version: number }, Saved>({ method: 'PUT', path: PATH, invalidate: ['config'], silent: true })
  const dirty = !sameJson(draft, data.notify)
  const { dnd } = draft
  const timeError = dnd.enabled && (!isClockTime(dnd.start) || !isClockTime(dnd.end) || dnd.start === dnd.end) ? '开始与结束时间不能相同，请按 HH:MM 填写' : null

  const toggle = (domain: NotifyDomain, severity: NotifySeverity, value: boolean) =>
    setDraft(prev => ({ ...prev, domains: { ...prev.domains, [domain]: { ...prev.domains[domain], [severity]: value } } }))
  const setDnd = (patch: Partial<NotifyPrefs['dnd']>) => setDraft(prev => ({ ...prev, dnd: { ...prev.dnd, ...patch } }))

  const submit = async () => {
    setFailure(null)
    try {
      await save.mutateAsync({ notify: draft, version: data.version })
      message.success('通知偏好已保存')
    } catch (reason) {
      const info = describeError(reason)
      if (info.kind === 'conflict') onConflict()
      else setFailure(info.message)
    }
  }

  const columns: ColumnsType<Row> = [
    {
      title: '业务域',
      key: 'domain',
      render: (_, row) => (
        <div>
          <Typography.Text strong>{NOTIFY_DOMAIN_LABEL[row.domain]}</Typography.Text>
          <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{NOTIFY_DOMAIN_HINT[row.domain]}</div>
        </div>
      ),
    },
    ...NOTIFY_SEVERITIES.map(severity => ({
      title: NOTIFY_SEVERITY_LABEL[severity],
      key: severity,
      width: 90,
      align: 'center' as const,
      render: (_: unknown, row: Row) => (
        <Switch
          size="small"
          checked={draft.domains[row.domain][severity]}
          aria-label={`${NOTIFY_DOMAIN_LABEL[row.domain]}·${NOTIFY_SEVERITY_LABEL[severity]}`}
          onChange={value => toggle(row.domain, severity, value)}
        />
      ),
    })),
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" title="接收哪些通知">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          关掉的组合不会再出现在通知中心。严重级别通常意味着需要马上处理，关闭前请确认有别的渠道能及时发现。
        </Typography.Paragraph>
        <SimpleGrid<Row>
          gridId="profile.notify-prefs-tab"
          columns={columns}
          rows={NOTIFY_DOMAINS.map(domain => ({ domain }))}
          rowKey={row => row.domain}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      </Card>

      <Card size="small" title="免打扰时段">
        <Space direction="vertical" size={8}>
          <Space>
            <Switch checked={dnd.enabled} aria-label="开启免打扰" onChange={value => setDnd({ enabled: value })} />
            <span>{dnd.enabled ? '已开启' : '未开启'}</span>
          </Space>
          <Space wrap>
            <span>每天</span>
            <Input type="time" aria-label="免打扰开始时间" value={dnd.start} disabled={!dnd.enabled} onChange={event => setDnd({ start: event.target.value })} style={{ width: 120 }} />
            <span>到</span>
            <Input type="time" aria-label="免打扰结束时间" value={dnd.end} disabled={!dnd.enabled} onChange={event => setDnd({ end: event.target.value })} style={{ width: 120 }} />
            <span>（开始晚于结束表示跨过午夜）</span>
          </Space>
          {timeError ? <Typography.Text type="danger">{timeError}</Typography.Text> : null}
          <Typography.Text type="secondary">时段按企业本地时区（{data.zone}）计算，不是你电脑的时区。</Typography.Text>
          <Typography.Text type="secondary">
            免打扰期间收到的通知仍保存在通知中心，但不计入未读提醒，也不会逐条补发；时段结束后会发一条汇总，按业务域列出条数。严重级别通知与待办超时升级通知不受免打扰限制，照常提醒。
          </Typography.Text>
        </Space>
      </Card>

      {failure ? <Alert type="warning" showIcon message={failure} /> : null}
      <Space>
        <Button type="primary" loading={save.isPending} disabled={!dirty || Boolean(timeError)} onClick={() => void submit()}>
          保存
        </Button>
        <Button disabled={!dirty} onClick={() => setDraft(data.notify)}>
          放弃修改
        </Button>
        <Typography.Text type="secondary">{data.updatedAt ? `最近保存：${formatDateTime(data.updatedAt)}` : '还没有保存过，当前是默认设置：全部接收、免打扰关闭。'}</Typography.Text>
      </Space>
    </Space>
  )
}

export default function NotifyPrefsTab() {
  const query = useApiQuery<PreferencesResponse>({ domain: 'config', path: PATH, scoped: false })
  const [conflict, setConflict] = useState(false)
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (!query.data) return <DataState kind="skeleton" rows={5} />
  // 版本变了（保存成功或别处已改）就重建编辑器，草稿回到最新内容；冲突提示放在编辑器外面，重建后仍然保留
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {conflict ? <Alert type="warning" showIcon closable onClose={() => setConflict(false)} message="这份偏好已在别处被修改，已为你刷新为最新内容，请确认后重新修改。" /> : null}
      <Editor
        key={query.data.version}
        data={query.data}
        onConflict={() => {
          setConflict(true)
          void query.refetch()
        }}
      />
    </Space>
  )
}
